import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundBlockedError, backgroundBlockerOf } from "@app/domain";

import { AiService } from "./ai-service.js";

// F4 D7 at the AI service: a job's call whose routed local model is installed but still arriving
// (downloading, verifying) is held as a `download` blocker instead of reading "no model"; a call
// with no model routed at all, a call outside a job and a ranker call keep reading null.

const state = vi.hoisted(() => ({
  installStatus: null as string | null,
  statusReads: [] as unknown[][]
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => ({
    getDefaultTask: async () => null,
    getRoutedLocalModelStatus: async (...args: unknown[]) => {
      state.statusReads.push(args);
      return state.installStatus;
    },
    recordTaskRun: vi.fn()
  }),
  createLocalModelRepository: () => ({ findById: async () => null })
}));

function service() {
  const onDownloadBlock = vi.fn();
  const ai = new AiService({
    userDataPath: "/tmp/ai-download-block-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    onDownloadBlock
  });
  // Route seeding and the legacy mapping write the configuration; the routes here are fixed.
  const internals = ai as unknown as {
    seedTaskRoutes: () => Promise<string[]>;
    ensureLegacyRouteMapping: () => Promise<void>;
  };
  vi.spyOn(internals, "seedTaskRoutes").mockResolvedValue([]);
  vi.spyOn(internals, "ensureLegacyRouteMapping").mockResolvedValue();
  return { ai, onDownloadBlock };
}

beforeEach(() => {
  state.installStatus = null;
  state.statusReads = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a job's call whose routed local model is still arriving (F4 D7)", () => {
  it("holds the call as a download blocker and tells its job", async () => {
    state.installStatus = "verifying";
    const { ai, onDownloadBlock } = service();
    const call = ai.runDefaultTask("embedding", "a predicate", {
      jobId: "stage-1",
      workloadClass: "embed",
      budgetClass: "user"
    });
    const error = await call.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackgroundBlockedError);
    expect(backgroundBlockerOf(error)).toEqual({ class: "download", reason: "model_verifying" });
    expect(onDownloadBlock).toHaveBeenCalledWith("stage-1", {
      class: "download",
      reason: "model_verifying"
    });
    // The install state is read for the same task and route keys the route was looked up with.
    expect(state.statusReads[0]?.[0]).toBe("embedding");
    expect(state.statusReads[0]?.[2]).toEqual(expect.arrayContaining(["embedding"]));
  });

  it("holds a downloading model's call the same way", async () => {
    state.installStatus = "downloading";
    const { ai } = service();
    await expect(
      ai.runDefaultTask("summarization", "a source", { jobId: "job-2" })
    ).rejects.toMatchObject({ blocker: { class: "download", reason: "model_downloading" } });
  });

  it("keeps reading no model when nothing is routed or the model is not arriving", async () => {
    const { ai, onDownloadBlock } = service();
    for (const status of [null, "failed", "not_downloaded", "removing"]) {
      state.installStatus = status;
      await expect(ai.runDefaultTask("embedding", "text", { jobId: "job-3" })).resolves.toBeNull();
    }
    expect(onDownloadBlock).not.toHaveBeenCalled();
  });

  it("keeps a call outside a job, and a ranker call, as they were", async () => {
    state.installStatus = "verifying";
    const { ai } = service();
    await expect(ai.runDefaultTask("embedding", "a question")).resolves.toBeNull();
    await expect(ai.runDefaultTask("reranking", "pairs", { jobId: "job-4" })).resolves.toBeNull();
    expect(state.statusReads).toEqual([]);
  });
});

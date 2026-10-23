import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { aiTaskRequestSchema } from "@app/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wiring of the real writer, with the MLX helper host replaced by a fake that speaks like the real
 * one: a `health`, a streamed `generate`, a pid and capabilities. No helper starts and no model loads.
 */
const state = vi.hoisted(() => ({
  hosts: [] as Array<{
    options: { helperPath: string; config?: unknown };
    capabilities: Set<string>;
    generated: Array<{ modelPath: string; prompt: string; parameters: Record<string, unknown> }>;
    disposed: boolean;
  }>,
  capabilities: ["cancel", "stream", "unload"]
}));

vi.mock("@app/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/ai")>();
  class FakeHost {
    public readonly pid = 777;
    public readonly capabilities = new Set(state.capabilities);
    public readonly generated: Array<{
      modelPath: string;
      prompt: string;
      parameters: Record<string, unknown>;
    }> = [];
    public disposed = false;

    public constructor(public readonly options: { helperPath: string; config?: unknown }) {
      state.hosts.push(this);
    }

    public async health(): Promise<void> {}

    public loadedModel(): string | undefined {
      return undefined;
    }

    public async generate(
      input: { modelPath: string; prompt: string; parameters: Record<string, unknown> },
      options: { onDelta?: (text: string) => void }
    ) {
      this.generated.push(input);
      options.onDelta?.('{"notes"');
      options.onDelta?.(":[]}");
      return {
        protocolVersion: 1,
        requestId: "00000000-0000-4000-8000-000000000001",
        kind: "result",
        ok: true,
        output: '{"notes":[]}',
        inputTokens: 12,
        outputTokens: 6,
        durationMs: 250
      };
    }

    public async dispose(): Promise<void> {
      this.disposed = true;
    }
  }
  return { ...actual, MlxHelperHost: FakeHost };
});

const { arms, customArm } = await import("./replay-arms.ts");
const { openRealWriter } = await import("./writer-replay.ts");

let directory: string;
let helper: string;
beforeEach(async () => {
  state.hosts.length = 0;
  state.capabilities = ["cancel", "stream", "unload"];
  directory = await mkdtemp(join(tmpdir(), "bench-real-"));
  helper = join(directory, "memora-mlx-helper");
  await writeFile(helper, "not a real helper");
  await writeFile(join(directory, "mlx.metallib"), "not a real library");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const request = () =>
  aiTaskRequestSchema.parse({
    taskType: "atomic-note-generation",
    input: "Write notes.",
    parameters: { maxTokens: 100, temperature: 0.2 }
  });

describe("the MLX writer", () => {
  it("checks the helper, records its hash and capabilities, and streams the answer", async () => {
    const writer = await openRealWriter(arms.m9b4!, "/models/m9b4", helper);
    const host = state.hosts[0]!;
    expect(host.options).toMatchObject({ helperPath: helper, config: { cancelGraceMs: 2_000 } });
    expect(writer.helperSha256).toBe(
      createHash("sha256").update("not a real helper").digest("hex")
    );
    expect(writer.capabilities.sort()).toEqual(["cancel", "stream", "unload"]);
    expect(writer.helperPid()).toBe(777);
    expect(writer.supportsSchema()).toBe(false);

    const deltas: string[] = [];
    const result = await writer.call(request(), (delta) => deltas.push(delta));
    expect(deltas).toEqual(['{"notes"', ":[]}"]);
    expect(result).toMatchObject({
      output: '{"notes":[]}',
      inputTokens: 12,
      outputTokens: 6,
      runtime: "local"
    });
    expect(host.generated[0]).toMatchObject({
      modelPath: "/models/m9b4",
      prompt: "Write notes.",
      parameters: { maxTokens: 100, temperature: 0.2 }
    });
    await writer.dispose();
    expect(host.disposed).toBe(true);
  });

  it("says a runtime takes a schema only when the helper announces it", async () => {
    state.capabilities = ["cancel", "schema"];
    const writer = await openRealWriter(arms.m4b!, "/models/m4b", helper);
    expect(writer.supportsSchema()).toBe(true);
  });

  it("needs a helper that exists", async () => {
    await expect(openRealWriter(arms.m9b4!, "/models/m9b4", null)).rejects.toThrow(
      /--helper-path/u
    );
    await expect(
      openRealWriter(arms.m9b4!, "/models/m9b4", join(directory, "missing"))
    ).rejects.toThrow();
    await rm(join(directory, "mlx.metallib"));
    await expect(openRealWriter(arms.m9b4!, "/models/m9b4", helper)).rejects.toThrow(
      /mlx\.metallib/u
    );
    expect(state.hosts).toHaveLength(0);
  });
});

describe("the GGUF writer", () => {
  it("runs in this process, takes a grammar and loads nothing until it is asked", async () => {
    const arm = customArm({ label: "gguf", runtime: "gguf", modelDir: "/models/x.gguf" });
    const writer = await openRealWriter(arm, "/models/x.gguf", null);
    expect(writer.helperPid()).toBe(process.pid);
    expect(writer.supportsSchema()).toBe(true);
    expect(writer.helperSha256).toBeNull();
    expect(state.hosts).toHaveLength(0);
    await writer.dispose();
  });
});

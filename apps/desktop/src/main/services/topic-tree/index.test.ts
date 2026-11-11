import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IpcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ipcChannels } from "../../../shared/ipc.js";
import { createTopicTreeServices, engineStatusOf } from "./index.js";
import type { TopicTreeServices, TopicTreeServicesOptions } from "./index.js";
import { topicJobTypes } from "./topic-jobs.js";
import { topicsChangedCoalesceMs } from "./topic-changes.js";
import type { TopicServiceStatus } from "./topic-tree-service.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
// `topicsHistory` belongs to the topics-history area (F5 T171), registered by its own IPC module.
const topicChannels = Object.entries(ipcChannels)
  .filter(([name]) => name.startsWith("topics") && name !== "topicsHistory")
  .map(([, channel]) => channel);

/** An `ipcMain` that, like Electron's, refuses a second handler for a channel. */
function fakeIpc() {
  const handlers = new Map<string, number>();
  const ipc = {
    handle: (channel: string) => {
      if (handlers.has(channel))
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      handlers.set(channel, 1);
    }
  };
  return { ipc: ipc as unknown as IpcMain, handlers };
}

describe("the topic services factory", () => {
  let services: TopicTreeServices | null = null;
  const create = (extra: Partial<TopicTreeServicesOptions> = {}) =>
    (services = createTopicTreeServices({
      getPool: () => null,
      spaceResolver: {
        resolve: async () => ({ kind: "blocked", reason: "waiting_for_embeddings" })
      },
      env: {},
      isPackaged: false,
      logger: quiet,
      ...extra
    }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    services?.dispose();
    services = null;
    vi.useRealTimers();
  });

  describe("the topic IPC (D15)", () => {
    it("registers every topic channel once, and never again from start, a reset or dispose", async () => {
      const { ipc, handlers } = fakeIpc();
      const created = create({ ipc: { main: ipc } });
      expect([...handlers.keys()].sort()).toEqual([...topicChannels].sort());
      expect(created.read).not.toBeNull();
      await created.start();
      await created.ensureActiveTree();
      created.dispose();
      expect(handlers.size).toBe(topicChannels.length);
    });

    it("answers topics.reembed with the space change's re-embedding (T19b, D26)", async () => {
      const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
      const ipc = {
        handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) =>
          handlers.set(channel, handler)
      } as unknown as IpcMain;
      const created = create({ ipc: { main: ipc } });
      const reembed = vi.spyOn(created.spaceChange, "reembed").mockResolvedValue({ queued: 7 });
      await expect(
        handlers.get(ipcChannels.topicsReembed)!({}, { confirm: true })
      ).resolves.toEqual({ queued: 7 });
      expect(reembed).toHaveBeenCalledOnce();
    });

    it("registers nothing without Electron (scripts and tests drive the same services)", () => {
      const created = create();
      expect(created.read).toBeNull();
    });

    it("hands the committed change to its subscribers once per coalesced window, and to no window", () => {
      const { ipc } = fakeIpc();
      const created = create({ ipc: { main: ipc } });
      const heard = vi.fn();
      created.changes.subscribe(heard);
      // The service records each committed change-set here (topic-tree-service.ts).
      created.changes.record({
        treeId: id(1),
        generation: 4,
        topicIds: [id(11)],
        changeSetId: id(21)
      });
      created.changes.record({
        treeId: id(1),
        generation: 5,
        topicIds: [id(12)],
        changeSetId: id(22)
      });
      expect(heard).not.toHaveBeenCalled();
      vi.advanceTimersByTime(topicsChangedCoalesceMs);
      expect(heard).toHaveBeenCalledExactlyOnceWith({
        treeId: id(1),
        generation: 5,
        topicIds: [id(11), id(12)],
        changeSetId: null
      });
    });

    it("announces nothing before a commit and nothing after dispose", () => {
      const { ipc } = fakeIpc();
      const created = create({ ipc: { main: ipc } });
      const heard = vi.fn();
      created.changes.subscribe(heard);
      vi.advanceTimersByTime(10 * topicsChangedCoalesceMs);
      expect(heard).not.toHaveBeenCalled();
      created.changes.record({ treeId: id(1), generation: 1, topicIds: null, changeSetId: null });
      created.dispose();
      vi.advanceTimersByTime(topicsChangedCoalesceMs);
      expect(heard).not.toHaveBeenCalled();
    });

    it("tells topics.status what only the engine knows", () => {
      const status: TopicServiceStatus = {
        treeId: id(1),
        generation: 3,
        phase: "building",
        blocked: "space_changed",
        counts: { items: 5, placed: 3, pending: 2, needsGate: 0, fallbackNone: 0 },
        dailyCapReached: true,
        aiMode: "full",
        held: false
      };
      expect(engineStatusOf(status)).toEqual({
        phase: "building",
        blocked: "space_changed",
        dailyCapReached: true
      });
      expect(
        engineStatusOf({ ...status, blocked: null, phase: "active", dailyCapReached: false })
      ).toEqual({ phase: "active", dailyCapReached: false });
    });
  });

  describe("the light-lane registry (D33)", () => {
    it("runs PLACE, the sweep, the build, REBALANCE and the audit on the compute worker (T19)", () => {
      const created = create();
      for (const type of [
        topicJobTypes.place,
        topicJobTypes.sweep,
        topicJobTypes.build,
        topicJobTypes.rebalance,
        topicJobTypes.audit
      ]) {
        expect(created.jobs[type]?.needsModel, type).toBe(false);
      }
      expect(created.structure).toBeDefined();
    });
  });

  describe("naming and label vectors (T18)", () => {
    const ai = {
      runDefaultTask: vi.fn(async () => null),
      activeEmbeddingSpace: vi.fn(async () => null)
    } as unknown as NonNullable<TopicTreeServicesOptions["ai"]>;

    it("registers the naming and label jobs on the model worker only with an AI service", () => {
      const bare = create();
      expect(bare.naming).toBeNull();
      expect(bare.labels).toBeNull();
      expect(Object.keys(bare.jobs).sort()).toEqual(
        [
          topicJobTypes.place,
          topicJobTypes.sweep,
          topicJobTypes.build,
          topicJobTypes.rebalance,
          topicJobTypes.audit
        ].sort()
      );
      bare.dispose();

      const full = create({ ai, getContentLanguage: async () => "pt-BR" });
      expect(full.naming).not.toBeNull();
      expect(full.labels).not.toBeNull();
      expect(full.jobs[topicJobTypes.name]?.needsModel).toBe(true);
      expect(full.jobs[topicJobTypes.labelEmbed]?.needsModel).toBe(true);
      expect(full.jobs[topicJobTypes.place]?.needsModel).toBe(false);
      // An AI service without a content language cannot name in it: nothing is registered.
      full.dispose();
      const noLanguage = create({ ai });
      expect(noLanguage.jobs[topicJobTypes.name]).toBeUndefined();
    });

    it("registers the Areas job (T24) on the model worker beside naming", async () => {
      const bare = create();
      expect(bare.areas).toBeNull();
      expect(bare.jobs[topicJobTypes.areas]).toBeUndefined();
      bare.dispose();
      const full = create({ ai, getContentLanguage: async () => "pt-BR" });
      expect(full.areas).not.toBeNull();
      expect(full.jobs[topicJobTypes.areas]?.needsModel).toBe(true);
      // Without a pool, asking for the grouping again never throws and queues nothing.
      await expect(full.areas!.requestIfNeeded(id(1))).resolves.toBeUndefined();
      await expect(full.areas!.requestIfNeeded(null)).resolves.toBeUndefined();
      full.dispose();
    });

    it("holds the naming jobs with the rest of the topic jobs while the barrier is on", async () => {
      const created = create({ ai, getContentLanguage: async () => "en" });
      const types = [topicJobTypes.name, topicJobTypes.labelEmbed];
      created.holdTopicJobs();
      expect(types.map((type) => created.jobs[type]?.held?.())).toEqual([true, true]);
      await created.releaseTopicJobs();
      expect(types.map((type) => created.jobs[type]?.held?.())).toEqual([false, false]);
    });

    it("asks for naming after a commit only when a pool exists; nothing is queued without one", async () => {
      const created = create({ ai, getContentLanguage: async () => "en" });
      await expect(created.naming!.requestIfNeeded(id(1))).resolves.toBeUndefined();
      await expect(created.naming!.requestIfNeeded(null)).resolves.toBeUndefined();
      created.changes.record({ treeId: id(1), generation: 1, topicIds: null, changeSetId: null });
      vi.advanceTimersByTime(topicsChangedCoalesceMs);
      expect(quiet.error).not.toHaveBeenCalled();
    });
  });

  describe("the topic barrier (D23)", () => {
    it("holds every topic job type, and the release resumes them and wakes the light lane", async () => {
      const wake = vi.fn();
      const created = create({ wake });
      const types = [
        topicJobTypes.place,
        topicJobTypes.sweep,
        topicJobTypes.build,
        topicJobTypes.rebalance,
        topicJobTypes.audit
      ];
      const heldTypes = () => types.map((type) => created.jobs[type]?.held?.());
      expect(heldTypes()).toEqual(types.map(() => false));

      created.holdTopicJobs();
      expect(created.service.isHeld()).toBe(true);
      expect(heldTypes()).toEqual(types.map(() => true));
      expect(wake).not.toHaveBeenCalled();

      await created.releaseTopicJobs();
      expect(created.service.isHeld()).toBe(false);
      expect(heldTypes()).toEqual(types.map(() => false));
      expect(wake).toHaveBeenCalledTimes(1);
    });

    it("is idempotent: a second hold or release changes nothing and throws nothing", async () => {
      const wake = vi.fn();
      const created = create({ wake });
      created.holdTopicJobs();
      created.holdTopicJobs();
      expect(created.service.isHeld()).toBe(true);
      await created.releaseTopicJobs();
      await created.releaseTopicJobs();
      expect(created.service.isHeld()).toBe(false);
      // The barrier can be re-armed after a release, as the golden runner does at each source.
      created.holdTopicJobs();
      expect(created.service.isHeld()).toBe(true);
      await created.releaseTopicJobs();
      expect(created.service.isHeld()).toBe(false);
    });

    it("hands the golden runner a barrier that drives the same hold and release", async () => {
      const created = create();
      await created.goldenBarrier.hold();
      expect(created.service.isHeld()).toBe(true);
      await created.goldenBarrier.release();
      expect(created.service.isHeld()).toBe(false);
    });
  });

  describe("the change hooks (T15b)", () => {
    it("sit on the service's own triggers: their jobs are tracked by the barrier like its own", async () => {
      const created = create();
      const notesChanged = vi.spyOn(created.triggers, "notesChanged").mockResolvedValue([]);
      const sourcesChanged = vi.spyOn(created.triggers, "sourcesChanged").mockResolvedValue([]);
      const repair = vi.spyOn(created.triggers, "repair").mockResolvedValue([]);
      await created.hooks.notesChanged([id(1)]);
      await created.hooks.sourcesChanged([id(2)]);
      await created.hooks.itemsRemoved();
      expect(notesChanged).toHaveBeenCalledWith([id(1)], {});
      expect(sourcesChanged).toHaveBeenCalledWith([id(2)], {});
      expect(repair).toHaveBeenCalledWith({});
    });

    it("never throw, even when the database is not ready", async () => {
      const created = create();
      await expect(created.hooks.notesChanged([id(1)])).resolves.toBeUndefined();
      await expect(created.hooks.sourcesChanged([id(2)])).resolves.toBeUndefined();
      await expect(created.hooks.itemsRemoved()).resolves.toBeUndefined();
    });
  });

  describe("the ENV-C corpus runner (T22b)", () => {
    it("never holds the topic jobs on an ordinary start", async () => {
      const created = create();
      await created.start();
      expect(created.service.isHeld()).toBe(false);
    });

    it("ignores the corpus knob of a packaged build: nothing is held, nothing quits", async () => {
      const created = create({
        isPackaged: true,
        env: { MEMORA_TOPIC_CORPUS: "1", MEMORA_USER_DATA_DIR: "/profiles/x" }
      });
      await created.start();
      expect(created.service.isHeld()).toBe(false);
      expect(quiet.warn).toHaveBeenCalledWith(
        expect.stringContaining("ignored in packaged builds")
      );
    });

    it("holds the topic jobs as soon as a valid knob is read, before start returns", async () => {
      vi.useRealTimers();
      const workspace = await mkdtemp(join(tmpdir(), "memora-corpus-hook-"));
      try {
        const created = create({
          env: {
            MEMORA_TOPIC_CORPUS: "1",
            MEMORA_USER_DATA_DIR: join(workspace, ".cache", "profiles", "env-c"),
            MEMORA_WORKSPACE_ROOT: workspace,
            MEMORA_TOPIC_CORPUS_STAGE: "seed"
          }
        });
        await created.start();
        expect(created.service.isHeld()).toBe(true);
        // The run refuses a profile that does not exist, in the background, and records it; the
        // barrier stays up (a stopped run never lets queued topic work through).
        const folder = join(workspace, ".cache", "topics", "corpus-runs");
        let files: string[] = [];
        for (let attempt = 0; attempt < 100 && files.length === 0; attempt += 1) {
          files = await readdir(folder).catch(() => []);
          if (files.length === 0) await new Promise((done) => setTimeout(done, 20));
        }
        expect(files).toHaveLength(1);
        expect(JSON.parse(await readFile(join(folder, files[0]!), "utf8"))).toMatchObject({
          outcome: "refused",
          topicJobsLeftHeld: true
        });
        expect(created.service.isHeld()).toBe(true);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });
});

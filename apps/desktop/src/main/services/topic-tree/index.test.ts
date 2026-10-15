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
const topicChannels = Object.entries(ipcChannels)
  .filter(([name]) => name.startsWith("topics") && name !== "topicsChanged")
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

function fakeWindow(destroyed = false) {
  const send = vi.fn();
  return { send, target: { isDestroyed: () => destroyed, send } };
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
      const created = create({ ipc: { main: ipc, targets: () => [] } });
      expect([...handlers.keys()].sort()).toEqual([...topicChannels].sort());
      expect(created.read).not.toBeNull();
      await created.start();
      await created.ensureActiveTree();
      created.dispose();
      expect(handlers.size).toBe(topicChannels.length);
    });

    it("registers nothing without Electron (scripts and tests drive the same services)", () => {
      const created = create();
      expect(created.read).toBeNull();
    });

    it("pushes topicsChanged to every live window after a commit, once per coalesced window", () => {
      const { ipc } = fakeIpc();
      const live = fakeWindow();
      const gone = fakeWindow(true);
      const created = create({ ipc: { main: ipc, targets: () => [live.target, gone.target] } });
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
      expect(live.send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(topicsChangedCoalesceMs);
      expect(live.send).toHaveBeenCalledExactlyOnceWith(ipcChannels.topicsChanged, {
        treeId: id(1),
        generation: 5,
        topicIds: [id(11), id(12)],
        changeSetId: null
      });
      expect(gone.send).not.toHaveBeenCalled();
    });

    it("sends nothing before a commit and nothing after dispose", () => {
      const { ipc } = fakeIpc();
      const live = fakeWindow();
      const created = create({ ipc: { main: ipc, targets: () => [live.target] } });
      vi.advanceTimersByTime(10 * topicsChangedCoalesceMs);
      expect(live.send).not.toHaveBeenCalled();
      created.changes.record({ treeId: id(1), generation: 1, topicIds: null, changeSetId: null });
      created.dispose();
      vi.advanceTimersByTime(topicsChangedCoalesceMs);
      expect(live.send).not.toHaveBeenCalled();
    });

    it("tells topics.status what only the engine knows", () => {
      const status: TopicServiceStatus = {
        treeId: id(1),
        generation: 3,
        phase: "building",
        blocked: "space_changed",
        counts: { items: 5, placed: 3, pending: 2, needsGate: 0 },
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
});

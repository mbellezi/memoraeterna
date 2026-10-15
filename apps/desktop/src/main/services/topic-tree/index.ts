// The Topic Tree Engine services of the main process, created once by `main/index.ts`. The factory
// builds them without Electron (injected pool, space resolver and wake-up), so scripts and tests
// can drive the same services. Later tasks register their light-lane executors in the registry
// below, one line each, in merge order: T16, T22a, T18, T19, T22b, T23, T24, T31, T19b.
import type { IpcMain } from "electron";

import type { PgPool } from "@app/db";
import { defaultTopicTreeConfig } from "@app/domain/topic-tree";
import type { TopicTreeConfig } from "@app/domain/topic-tree";

import type { GoldenTopicBarrier } from "../golden-topics.js";
import type { LightJobRegistry } from "../job-lanes.js";
import { TopicAiBudget, readTopicAiMode, settingsAiBudgetStore } from "./topic-ai.js";
import { TopicStructureJobs } from "./topic-build.js";
import type { ClusterTopics } from "./topic-build.js";
import type { TopicAiBudgetStore, TopicAiMode } from "./topic-ai.js";
import { TopicChangeCoalescer } from "./topic-changes.js";
import { createTopicChangeHooks } from "./topic-hooks.js";
import type { TopicChangeHooks } from "./topic-hooks.js";
import { registerTopicTreeIpc } from "./topic-ipc.js";
import type { TopicsChangedTarget } from "./topic-ipc.js";
import { createTopicJobRegistry, topicJobTypes } from "./topic-jobs.js";
import type { TopicJobExecutor } from "./topic-jobs.js";
import type { TopicEngineStatus, TopicReadService } from "./topic-read-service.js";
import type { SpaceResolver } from "./topic-space.js";
import { TopicTreeService } from "./topic-tree-service.js";
import type { EnsureTreeResult, TopicServiceStatus } from "./topic-tree-service.js";
import { TopicTriggers, immediateDebounce } from "./topic-triggers.js";

export interface TopicTreeServicesOptions {
  getPool: () => PgPool | null;
  /** The active embedding route's space (D26); the AI service provides it from T14. */
  spaceResolver: SpaceResolver;
  /** Read once here: G1 (`MEMORA_GOLDEN_RUN`, `MEMORA_GOLDEN_TOPICS`, D23). */
  env: Readonly<Record<string, string | undefined>>;
  isPackaged: boolean;
  /** Wakes the job supervisor's light lane after an enqueue. */
  wake?: () => void;
  logger?: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
  /** Where D34's daily counter lives (default: the settings table). */
  budgetStore?: TopicAiBudgetStore;
  /** Coalescing window of `topicsChanged` (default 250 ms, D15). */
  changesDelayMs?: number;
  /** The configuration of a new tree (default: the engine's start values); tests shrink it. */
  newTreeConfig?: () => TopicTreeConfig;
  /** Clusters builds (default: the clustering worker thread); scripts and tests run it in process. */
  clusterTopics?: ClusterTopics;
  /**
   * The topic IPC (T16): `ipcMain` and the windows that hear `topicsChanged`. The factory registers
   * the channels once and subscribes the push to `changes`; absent, nothing is registered (scripts
   * and tests that drive the services without Electron).
   */
  ipc?: { main: IpcMain; targets: () => Iterable<TopicsChangedTarget> };
}

export interface TopicTreeServices {
  service: TopicTreeService;
  triggers: TopicTriggers;
  /** What note, source and deletion call sites call (T15b); a hook never fails its caller. */
  hooks: TopicChangeHooks;
  /** `topicsChanged` (D15): the topic IPC forwards its events to the renderer channel. */
  changes: TopicChangeCoalescer;
  /** The read side of the topic screens; null without `options.ipc`. */
  read: TopicReadService | null;
  budget: TopicAiBudget;
  aiMode: TopicAiMode;
  /** The light-lane job registry for the job supervisor (D33). */
  jobs: LightJobRegistry;
  /** The build, REBALANCE and audit jobs (T19). */
  structure: TopicStructureJobs;
  /** Startup: ensures the active tree (D39) and enqueues the sweep. Never throws. */
  start(): Promise<void>;
  /** After a library reset's defaults: an empty active tree again (D39). Never throws. */
  ensureActiveTree(): Promise<EnsureTreeResult | null>;
  holdTopicJobs(): void;
  releaseTopicJobs(): Promise<void>;
  /** The golden runner's topic barrier (D23): the two calls above, as `MEMORA_GOLDEN_TOPICS=full` needs. */
  goldenBarrier: GoldenTopicBarrier;
  dispose(): void;
}

/** What `topics.status` takes from the engine: its phase, what blocks it and the daily cap. */
export function engineStatusOf(status: TopicServiceStatus): TopicEngineStatus {
  return {
    phase: status.phase,
    ...(status.blocked ? { blocked: status.blocked } : {}),
    dailyCapReached: status.dailyCapReached
  };
}

export function createTopicTreeServices(options: TopicTreeServicesOptions): TopicTreeServices {
  const { getPool, logger } = options;
  const aiMode = readTopicAiMode(options.env, options.isPackaged, logger);
  const changes = new TopicChangeCoalescer({
    ...(options.changesDelayMs === undefined ? {} : { delayMs: options.changesDelayMs }),
    ...(logger ? { logger } : {})
  });
  let registered: ReadonlySet<string> = new Set();
  const isRegistered = (type: string) => registered.has(type);
  // The service is assigned below, before anything can call these closures.
  let service: TopicTreeService | null = null;
  const triggers = new TopicTriggers({
    getPool,
    isRegistered,
    debounce: () => service!.jobDebounce(),
    onEnqueued: (job) => service?.trackEnqueued(job),
    ...(options.wake ? { wake: options.wake } : {})
  });
  const hooks = createTopicChangeHooks(triggers, logger);
  const budget = new TopicAiBudget({
    store: options.budgetStore ?? settingsAiBudgetStore(getPool),
    cap: () => service!.config().ai.maxBackgroundCallsPerDay,
    ...(options.now ? { now: options.now } : {})
  });
  const topicService = new TopicTreeService({
    getPool,
    spaceResolver: options.spaceResolver,
    triggers,
    changes,
    aiMode,
    budget,
    isRegistered,
    ...(options.newTreeConfig ? { newTreeConfig: options.newTreeConfig } : {}),
    ...(options.wake ? { wake: options.wake } : {}),
    ...(logger ? { logger } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  service = topicService;
  // T19: the cold start of any library, rebuilds, REBALANCE and the audit (D39).
  const structure = new TopicStructureJobs({
    getPool,
    service: topicService,
    triggers,
    changes,
    spaceResolver: options.spaceResolver,
    aiMode,
    isRegistered,
    effectiveConfig: () => options.newTreeConfig?.() ?? defaultTopicTreeConfig,
    ...(options.clusterTopics ? { clusterTopics: options.clusterTopics } : {}),
    ...(logger ? { logger } : {}),
    ...(options.now ? { now: options.now } : {})
  });

  // The topic IPC is registered here and nowhere else; the coalescer's single listener is the push.
  let read: TopicReadService | null = null;
  if (options.ipc) {
    const registeredIpc = registerTopicTreeIpc(options.ipc.main, {
      getPool,
      targets: options.ipc.targets,
      engineStatus: async () => engineStatusOf(await topicService.status()),
      ...(options.now ? { now: options.now } : {}),
      ...(logger ? { onInvalidEvent: (error: Error) => logger.error(error.message) } : {})
    });
    read = registeredIpc.read;
    changes.subscribe(registeredIpc.emitChanged);
  }

  const executors: Record<string, TopicJobExecutor> = {
    [topicJobTypes.place]: {
      needsModel: false,
      execute: async (job, signal) => {
        const result = await topicService.runPlace(job, signal);
        await structure.afterPlace(job, result);
        return result;
      }
    },
    [topicJobTypes.sweep]: {
      needsModel: false,
      execute: async (job, signal) => {
        const result = await topicService.runSweep(job, signal);
        await structure.afterSweep(result);
        return result;
      }
    },
    [topicJobTypes.build]: {
      needsModel: false,
      execute: (job, signal) => structure.runBuild(job, signal)
    },
    [topicJobTypes.rebalance]: {
      needsModel: false,
      execute: (job, signal) => structure.runRebalance(job, signal)
    },
    [topicJobTypes.audit]: {
      needsModel: false,
      execute: (job) => structure.runAudit(job)
    }
  };
  registered = new Set(Object.keys(executors));
  const jobs = createTopicJobRegistry(executors, () => topicService.isHeld());

  const ensureActiveTree = async (): Promise<EnsureTreeResult | null> => {
    try {
      return await topicService.ensureActiveTree();
    } catch (error) {
      logger?.error("Topic tree could not be ensured", error);
      return null;
    }
  };

  return {
    service: topicService,
    triggers,
    hooks,
    changes,
    read,
    budget,
    aiMode,
    jobs,
    structure,
    async start() {
      const ensured = await ensureActiveTree();
      const treeId = ensured?.kind === "ready" ? ensured.tree.id : null;
      try {
        await triggers.sweep("startup", { treeId, debounce: immediateDebounce });
      } catch (error) {
        logger?.error("Topic sweep could not be enqueued", error);
      }
      // The day's audit: metrics, the structural configuration (D39) and rebuild triggers.
      await structure.startup(treeId);
    },
    ensureActiveTree,
    holdTopicJobs: () => topicService.holdTopicJobs(),
    releaseTopicJobs: () => topicService.releaseTopicJobs(),
    goldenBarrier: {
      hold: () => topicService.holdTopicJobs(),
      release: () => topicService.releaseTopicJobs()
    },
    dispose: () => {
      changes.dispose();
      void structure.dispose();
    }
  };
}

export type { TopicTreeService } from "./topic-tree-service.js";

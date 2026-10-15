// The Topic Tree Engine services of the main process, created once by `main/index.ts`. The factory
// builds them without Electron (injected pool, space resolver and wake-up), so scripts and tests
// can drive the same services. Later tasks register their light-lane executors in the registry
// below, one line each, in merge order: T16, T22a, T18, T19, T22b, T23, T24, T31, T19b.
import type { PgPool } from "@app/db";
import type { TopicTreeConfig } from "@app/domain/topic-tree";

import type { LightJobRegistry } from "../job-lanes.js";
import { TopicAiBudget, readTopicAiMode, settingsAiBudgetStore } from "./topic-ai.js";
import type { TopicAiBudgetStore, TopicAiMode } from "./topic-ai.js";
import { TopicChangeCoalescer } from "./topic-changes.js";
import { createTopicJobRegistry, topicJobTypes } from "./topic-jobs.js";
import type { TopicJobExecutor } from "./topic-jobs.js";
import type { SpaceResolver } from "./topic-space.js";
import { TopicTreeService } from "./topic-tree-service.js";
import type { EnsureTreeResult } from "./topic-tree-service.js";
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
}

export interface TopicTreeServices {
  service: TopicTreeService;
  triggers: TopicTriggers;
  /** `topicsChanged` (D15): T16 forwards its events to the renderer channel. */
  changes: TopicChangeCoalescer;
  budget: TopicAiBudget;
  aiMode: TopicAiMode;
  /** The light-lane job registry for the job supervisor (D33). */
  jobs: LightJobRegistry;
  /** Startup: ensures the active tree (D39) and enqueues the sweep. Never throws. */
  start(): Promise<void>;
  /** After a library reset's defaults: an empty active tree again (D39). Never throws. */
  ensureActiveTree(): Promise<EnsureTreeResult | null>;
  holdTopicJobs(): void;
  releaseTopicJobs(): Promise<void>;
  dispose(): void;
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

  const executors: Record<string, TopicJobExecutor> = {
    [topicJobTypes.place]: {
      needsModel: false,
      execute: (job, signal) => topicService.runPlace(job, signal)
    },
    [topicJobTypes.sweep]: {
      needsModel: false,
      execute: (job, signal) => topicService.runSweep(job, signal)
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
    changes,
    budget,
    aiMode,
    jobs,
    async start() {
      const ensured = await ensureActiveTree();
      try {
        await triggers.sweep("startup", {
          treeId: ensured?.kind === "ready" ? ensured.tree.id : null,
          debounce: immediateDebounce
        });
      } catch (error) {
        logger?.error("Topic sweep could not be enqueued", error);
      }
    },
    ensureActiveTree,
    holdTopicJobs: () => topicService.holdTopicJobs(),
    releaseTopicJobs: () => topicService.releaseTopicJobs(),
    dispose: () => changes.dispose()
  };
}

export type { TopicTreeService } from "./topic-tree-service.js";

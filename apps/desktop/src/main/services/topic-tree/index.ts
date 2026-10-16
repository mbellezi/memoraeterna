// The Topic Tree Engine services of the main process, created once by `main/index.ts`. The factory
// builds them without Electron (injected pool, space resolver and wake-up), so scripts and tests
// can drive the same services. Later tasks register their light-lane executors in the registry
// below, one line each, in merge order: T16, T22a, T18, T19, T22b, T23, T24, T31, T19b.
import type { IpcMain } from "electron";

import type { PgPool } from "@app/db";
import { defaultTopicTreeConfig } from "@app/domain/topic-tree";
import type { TopicTreeConfig } from "@app/domain/topic-tree";

import type { AiService } from "../ai-service.js";
import type { GoldenTopicBarrier } from "../golden-topics.js";
import type { LightJobRegistry } from "../job-lanes.js";
import { startCorpusRunner } from "./corpus-runner.js";
import { TopicAiBudget, readTopicAiMode, settingsAiBudgetStore } from "./topic-ai.js";
import { TopicAreasService } from "./topic-areas.js";
import { ipcChannels } from "../../../shared/ipc.js";
import { TopicStructureJobs } from "./topic-build.js";
import type { ClusterTopics } from "./topic-build.js";
import type { TopicAiBudgetStore, TopicAiMode } from "./topic-ai.js";
import { TopicChangeCoalescer } from "./topic-changes.js";
import { createTopicChangeHooks } from "./topic-hooks.js";
import type { TopicChangeHooks } from "./topic-hooks.js";
import { registerTopicTreeIpc } from "./topic-ipc.js";
import type { TopicsChangedTarget } from "./topic-ipc.js";
import { TopicGateService } from "./topic-gate.js";
import { createTopicJobRegistry, topicJobTypes } from "./topic-jobs.js";
import type { TopicJobExecutor } from "./topic-jobs.js";
import { TopicLabelService } from "./topic-labels.js";
import { TopicNamingService } from "./topic-naming.js";
import { TopicOverviewService } from "./topic-overview.js";
import type { TopicEngineStatus, TopicReadService } from "./topic-read-service.js";
import { TopicSpaceChange } from "./topic-space.js";
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
  /**
   * The AI service the naming and label jobs call (T18) and the library's content language. Both
   * are needed to register those jobs; scripts and tests that drive placement alone leave them out.
   * The gate (T23) needs only the AI service: its validated ranker.
   */
  ai?: Pick<AiService, "runDefaultTask" | "activeEmbeddingSpace" | "rank" | "decideRouteStatus">;
  getContentLanguage?: () => Promise<string>;
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
  /** Topic names (D11) and label vectors; null without `options.ai` and `getContentLanguage`. */
  naming: TopicNamingService | null;
  labels: TopicLabelService | null;
  /** The placement gate (D10); null without `options.ai`. */
  gate: TopicGateService | null;
  /** The Areas grouping (D12, T24); null without `options.ai` and `getContentLanguage`. */
  areas: TopicAreasService | null;
  /** The lazy overview of a Topic page (T31); null without `options.ai` and `getContentLanguage`. */
  overview: TopicOverviewService | null;
  budget: TopicAiBudget;
  aiMode: TopicAiMode;
  /** The light-lane job registry for the job supervisor (D33). */
  jobs: LightJobRegistry;
  /** The build, REBALANCE and audit jobs (T19). */
  structure: TopicStructureJobs;
  /** The re-embedding of an embedding-space change and `topics.reembed` (D26, T19b). */
  spaceChange: TopicSpaceChange;
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

/**
 * What `topics.status` takes from the engine: its phase, what blocks it and the daily cap.
 * `noDecider`: items wait for a gate decision (flagged, or the no-decider fallback's, decision 19)
 * and no validated ranker can decide them (informative).
 */
export function engineStatusOf(status: TopicServiceStatus, noDecider = false): TopicEngineStatus {
  const blocked = status.blocked ?? (noDecider ? "no_decider" : null);
  return {
    phase: status.phase,
    ...(blocked ? { blocked } : {}),
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
  // The service and the gate are assigned below, before anything can call these closures.
  let service: TopicTreeService | null = null;
  let gateService: TopicGateService | null = null;
  const triggers = new TopicTriggers({
    getPool,
    isRegistered,
    debounce: () => service!.jobDebounce(),
    onEnqueued: (job) => service?.trackEnqueued(job),
    ...(options.wake ? { wake: options.wake } : {})
  });
  const hooks = createTopicChangeHooks(triggers, logger);
  // A pin writes the view history in the change-set's transaction; the navigator reads it again.
  const notifyViewHistory = options.ipc
    ? () => {
        for (const target of options.ipc!.targets()) {
          if (!target.isDestroyed()) target.send(ipcChannels.viewHistoryChanged);
        }
      }
    : undefined;
  // The structure jobs are created below, after the service they run on.
  let structureJobs: TopicStructureJobs | null = null;
  // T19b: re-embedding after the route's embedding space changed (D26).
  const spaceChange = new TopicSpaceChange({
    getPool,
    spaceResolver: options.spaceResolver,
    aiMode,
    ...(logger ? { logger } : {}),
    ...(options.now ? { now: options.now } : {})
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
    // T26: a human change-set asks REBALANCE to check the topics it touched.
    onHumanChange: (change) =>
      structureJobs?.afterHumanChange(change.treeId, change.changeSetId, change.generation),
    // T19b: the status saw the route's space move; the build re-embeds and moves the tree.
    onSpaceChanged: (treeId) => structureJobs?.spaceChanged(treeId),
    // Owner decision 19: the gate's route tells PLACE and the sweep whether a ranker decides.
    ...(options.ai
      ? { deciderReady: (waiting: number) => gateService!.deciderReady(waiting) }
      : {}),
    ...(notifyViewHistory ? { onViewHistoryChanged: notifyViewHistory } : {}),
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
    spaceChange,
    ...(options.clusterTopics ? { clusterTopics: options.clusterTopics } : {}),
    ...(logger ? { logger } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  structureJobs = structure;

  // The placement gate (T23, D10) on the `model` worker: only the AI service's validated ranker.
  const gate = options.ai
    ? new TopicGateService({
        getPool,
        service: topicService,
        ai: options.ai,
        aiMode,
        triggers,
        changes,
        // The leaves a gate change-set filled wait for REBALANCE, as after PLACE (I4).
        onChangeSet: (change) =>
          structure.afterGateChange(change.treeId, change.changeSetId, change.generation),
        ...(logger ? { logger } : {}),
        ...(options.now ? { now: options.now } : {})
      })
    : null;
  gateService = gate;

  // T31: the overview a Topic page writes on open (interactive, cancelable, not capped by D34).
  const overview =
    options.ai && options.getContentLanguage
      ? new TopicOverviewService({
          getPool,
          ai: options.ai,
          getContentLanguage: options.getContentLanguage,
          aiMode,
          ...(logger ? { logger } : {}),
          ...(options.now ? { now: options.now } : {})
        })
      : null;

  // The topic IPC is registered here and nowhere else; the coalescer's single listener is the push.
  let read: TopicReadService | null = null;
  if (options.ipc) {
    const registeredIpc = registerTopicTreeIpc(options.ipc.main, {
      getPool,
      targets: options.ipc.targets,
      engineStatus: async () => {
        const status = await topicService.status();
        const engine = engineStatusOf(
          status,
          (await gate?.waitingForDecider(status.counts.needsGate + status.counts.fallbackNone)) ??
            false
        );
        // T19b: on a remote route, the notes "Re-embed library" would cover (D26, Q8).
        const reembedNotes = await spaceChange.reembedNotes(status.route).catch(() => null);
        return reembedNotes === null ? engine : { ...engine, reembedNotes };
      },
      // T26: the human operations of the topic screens.
      mutate: (input) => topicService.mutate(input),
      undo: (input) => topicService.undo(input),
      review: (input) => topicService.review(input),
      ...(overview
        ? {
            overview: (topicId: string) => overview.state(topicId),
            writeOverview: (input) => overview.overview(input),
            cancelOverview: (input) => overview.cancel(input)
          }
        : {}),
      // T19b: the owner's re-embedding of the library after a space change (D26).
      reembed: () => spaceChange.reembed(),
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

  // Naming and label vectors (T18) run on the `model` worker, and every committed change may have
  // created topics that wait for a name.
  let naming: TopicNamingService | null = null;
  let labels: TopicLabelService | null = null;
  let areas: TopicAreasService | null = null;
  if (options.ai && options.getContentLanguage) {
    const namingService = new TopicNamingService({
      getPool,
      ai: options.ai,
      getContentLanguage: options.getContentLanguage,
      budget,
      aiMode,
      triggers,
      changes,
      isRegistered,
      ...(logger ? { logger } : {}),
      ...(options.now ? { now: options.now } : {})
    });
    const labelService = new TopicLabelService({
      getPool,
      ai: options.ai,
      budget,
      aiMode,
      triggers,
      ...(logger ? { logger } : {})
    });
    naming = namingService;
    labels = labelService;
    executors[topicJobTypes.name] = {
      needsModel: true,
      execute: (job, signal) => namingService.runName(job, signal)
    };
    executors[topicJobTypes.labelEmbed] = {
      needsModel: true,
      execute: (job, signal) => labelService.runLabelEmbed(job, signal)
    };
    changes.subscribe(namingService.onTopicsChanged);
    // T24: the Areas grouping (D12) runs on the `model` worker after builds.
    const areasService = new TopicAreasService({
      getPool,
      service: topicService,
      ai: options.ai,
      getContentLanguage: options.getContentLanguage,
      budget,
      aiMode,
      triggers,
      changes,
      isRegistered,
      ...(logger ? { logger } : {}),
      ...(options.now ? { now: options.now } : {})
    });
    areas = areasService;
    executors[topicJobTypes.areas] = {
      needsModel: true,
      execute: (job, signal) => areasService.runAreas(job, signal)
    };
  }
  if (gate) {
    executors[topicJobTypes.gate] = {
      needsModel: true,
      execute: (job, signal) => gate.runGate(job, signal)
    };
    changes.subscribe(gate.onTopicsChanged);
  }
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

  const corpusRunnerOptions = {
    env: options.env,
    isPackaged: options.isPackaged,
    getPool,
    spaceResolver: options.spaceResolver,
    ...(logger ? { logger } : {}),
    ...(options.now ? { now: options.now } : {})
  };

  return {
    service: topicService,
    triggers,
    hooks,
    changes,
    read,
    naming,
    labels,
    gate,
    areas,
    overview,
    budget,
    aiMode,
    jobs,
    structure,
    spaceChange,
    async start() {
      // ENV-C (T22b): with MEMORA_TOPIC_CORPUS set (DEV only) the topic jobs are held before the
      // supervisor starts and the corpus runner seeds, embeds and builds in the background.
      void startCorpusRunner({ ...corpusRunnerOptions, service: topicService, triggers });
      const ensured = await ensureActiveTree();
      const treeId = ensured?.kind === "ready" ? ensured.tree.id : null;
      try {
        await triggers.sweep("startup", { treeId, debounce: immediateDebounce });
      } catch (error) {
        logger?.error("Topic sweep could not be enqueued", error);
      }
      // The day's audit: metrics, the structural configuration (D39) and rebuild triggers.
      await structure.startup(treeId);
      // Topics an earlier run left without a name, and Areas a build left ungrouped (never throw).
      await naming?.requestIfNeeded(treeId);
      await areas?.requestIfNeeded(treeId);
    },
    ensureActiveTree,
    holdTopicJobs: () => topicService.holdTopicJobs(),
    releaseTopicJobs: () => topicService.releaseTopicJobs(),
    goldenBarrier: {
      hold: () => topicService.holdTopicJobs(),
      release: () => topicService.releaseTopicJobs()
    },
    dispose: () => {
      overview?.dispose();
      changes.dispose();
      gate?.dispose();
      void structure.dispose();
    }
  };
}

export type { TopicTreeService } from "./topic-tree-service.js";

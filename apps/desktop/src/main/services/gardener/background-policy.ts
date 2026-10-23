import type { AiSchedulerHooks } from "@app/ai";
import { createJobBlockerRepository, type PgPool } from "@app/db";
import { defaultGardenerConfig, type GardenerConfig } from "@app/domain";

import { BackgroundGate, type CallGate, type KindGate } from "./background-gate.js";
import { BlockerService } from "./blocker-service.js";
import type { JobBackgroundPolicy } from "./job-background-policy.js";
import { KnowledgeControlsService, settingsKnowledgeControlsStore } from "./knowledge-controls.js";
import { PowerSignals, readDevPowerOverride, type PowerSource } from "./power-signals.js";

export interface BackgroundPolicyOptions {
  getPool: () => PgPool | null;
  /** Electron's `powerMonitor`; null where there is none. */
  powerSource: PowerSource | null;
  isPackaged: boolean;
  /** The process environment: an unpackaged build reads the DEV power override from it. */
  env: Readonly<Record<string, string | undefined>>;
  /** Wakes the job workers: blocked rows were set free. */
  wake: () => void;
  /** Hands the AI lanes' slots out again: the duty cycle moved. */
  refreshLanes?: () => void;
  /** The AI configuration's generation (`aiConfigGeneration`). */
  routesGeneration?: () => number;
  /** Gates other services add (the remote budget, the routes). */
  kindGates?: readonly KindGate[];
  callGates?: readonly CallGate[];
  config?: GardenerConfig;
  logger?: Pick<Console, "warn">;
}

/** The background policy's parts, wired together (F4 T75). */
export interface BackgroundPolicy {
  readonly controls: KnowledgeControlsService;
  readonly power: PowerSignals;
  readonly gate: BackgroundGate;
  readonly blockers: BlockerService;
  /** What the job supervisor asks of the policy. */
  readonly jobs: JobBackgroundPolicy;
  /** The AI scheduler's admission hook and duty cycle. */
  readonly admission: Pick<AiSchedulerHooks, "admit" | "backgroundDutyCycle">;
  /** Starts the power signals and the blocker service, once the database is ready. */
  start(): void;
  stop(): void;
}

/**
 * Builds the background policy: the Knowledge controls, the power signals (with the DEV override
 * of an unpackaged run, which throws on an unknown block), the gate and the blocker service.
 */
export function createBackgroundPolicy(options: BackgroundPolicyOptions): BackgroundPolicy {
  const config = options.config ?? defaultGardenerConfig;
  const pool = () => options.getPool();
  const controls = new KnowledgeControlsService({
    store: settingsKnowledgeControlsStore(pool),
    pool,
    ...(options.logger ? { logger: options.logger } : {})
  });
  const power = new PowerSignals({
    source: options.powerSource,
    isPackaged: options.isPackaged,
    config,
    override: readDevPowerOverride(options.env, {
      isPackaged: options.isPackaged,
      now: Date.now()
    }),
    ...(options.logger ? { logger: options.logger } : {})
  });
  const gate = new BackgroundGate({
    controls: () => controls.current(),
    power: () => power.snapshot(),
    dutyCycle: () => power.dutyCycle(),
    config,
    ...(options.kindGates ? { kindGates: options.kindGates } : {}),
    ...(options.callGates ? { callGates: options.callGates } : {})
  });
  const blockers = new BlockerService({
    store: () => {
      const current = pool();
      return current ? createJobBlockerRepository(current) : null;
    },
    gate,
    signals: {
      subscribeControls: (listener) => controls.subscribe(listener),
      subscribePower: (listener) => power.subscribe(listener),
      refreshControls: () => controls.get()
    },
    wake: () => options.wake(),
    ...(options.routesGeneration ? { routesGeneration: options.routesGeneration } : {}),
    config,
    ...(options.logger ? { logger: options.logger } : {})
  });
  let unsubscribe: (() => void) | null = null;
  return {
    controls,
    power,
    gate,
    blockers,
    jobs: {
      heldKinds: (types) => gate.heldKinds(types),
      regate: () => blockers.regate(),
      takeAdmissionBlock: (jobId) => gate.takeAdmissionBlock(jobId),
      blockTask: (job, blocker) => blockers.blockTask(job, blocker)
    },
    admission: { admit: gate.admit, backgroundDutyCycle: gate.dutyCycle },
    start: () => {
      if (unsubscribe) return;
      unsubscribe = power.subscribe(() => options.refreshLanes?.());
      power.start();
      blockers.start();
      // The stored controls replace the defaults as soon as they are read; the startup re-gate
      // reads them again before any worker claims.
      void controls
        .get()
        .catch((error: unknown) =>
          options.logger?.warn("The Knowledge controls could not be read", error)
        );
    },
    stop: () => {
      unsubscribe?.();
      unsubscribe = null;
      blockers.stop();
      power.stop();
    }
  };
}

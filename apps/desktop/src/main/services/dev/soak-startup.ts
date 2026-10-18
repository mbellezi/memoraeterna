import { mkdirSync } from "node:fs";
import { arch, platform, totalmem } from "node:os";
import { join } from "node:path";

import { setAiAdapterDecorator } from "@app/ai";
import type { PgPool } from "@app/db";

import type { AiService } from "../ai-service.js";
import { catalogHeaderPolicy } from "../catalog-header-policy.js";
import type { ConsultationService } from "../consultation-service.js";
import type { IngestionService } from "../ingestion-service.js";
import type { KnowledgeService } from "../knowledge-service.js";
import type { RelationExplanationService } from "../relation-explanation-service.js";
import {
  startFakeRemote,
  type FakeRemoteDeps,
  type FakeRemoteHandle
} from "./fake-remote-install.js";
import { parseBreakerLog, runSoak, type SoakOutcome } from "./soak-driver.js";
import { LocalFaultController } from "./soak-local-faults.js";
import {
  SoakKnobRefusal,
  fakeRemoteKnobName,
  readSoakKnob,
  soakKnobName,
  type SoakKnobEnvironment,
  type SoakKnobSettings
} from "./soak-plan.js";
import { createSoakPorts } from "./soak-ports.js";
import { fileEventSink, soakFiles } from "./soak-records.js";

/**
 * What `index.ts` needs of the soak (F3 T62): the two DEV knobs read once, the logger that notes the
 * circuit breaker moving, the local-fault decorators, the fake remote providers started before the
 * job supervisor, and the driver started once the models are up. The app calls these in that order;
 * with neither knob set, `prepareSoak` returns null and the app is untouched.
 */

export interface SoakPreparation {
  /** `soak`: fakes and driver; `fake-remote`: the fakes alone (a manual proof on a clone). */
  mode: "soak" | "fake-remote";
  /** Set `honourTreatAsRemote` on the AI service. */
  honourTreatAsRemote: true;
  /** The AI service's logger: console, and a note of every breaker transition for the report. */
  logger: Pick<Console, "error" | "info">;
  directory: string;
  /** Installs the GGUF abort decorator (before the first local adapter is registered). */
  installAdapterDecorator(): void;
  /** Puts the typing fault on the AI service's `runDefaultTask`. */
  attach(ai: AiService): void;
  startFakes(deps: Pick<FakeRemoteDeps, "pool" | "credentials" | "setAnswerRoute">): Promise<void>;
  startDriver(deps: SoakDriverDeps): Promise<SoakOutcome | null>;
  stop(): Promise<void>;
}

export interface SoakDriverDeps {
  pool: PgPool;
  ai: AiService;
  ingestion: IngestionService;
  knowledge: KnowledgeService;
  consultation: ConsultationService;
  explanations: RelationExplanationService;
  jobs: { wake(): void };
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/gu, "").slice(0, 15);
}

/**
 * Reads both knobs. Null when neither is set; throws a `SoakKnobRefusal` when one is set and may not
 * run (packaged, outside `.cache/profiles/`, with another measurement knob, the driver without the
 * fakes, two different plans).
 */
export function prepareSoak(
  options: SoakKnobEnvironment & {
    env: Readonly<Record<string, string | undefined>>;
    logger?: Pick<Console, "error" | "info">;
    now?: () => Date;
  }
): SoakPreparation | null {
  const fake = readSoakKnob(fakeRemoteKnobName, options.env, options);
  const soak = readSoakKnob(soakKnobName, options.env, options);
  if (!fake) return null;
  if (soak && (soak.planPath !== fake.planPath || soak.profileName !== fake.profileName))
    throw new SoakKnobRefusal(
      "invalidPlan",
      `${soakKnobName} and ${fakeRemoteKnobName} must name the same plan and profile`
    );
  const settings: SoakKnobSettings = soak ?? fake;
  const console_ = options.logger ?? console;
  const run =
    settings.run ??
    `${soak ? settings.profileName : "fake-remote"}-${stamp((options.now ?? (() => new Date()))())}`;
  const directory = join(options.workspaceRoot, ".cache", "f3", "soak", run);
  mkdirSync(directory, { recursive: true });
  const sink = fileEventSink(join(directory, soakFiles.events));
  const faults = new LocalFaultController(sink);
  let handle: FakeRemoteHandle | null = null;
  const abort = new AbortController();

  const logger: Pick<Console, "error" | "info"> = {
    error: (...args: unknown[]) => console_.error(...args),
    info: (...args: unknown[]) => {
      console_.info(...args);
      const event = typeof args[0] === "string" ? parseBreakerLog(args[0], Date.now()) : null;
      if (event) sink.append(event);
    }
  };

  return {
    mode: soak ? "soak" : "fake-remote",
    honourTreatAsRemote: true,
    logger,
    directory,
    installAdapterDecorator() {
      if (soak) setAiAdapterDecorator(faults.adapterDecorator);
    },
    attach(ai) {
      if (soak) ai.runDefaultTask = faults.withTypingFaults(ai.runDefaultTask.bind(ai));
    },
    async startFakes(deps) {
      handle = await startFakeRemote(settings.profile, {
        ...deps,
        sink,
        workspaceRoot: options.workspaceRoot,
        logger: console_
      });
    },
    async startDriver(deps) {
      if (!soak || !handle) return null;
      const ports = await createSoakPorts({
        profile: soak.profile,
        workspaceRoot: options.workspaceRoot,
        directory,
        pool: deps.pool,
        ai: deps.ai,
        ingestion: deps.ingestion,
        knowledge: deps.knowledge,
        consultation: deps.consultation,
        explanations: deps.explanations,
        faults,
        jobs: deps.jobs,
        logger: console_
      });
      const header = catalogHeaderPolicy(options.env);
      // The plan's hours start now, for the fakes as for the driver.
      handle.restartClock();
      return runSoak({
        profile: soak.profile,
        profileName: soak.profileName,
        run,
        directory,
        ports,
        sink,
        signal: abort.signal,
        logger: console_,
        meta: {
          host: {
            platform: platform(),
            arch: arch(),
            totalMemoryMb: Math.round(totalmem() / 1_048_576)
          },
          catalogHeader: { refresh: header.refresh, reason: header.reason },
          bounds: soak.profile.bounds,
          providers: handle.providers.map((provider) => ({
            provider: provider.provider,
            providerConfigId: provider.providerConfigId,
            baseUrl: provider.baseUrl
          }))
        }
      });
    },
    async stop() {
      abort.abort();
      await handle?.stop();
      await sink.flush();
    }
  };
}

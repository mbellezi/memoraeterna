import { mkdirSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { arch, platform, totalmem } from "node:os";
import { join } from "node:path";

import { setAiAdapterDecorator } from "@app/ai";
import {
  createAiConfigRepository,
  createSettingsRepository,
  type PgPool,
  type Queryable
} from "@app/db";
import {
  NoteDeciderModeSchema,
  defaultRemoteBudgetConfig,
  relationsConfig,
  relationsDeciderModeSettingKey,
  type BudgetSnapshot,
  type PriceTable
} from "@app/domain";

import type { ModelDownloadEvent } from "../../../shared/app-events.js";
import type { AiService } from "../ai-service.js";
import { catalogHeaderPolicy } from "../catalog-header-policy.js";
import type { ConsultationService } from "../consultation-service.js";
import type { IngestionService } from "../ingestion-service.js";
import type { KnowledgeService } from "../knowledge-service.js";
import type { DevPowerOverride } from "../gardener/power-signals.js";
import { parseDevPowerBlocks } from "../gardener/power-signals.js";
import type { RelationExplanationService } from "../relation-explanation-service.js";
import { ViewHistoryService } from "../view-history-service.js";
import { FetchFaultInjector } from "./fetch-fault-decorator.js";
import {
  startFakeRemote,
  type FakeRemoteDeps,
  type FakeRemoteHandle
} from "./fake-remote-install.js";
import { acquireSoakLock } from "./soak-data-root.js";
import { parseBreakerLog, runSoak, type SoakF4Runtime, type SoakOutcome } from "./soak-driver.js";
import { createSoakHooks } from "./soak-hooks.js";
import { LocalFaultController } from "./soak-local-faults.js";
import { createMoneyPort, soakPriceTable } from "./soak-money.js";
import {
  SoakKnobRefusal,
  fakeRemoteKnobName,
  readSoakKnob,
  soakKnobName,
  type SoakKnobEnvironment,
  type SoakKnobSettings
} from "./soak-plan.js";
import { expandWindows, fetchFaultPlanSchema } from "./soak-plan-f4.js";
import { createSoakPorts } from "./soak-ports.js";
import { decisionsOptInProblem, realWriterProblems } from "./soak-real-writer.js";
import { fileEventSink, soakFiles } from "./soak-records.js";
import { findRealRemoteReach, realRemoteProblem } from "./soak-routes.js";
import { HarnessTokenCap, composeAdapterDecorators } from "./soak-token-cap.js";
import { settleMs, WindowRunner, type ControlsChange, type WindowPorts } from "./soak-windows.js";
import { workerPredicateVersion } from "./soak-workers.js";

/**
 * What `index.ts` needs of the soak (F3 T62, F4 T89): the two DEV knobs read once, the logger that
 * notes the circuit breaker moving, the adapter decorators (the GGUF abort, the harness token cap),
 * the fault layer in front of the real Codex adapter, the fake remote providers started before the
 * job supervisor, and the driver started once the models are up. The app calls these in that order;
 * with neither knob set, `prepareSoak` returns null and the app is untouched.
 *
 * The 7-day soak (a plan profile with an `f4` section) runs the real Codex writer
 * (`MEMORA_SOAK_REAL_WRITER`) from a worktree outside the checkout (`MEMORA_SOAK_DATA_ROOT`): it
 * takes the data root's local-model lock for the run, checks the writer and the routes before
 * anything starts, and starts no fake provider (the money window starts its priced fake when it
 * opens).
 */

export interface SoakPreparation {
  /** `soak`: fakes and driver; `fake-remote`: the fakes alone (a manual proof on a clone). */
  mode: "soak" | "fake-remote";
  /** Set `honourTreatAsRemote` on the AI service. */
  honourTreatAsRemote: true;
  /** The AI service's logger: console, and a note of every breaker transition for the report. */
  logger: Pick<Console, "error" | "info">;
  directory: string;
  /** Installs the adapter decorators (before the first adapter is registered). */
  installAdapterDecorator(): void;
  /** Puts the typing fault on the AI service's `runDefaultTask`. */
  attach(ai: AiService): void;
  /**
   * The `fetch` the real Codex adapters take (the fault layer); undefined when the run injects none.
   * Pass it as the AI service's `codexFetch` option.
   */
  readonly codexFetch: typeof fetch | undefined;
  /**
   * The product's Codex daily background call cap while a window overrides it (E4 b); undefined
   * otherwise. Pass it as the RemoteBudget's `subscriptionDailyCalls` option.
   */
  readonly subscriptionDailyCalls: (() => number) | undefined;
  /** The price table with the money window's fake in it; the base table when the run has none. */
  priceTable(base: PriceTable): PriceTable;
  startFakes(deps: Pick<FakeRemoteDeps, "pool" | "credentials" | "setAnswerRoute">): Promise<void>;
  startDriver(deps: SoakDriverDeps): Promise<SoakOutcome | null>;
  stop(): Promise<void>;
}

/** What the F4 profile needs of the app besides F3's services. */
export interface SoakF4Deps {
  /** `topics.overview`: the overview of a topic page that opens (P0). */
  topicOverview(topicId: string): Promise<unknown>;
  /** Asks the topic engine for an audit pass of the tree now. */
  requestAudit(treeId: string): Promise<unknown>;
  controls: {
    update(change: ControlsChange): Promise<unknown>;
    current(): {
      autonomy: "off" | "suggest" | "auto";
      paused: boolean;
      onlyIdle: boolean;
      onlyOnAc: boolean;
      monthlyCapUsd: number;
    };
  };
  power: {
    setDevOverride(override: DevPowerOverride | null): void;
    snapshot(): { active: boolean; onBattery: boolean; overridden: boolean };
  };
  budget: {
    snapshot(): Promise<BudgetSnapshot>;
    continuePastPause(): Promise<unknown>;
  };
  /** Tells the budget's gates the cap or the meters moved (the relay of `index.ts`). */
  budgetChanged(): void;
  /** The Gardener's status service (T86); the 7-day soak is refused without it. */
  status: { snapshot(): unknown } | null;
  publishModelDownload?: (event: ModelDownloadEvent) => void;
  /** The credential service the money window's fake provider is saved through. */
  credentials: { save(secret: string, existingRef?: string | null): Promise<string> };
}

export interface SoakDriverDeps {
  pool: PgPool;
  ai: AiService;
  ingestion: IngestionService;
  knowledge: KnowledgeService;
  consultation: ConsultationService;
  explanations: RelationExplanationService;
  jobs: { wake(): void };
  /** F4 (the 7-day profile). */
  f4?: SoakF4Deps;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/gu, "").slice(0, 15);
}

/** The judge's decider mode as stored (`relations.deciderMode`), or null when none is. */
async function storedJudgeMode(db: Queryable): Promise<string | null> {
  const stored = NoteDeciderModeSchema.safeParse(
    await createSettingsRepository(db).get(relationsDeciderModeSettingKey)
  );
  return stored.success ? stored.data : null;
}

/**
 * Reads both knobs. Null when neither is set; throws a `SoakKnobRefusal` when one is set and may not
 * run (packaged, outside the soak's `profiles/`, with another measurement knob, the driver without
 * the fakes or the real writer, two different plans, the real writer without the soak).
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
  if (!fake && !soak) return null;
  if (fake && soak && (soak.planPath !== fake.planPath || soak.profileName !== fake.profileName))
    throw new SoakKnobRefusal(
      "invalidPlan",
      `${soakKnobName} and ${fakeRemoteKnobName} must name the same plan and profile`
    );
  const settings: SoakKnobSettings = (soak ?? fake)!;
  if (settings.realWriter && !soak)
    throw new SoakKnobRefusal(
      "realWriter",
      `MEMORA_SOAK_REAL_WRITER needs ${soakKnobName}: the real writer runs only under the soak's token cap`
    );
  const { profile, paths, realWriter } = settings;
  const f4Plan = profile.f4;
  // A fake-remote proof of a profile with no fake providers has nothing to start.
  if (!soak && !profile.remote)
    throw new SoakKnobRefusal(
      "invalidPlan",
      `The plan profile ${settings.profileName} has no fake remote providers`
    );
  const console_ = options.logger ?? console;
  const run =
    settings.run ??
    `${soak ? settings.profileName : "fake-remote"}-${stamp((options.now ?? (() => new Date()))())}`;
  const directory = paths.runDirectory(profile.runFolder, run);
  mkdirSync(directory, { recursive: true });
  const sink = fileEventSink(join(directory, soakFiles.events));
  const faults = new LocalFaultController(sink);
  let handle: FakeRemoteHandle | null = null;
  let releaseLock: (() => Promise<void>) | null = null;
  let money: ReturnType<typeof createMoneyPort> | null = null;
  const abort = new AbortController();

  const logger: Pick<Console, "error" | "info"> = {
    error: (...args: unknown[]) => console_.error(...args),
    info: (...args: unknown[]) => {
      console_.info(...args);
      const event = typeof args[0] === "string" ? parseBreakerLog(args[0], Date.now()) : null;
      if (event) sink.append(event);
    }
  };

  // F4: the token cap by reservation, the fault layer in front of the Codex adapter, the daily-cap override.
  const cap =
    soak && f4Plan
      ? new HarnessTokenCap({
          capTokens: f4Plan.codex.cap,
          sink,
          onExhausted: (snapshot) =>
            logger.error(
              `SOAK harness token cap reached: ${snapshot.spentTokens} spent of ${snapshot.capTokens}; the run ends inconclusive`
            )
        })
      : null;
  // Always in front of the real writer of a 7-day profile, faults or none: it tells the cap which
  // requests reached the provider, and admits each retry by reservation before it is forwarded.
  const injector =
    soak && f4Plan
      ? new FetchFaultInjector({
          plan: f4Plan.injection ?? fetchFaultPlanSchema.parse({}),
          seed: profile.seed,
          sink
        })
      : null;
  let dailyCap: number | undefined;
  let fakeDeps: Pick<FakeRemoteDeps, "pool" | "credentials" | "setAnswerRoute"> | null = null;

  return {
    mode: soak ? "soak" : "fake-remote",
    honourTreatAsRemote: true,
    logger,
    directory,
    codexFetch: injector?.fetch,
    subscriptionDailyCalls: f4Plan
      ? () => dailyCap ?? defaultRemoteBudgetConfig.subscriptionDailyCalls
      : undefined,
    priceTable: (base) => (soak && f4Plan?.money ? soakPriceTable(base, f4Plan.money) : base),
    installAdapterDecorator() {
      if (soak)
        setAiAdapterDecorator(
          composeAdapterDecorators(faults.adapterDecorator, cap?.adapterDecorator)
        );
    },
    attach(ai) {
      if (soak) ai.runDefaultTask = faults.withTypingFaults(ai.runDefaultTask.bind(ai));
    },
    async startFakes(deps) {
      fakeDeps = deps;
      if (soak && f4Plan && realWriter) {
        // The slot of the local models is the soak's for the whole run (D2).
        if (paths.external)
          releaseLock = await acquireSoakLock({
            path: paths.lockFile,
            owner: `soak:${settings.profileName}`,
            run
          });
        try {
          const problems = await realWriterProblems(deps.pool, realWriter);
          const optIn = await decisionsOptInProblem(deps.pool, settings.decisions !== null);
          if (optIn) problems.push(optIn);
          const fakeIds = (
            await deps.pool.query<{ id: string }>(
              "select id from ai_provider_configs where display_name like 'DEV fake %'"
            )
          ).rows.map((row) => row.id);
          // Only the Codex configuration the knob names may be reached; every other real provider is refused.
          const reachProblem = realRemoteProblem(
            await findRealRemoteReach(deps.pool, [...fakeIds, realWriter.providerConfigId])
          );
          if (reachProblem) problems.push(reachProblem);
          if (problems.length > 0) throw new Error(problems.join(" "));
        } catch (error) {
          // A refused start quits at once (app.exit skips the quit path): the slot goes back now.
          await releaseLock?.();
          releaseLock = null;
          throw error;
        }
      }
      if (profile.remote) {
        handle = await startFakeRemote(profile, {
          ...deps,
          sink,
          workspaceRoot: options.workspaceRoot,
          logger: console_,
          ...(realWriter ? { realWriterConfigId: realWriter.providerConfigId } : {})
        });
      }
    },
    async startDriver(deps) {
      if (!soak) return null;
      if (!f4Plan && !handle) return null;
      const f4Deps = deps.f4;
      if (f4Plan) {
        if (!f4Deps || !cap || !realWriter)
          throw new Error("The 7-day soak needs the F4 services of the app.");
        if (!f4Deps.status)
          throw new Error(
            "The 7-day soak checks the Gardener's status sentence: this build has no status service (T86)."
          );
      }
      const views = new ViewHistoryService({ getPool: () => deps.pool });
      const ports = await createSoakPorts({
        profile: soak.profile,
        workspaceRoot: options.workspaceRoot,
        corpusDirectory: paths.corpusDirectory,
        directory,
        pool: deps.pool,
        ai: deps.ai,
        ingestion: deps.ingestion,
        knowledge: deps.knowledge,
        consultation: deps.consultation,
        explanations: deps.explanations,
        faults,
        jobs: deps.jobs,
        logger: console_,
        ...(f4Plan && f4Deps && cap
          ? {
              f4: {
                pool: deps.pool,
                seed: soak.profile.seed,
                knowledge: deps.knowledge,
                topicOverview: (topicId: string) => f4Deps.topicOverview(topicId),
                recordTopicView: (input: { id: string; title: string }) =>
                  views.record({ kind: "topic", id: input.id, title: input.title }),
                requestAudit: (treeId: string) => f4Deps.requestAudit(treeId),
                jobs: deps.jobs,
                status: f4Deps.status,
                controls: f4Deps.controls,
                power: f4Deps.power,
                budget: f4Deps.budget,
                cap
              }
            }
          : {})
      });
      const header = catalogHeaderPolicy(options.env);

      let f4Runtime: SoakF4Runtime | undefined;
      let windowSpecs: ReturnType<typeof expandWindows> = [];
      if (f4Plan && f4Deps && cap) {
        windowSpecs = expandWindows(f4Plan, soak.profile.durationHours * 60);
        if (f4Plan.money && fakeDeps)
          money = createMoneyPort({
            pool: deps.pool,
            credentials: f4Deps.credentials,
            budget: f4Deps.budget,
            controls: f4Deps.controls,
            money: f4Plan.money,
            seed: soak.profile.seed,
            sink,
            jobs: deps.jobs,
            logger: console_
          });
        const windowPorts: WindowPorts = {
          lane: {
            start: (id, kind, durationMs) => {
              if (!injector) throw new Error("This run injects no faults in front of Codex.");
              injector.startWindow(id, kind, durationMs);
            },
            end: (id) => injector?.endWindow(id)
          },
          controls: {
            update: (change) => f4Deps.controls.update(change),
            autonomy: () => f4Deps.controls.current().autonomy
          },
          power: {
            setBlocks: (blocks) =>
              f4Deps.power.setDevOverride(
                blocks
                  ? { startedAt: Date.now(), blocks: parseDevPowerBlocks(blocks.join(",")) ?? [] }
                  : null
              )
          },
          codexDailyCap: {
            today: async () => {
              const budget = await f4Deps.budget.snapshot();
              return {
                calls: budget.calls.usedCalls + budget.calls.reservedCalls,
                day: budget.day
              };
            },
            set: (calls) => {
              dailyCap = calls ?? undefined;
              f4Deps.budgetChanged();
            }
          },
          hooks: createSoakHooks({
            pool: deps.pool,
            ...(f4Deps.publishModelDownload
              ? { publishModelDownload: f4Deps.publishModelDownload }
              : {}),
            logger: console_
          }),
          harnessCap: {
            lowerToSpentPlus: (calls) => cap.lowerToSpentPlus(calls),
            restore: () => cap.restore()
          },
          money
        };
        f4Runtime = {
          windows: new WindowRunner({
            ports: windowPorts,
            sink,
            clock: { now: () => Date.now() },
            logger: console_
          }),
          cap,
          lowerCap: (capTokens) => cap.lowerTo(capTokens, { command: "LOWER_CAP file" }),
          isExhausted: () => cap.isExhausted,
          // The DEV command that lowers the harness cap: a file named LOWER_CAP in the run folder
          // holding a number of tokens, or `spent+<calls>`; read every sample interval, then set aside.
          readCapCommand: async () => {
            const path = join(directory, "LOWER_CAP");
            let text: string;
            try {
              text = (await readFile(path, "utf8")).trim();
            } catch {
              return null;
            }
            await rename(path, `${path}.applied`).catch(() => undefined);
            const relative = /^spent\+(\d+(?:\.\d+)?)$/u.exec(text);
            if (relative)
              return (
                cap.snapshot().spentTokens +
                Math.round(Number(relative[1]) * cap.typicalEstimateTokens())
              );
            const tokens = Number(text);
            return Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : null;
          }
        };
      }

      // The plan's hours start now, for the fakes, the fault layer and the driver.
      handle?.restartClock();
      injector?.restartClock();

      const provider = realWriter
        ? ((await createAiConfigRepository(deps.pool).listProviders()).find(
            (entry) => entry.id === realWriter.providerConfigId
          ) ?? null)
        : null;
      return runSoak({
        profile: soak.profile,
        profileName: soak.profileName,
        run,
        directory,
        ports,
        sink,
        signal: abort.signal,
        logger: console_,
        ...(f4Runtime ? { f4: f4Runtime } : {}),
        meta: {
          host: {
            platform: platform(),
            arch: arch(),
            totalMemoryMb: Math.round(totalmem() / 1_048_576)
          },
          catalogHeader: { refresh: header.refresh, reason: header.reason },
          bounds: soak.profile.bounds,
          providers: [
            ...(handle?.providers ?? []).map((entry) => ({
              provider: entry.provider,
              providerConfigId: entry.providerConfigId,
              baseUrl: entry.baseUrl
            })),
            ...(provider
              ? [
                  {
                    provider: "openai-codex",
                    providerConfigId: provider.id,
                    baseUrl: provider.baseUrl ?? "https://chatgpt.com/backend-api/codex"
                  }
                ]
              : [])
          ],
          // The effective relations configuration: the knob that sets the neighbours is refused above.
          relations: {
            discoveryNeighbours: relationsConfig.discovery.neighbours,
            judgeMode: await storedJudgeMode(deps.pool).catch(() => null)
          },
          dataRoot: paths.external ? paths.cacheRoot : null,
          ...(provider && realWriter
            ? {
                realWriter: {
                  providerConfigId: realWriter.providerConfigId,
                  provider: provider.provider,
                  modelId:
                    typeof provider.metadata.modelId === "string" ? provider.metadata.modelId : null
                }
              }
            : {}),
          decisions: {
            admitted: settings.decisions !== null,
            capUsd: settings.decisions?.capUsd ?? null
          },
          ...(f4Plan
            ? {
                f4: {
                  codex: {
                    expected: f4Plan.codex.expected,
                    cap: f4Plan.codex.cap,
                    dropFromHour0: f4Plan.codex.dropFromHour0
                  },
                  windows: windowSpecs.map((window) => ({
                    id: window.id,
                    kind: window.kind,
                    startMinute: window.startMinute,
                    durationMinutes: window.durationMinutes,
                    ...(window.expect ? { expect: window.expect } : {}),
                    settleMinutes: settleMs(window, "start") / 60_000,
                    settleEndMinutes: settleMs(window, "end") / 60_000
                  })),
                  predicates: { workerStates: workerPredicateVersion }
                }
              }
            : {})
        }
      });
    },
    async stop() {
      abort.abort();
      await handle?.stop();
      await money?.stop();
      await sink.flush();
      await releaseLock?.();
    }
  };
}

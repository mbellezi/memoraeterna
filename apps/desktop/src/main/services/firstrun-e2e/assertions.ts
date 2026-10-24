// The verdict of the first-run Hybrid end-to-end test (F4 T90, exit criterion E6): a clean install
// in Hybrid places and connects the first note in at most ten minutes. Pure: the facts come from
// the runner and `facts.ts`; this file decides and renders.
import type { AiCassetteStats } from "@app/ai";
import { operationRouteKey, workloadClassRouteKey } from "@app/db";
import type { TopicsStatus } from "@app/domain";
import { generativeDecideOperations } from "@app/domain";

import type { FirstRunRankerState } from "../first-run-ranker.js";
import { formatDuration } from "../topics-e2e/assertions.js";
import type { StoreFacts } from "../topics-e2e/facts.js";
import type { IpcSummary } from "../topics-e2e/ipc-counters.js";
import type {
  FirstSourceConnection,
  HybridRouteFacts,
  ModelFacts,
  RelationFacts,
  SourceFacts
} from "./facts.js";
import type { ModelsMode } from "./models.js";
import type { StatusAtStalls } from "./timeline.js";
import type { SetupFacts } from "./setup.js";
import type { RecordedFirstRun } from "./config.js";

export { formatDuration };

/** The clock of one run (E6): milliseconds since T0, the download term D and the gate. */
export interface ClockFacts {
  t0: string;
  /** PostgreSQL start, migrations and service start: the app launch inside T1 - T0. */
  appLaunchMs: number;
  /** Named instants, as milliseconds since T0. */
  marks: Record<string, number>;
  /** T1, null when no note of the first source was in a named topic with a shown relation. */
  t1Ms: number | null;
  drainedMs: number | null;
  /** The download term: this run's own (a recording) or the recording's (a replay). */
  download: {
    source: "this run" | "the recording";
    criticalPathMs: number;
    setupMs: number | null;
    userMs: number | null;
    windowMs: number;
  };
  /** The two models' installs, as the events told them (milliseconds since T0). */
  installs: Array<{
    catalogId: string;
    requestedAtMs: number | null;
    readyAtMs: number | null;
    bytes: number;
  }>;
}

export interface FirstRunFacts {
  mode: "record" | "replay";
  synthetic: boolean;
  sources: { first: string; second: string };
  contentLanguage: string;
  writerKind: "codex" | "remote";
  ipc: IpcSummary;
  settingsCalls: { setup: number; user: number };
  /** The channels of the setup phase in the order they were called, and the order the fixture states. */
  setupChannels: string[];
  expectedSetupChannels: string[];
  cassette: Pick<
    AiCassetteStats,
    "mode" | "served" | "recorded" | "misses" | "liveTokens" | "timing" | "waitedMs"
  > & {
    byTask: AiCassetteStats["byTask"];
    missDetails: AiCassetteStats["missDetails"];
    maxLiveTokens: number | null;
  };
  setup: SetupFacts | null;
  hybrid: HybridRouteFacts;
  models: { embedding: ModelFacts; ranker: ModelFacts };
  modelSource: ModelsMode;
  firstRunRanker: FirstRunRankerState | null;
  /** `model.download` events the bus delivered, by model, and how each model's last one ended. */
  downloadEvents: Record<string, { delivered: number; last: string | null }>;
  clock: ClockFacts;
  connection: FirstSourceConnection | null;
  relations: RelationFacts;
  sourceFacts: SourceFacts[];
  blockedJobs: Record<string, number>;
  /** What the status said while a download held everything up; null when no status was wired. */
  statusAtStalls: StatusAtStalls | null;
  /** The self-test seeds its library and its relation; the live run imports and matches. */
  stoodIn: string[];
  stoppedBy:
    | "drain_timeout"
    | "cassette_miss"
    | "token_limit"
    | "model_failed"
    | "setup_failed"
    | "error"
    | null;
  errors: string[];
  engine: TopicsStatus | null;
  recorded: RecordedFirstRun | null;
  budgetMs: number;
}

export type FirstRunCheckId =
  | "settings"
  | "sequence"
  | "setup"
  | "hybrid"
  | "models"
  | "ranker"
  | "events"
  | "tree"
  | "placement"
  | "topics"
  | "names"
  | "unnamed"
  | "e1"
  | "status"
  | "waiting"
  | "t1"
  | "cassette"
  | "replay"
  | "lane"
  | "gate";

export interface FirstRunCheck {
  id: FirstRunCheckId;
  label: string;
  passed: boolean;
  detail: string;
}

export interface FirstRunReport {
  format: "memora-firstrun-e2e";
  version: 1;
  passed: boolean;
  mode: FirstRunFacts["mode"];
  synthetic: boolean;
  sources: FirstRunFacts["sources"];
  contentLanguage: string;
  checks: FirstRunCheck[];
  /** Reported, not gating. */
  reported: {
    notes: number;
    nonRootTopics: number;
    topicsWithNotes: number;
    sources: SourceFacts[];
    relations: RelationFacts;
    connection: FirstSourceConnection | null;
    fallbackNotes: number;
    endState: StoreFacts["endState"];
    clock: ClockFacts;
    /** T1 - T0, and with D added: the figure the gate reads. */
    t1MinusT0Ms: number | null;
    withDownloadMs: number | null;
    budgetMs: number;
    cassette: FirstRunFacts["cassette"];
    aiCalls: StoreFacts["aiCalls"];
    ipc: IpcSummary;
    hybrid: HybridRouteFacts;
    models: FirstRunFacts["models"];
    modelSource: ModelsMode;
    firstRunRanker: FirstRunRankerState | null;
    setup: SetupFacts | null;
    blockedJobs: Record<string, number>;
    statusAtStalls: StatusAtStalls | null;
    failedWork: string[];
    stoodIn: string[];
    engine: TopicsStatus | null;
  };
  errors: string[];
}

const label = (title: string | null) => (title ? `"${title}"` : "an unnamed topic");

const hybridClassRoutes = (): Array<[string, "writer" | "embedder" | "ranker"]> => [
  ["embedding", "embedder"],
  [workloadClassRouteKey("embed"), "embedder"],
  [workloadClassRouteKey("decide"), "ranker"],
  [workloadClassRouteKey("write-fast"), "writer"],
  [workloadClassRouteKey("write-quality"), "writer"],
  [workloadClassRouteKey("answer"), "writer"],
  ...generativeDecideOperations.map((operation): [string, "writer"] => [
    operationRouteKey(operation),
    "writer"
  ]),
  ["structured-output", "writer"]
];

export function evaluateFirstRun(store: StoreFacts, run: FirstRunFacts): FirstRunReport {
  const checks: FirstRunCheck[] = [];
  const check = (id: FirstRunCheckId, text: string, passed: boolean, detail: string): void =>
    void checks.push({ id, label: text, passed, detail });

  const withNotes = store.topics.filter((topic) => topic.notes > 0);
  const unnamed = store.topics.filter((topic) => topic.nameState === "unnamed" || !topic.title);
  const notLlm = withNotes.filter((topic) => topic.nameSource !== "llm");
  const wrongLanguage = withNotes.filter((topic) => topic.nameLanguage !== run.contentLanguage);

  // The user never opens Settings after the setup, with the counters proven alive.
  const productCalls = run.ipc.phases.user?.filter((entry) => entry.class === "product") ?? [];
  check(
    "settings",
    "0 calls to Settings IPC handlers after the first-run setup",
    run.settingsCalls.user === 0 && run.ipc.registered.settings > 0 && productCalls.length > 0,
    run.settingsCalls.user === 0
      ? `${run.ipc.registered.settings} Settings handlers wrapped, 0 called after the setup; ` +
          `${productCalls.reduce((total, entry) => total + entry.calls, 0)} product calls ` +
          `on ${productCalls.length} channels; the setup made ${run.settingsCalls.setup} Settings calls`
      : `${run.settingsCalls.user} Settings calls in the user phase: ` +
          (run.ipc.phases.user ?? [])
            .filter((entry) => entry.class === "settings")
            .map((entry) => `${entry.channel} x${entry.calls}`)
            .join(", ")
  );
  const sameSequence =
    run.setupChannels.length === run.expectedSetupChannels.length &&
    run.setupChannels.every((channel, index) => channel === run.expectedSetupChannels[index]);
  check(
    "sequence",
    "The setup made exactly the calls of the onboarding sequence, in order",
    sameSequence,
    sameSequence
      ? `${run.setupChannels.length} calls`
      : `expected ${run.expectedSetupChannels.length} calls, made ${run.setupChannels.length}; first difference at ${
          run.setupChannels.findIndex(
            (channel, index) => channel !== run.expectedSetupChannels[index]
          ) + 1 || Math.min(run.setupChannels.length, run.expectedSetupChannels.length) + 1
        }`
  );
  const tests = run.setup?.tests ?? [];
  const failedTests = tests.filter((test) => test.state !== "passed");
  check(
    "setup",
    "The Hybrid preset applied with nothing blocked and every class test passed",
    run.setup !== null &&
      run.setup.preset.applied &&
      run.setup.preset.blocked.length === 0 &&
      tests.length > 0 &&
      failedTests.length === 0,
    run.setup === null
      ? "the setup did not complete"
      : failedTests.length === 0
        ? `preset applied; ${tests.length} class tests passed (${tests.map((test) => `${test.route} ${test.ms ?? "?"} ms`).join(", ")})`
        : failedTests
            .map((test) => `${test.route} ${test.state}${test.error ? ` (${test.error})` : ""}`)
            .join("; ")
  );

  // The routes the preset and the first-run ranker left: local embedder, local ranker, remote writer.
  const wrong = hybridClassRoutes().filter(([key, role]) => run.hybrid.routes[key] !== role);
  const others = Object.entries(run.hybrid.routes).filter(([, role]) => role === "other");
  check(
    "hybrid",
    "Hybrid: the embedder and the ranker are local, the writer is remote, nothing points elsewhere",
    run.hybrid.preset === "hybrid" && wrong.length === 0 && others.length === 0,
    run.hybrid.preset !== "hybrid"
      ? `the stored setup is ${run.hybrid.preset ?? "empty"}, not hybrid`
      : wrong.length === 0 && others.length === 0
        ? `${Object.keys(run.hybrid.routes).length} routes: embedder ${count(run.hybrid.routes, "embedder")}, ranker ${count(run.hybrid.routes, "ranker")}, writer ${count(run.hybrid.routes, "writer")}`
        : [
            ...wrong.map(
              ([key, role]) =>
                `${key} routes to ${run.hybrid.routes[key] ?? "nothing"}, not to the ${role}`
            ),
            ...others.map(([key]) => `${key} routes to an unexpected model`)
          ]
            .slice(0, 6)
            .join("; ")
  );
  const { embedding, ranker } = run.models;
  const installed = embedding.installed && ranker.installed;
  check(
    "models",
    run.modelSource === "download"
      ? "Both first-run models were downloaded, verified and installed"
      : run.modelSource === "seed"
        ? "Both first-run models were installed from the seed folder with the real size and SHA-256 checks"
        : "Both first-run models were installed (the self-test simulates the install)",
    installed && ranker.validated,
    `${embedding.catalogId} ${embedding.status}${embedding.lastError ? ` (${embedding.lastError})` : ""}; ` +
      `${ranker.catalogId} ${ranker.status}, ${ranker.validated ? "validated for decide" : "not validated for decide"}` +
      `${ranker.lastError ? ` (${ranker.lastError})` : ""}`
  );
  check(
    "ranker",
    "The first-run ranker finished: validated and routed",
    run.firstRunRanker?.state === "ready" && run.firstRunRanker.catalogId === ranker.catalogId,
    run.firstRunRanker
      ? `${run.firstRunRanker.catalogId ?? "none"} ${run.firstRunRanker.state}${run.firstRunRanker.reason ? ` (${run.firstRunRanker.reason})` : ""}`
      : "the first-run ranker never started"
  );
  const heard = [embedding.catalogId, ranker.catalogId].map(
    (id) => [id, run.downloadEvents[id]] as const
  );
  check(
    "events",
    "The event bus delivered each model's install to its end (model.download)",
    heard.every(([, entry]) => (entry?.delivered ?? 0) > 0 && entry?.last === "ready"),
    heard
      .map(([id, entry]) => `${id}: ${entry?.delivered ?? 0} events, last ${entry?.last ?? "none"}`)
      .join("; ")
  );

  check(
    "tree",
    "An active tree exists on its own",
    store.activeTree !== null,
    store.activeTree
      ? `tree ${store.activeTree.id} at generation ${store.activeTree.generation}`
      : "there is no active topic tree"
  );
  check(
    "placement",
    "Every current note has one primary placement on a live topic",
    store.currentNotes > 0 && store.notesWithPrimary === store.currentNotes,
    `${store.notesWithPrimary} of ${store.currentNotes} current notes` +
      (store.notesWithoutPrimary.length > 0
        ? `; first without: ${store.notesWithoutPrimary.join(", ")}`
        : "")
  );
  check(
    "topics",
    "At least 2 non-root topics hold notes",
    withNotes.length >= 2,
    `${withNotes.length} of ${store.topics.length} non-root topics hold notes`
  );
  check(
    "names",
    `Every non-root topic with notes has an LLM name in ${run.contentLanguage}`,
    withNotes.length > 0 && notLlm.length === 0 && wrongLanguage.length === 0,
    withNotes.length === 0
      ? "no topic holds notes"
      : notLlm.length === 0 && wrongLanguage.length === 0
        ? `${withNotes.length} topics named by the LLM in ${run.contentLanguage}`
        : [
            ...notLlm.map(
              (topic) => `${label(topic.title)} is ${topic.nameSource ?? "unnamed"}, not llm`
            ),
            ...wrongLanguage.map(
              (topic) => `${label(topic.title)} is in ${topic.nameLanguage ?? "no language"}`
            )
          ]
            .slice(0, 5)
            .join("; ")
  );
  check(
    "unnamed",
    "0 unnamed non-root topics",
    store.topics.length > 0 && unnamed.length === 0,
    `${unnamed.length} of ${store.topics.length} non-root topics are unnamed`
  );
  const e1 = store.e1;
  check(
    "e1",
    "Reachability 100%, 0 orphans, 0 hard violations",
    e1 !== null && e1.reachability === 1 && e1.orphans.total === 0 && e1.hardViolations === 0,
    e1
      ? `${e1.reachable} of ${e1.items} items reachable; orphans ${e1.orphans.total} ` +
          `(topics ${e1.orphans.topics}, retired placements ${e1.orphans.retiredPlacements}, unplaced ${e1.orphans.unplaced}); ` +
          `hard violations ${e1.hardViolations}` +
          (e1.hardReasons.length > 0 ? ` (${e1.hardReasons.slice(0, 3).join("; ")})` : "")
      : "the tree could not be read"
  );
  // E5 on the first run: while the run waited for a download, the status said why.
  if (run.statusAtStalls) {
    const status = run.statusAtStalls;
    check(
      "status",
      "While the run waited for a download, a Gardener task that waited always had a sentence naming why (E5 (i))",
      status.unexplained === 0,
      status.stalls === 0
        ? "no moment of waiting was read"
        : `${status.stalls} readings of a wait: ${Object.entries(status.classes)
            .map(([name, n]) => `${name} ${n}`)
            .join(
              ", "
            )}${status.quiet > 0 ? `; ${status.quiet} with no Gardener task waiting` : ""}${
            status.unexplained > 0 ? `; ${status.unexplained} said nothing was wrong` : ""
          }`
    );
  }
  // With the ranker validated before the topics are released, no note should wait for the gate.
  check(
    "waiting",
    "No note waits for the gate: the ranker decided",
    store.fallback.waitingNotes === 0,
    `${store.fallback.waitingNotes} notes wait with needs_gate; the no-decider fallback decided ` +
      `${store.fallback.notes} notes (${store.root.fallbackNone} at the root)`
  );

  const connection = run.connection;
  check(
    "t1",
    "T1: a note of the first source sits in a named topic with a shown relation",
    connection !== null && run.clock.t1Ms !== null,
    connection
      ? `${label(connection.noteTitle)} in ${label(connection.topicTitle)} with a shown relation (${connection.relationState})` +
          `${connection.crossSource ? " to the other source" : " inside its own source"}; ` +
          `${run.relations.shown} relations shown, ${run.relations.betweenSources} between the sources`
      : `no such note; ${run.relations.shown} relations shown, ${run.relations.betweenSources} between the sources`
  );

  const cassette = run.cassette;
  check(
    "cassette",
    run.mode === "replay"
      ? "The replay is served from the cassette with 0 misses"
      : "The recording made its calls through the cassette",
    run.mode === "replay"
      ? cassette.misses === 0 && cassette.served > 0 && cassette.recorded === 0
      : cassette.recorded + cassette.served > 0,
    run.mode === "replay"
      ? `${cassette.served} calls served, ${cassette.misses} misses` +
          (cassette.missDetails.length > 0
            ? ` (first: ${cassette.missDetails[0]!.taskType} ${cassette.missDetails[0]!.key.slice(0, 12)}, request in ${cassette.missDetails[0]!.requestPath})`
            : "")
      : `${cassette.recorded} calls recorded, ${cassette.served} served from earlier takes, ` +
          `${cassette.liveTokens} live tokens of ${cassette.maxLiveTokens ?? "no"} cap`
  );
  if (run.recorded) {
    const same =
      run.recorded.result.notes === store.currentNotes &&
      run.recorded.result.topics === store.topics.length &&
      run.recorded.result.noteRelations === store.endState.noteRelations &&
      run.recorded.result.digest === store.endState.digest;
    check(
      "replay",
      "The replay reproduces the recording (same notes, topics and relations as content)",
      same,
      `${store.currentNotes} notes, ${store.topics.length} topics, ${store.endState.noteRelations} relations; ` +
        `the recording made ${run.recorded.result.notes}, ${run.recorded.result.topics} and ${run.recorded.result.noteRelations}` +
        (same
          ? "; same digest"
          : run.recorded.result.digest === store.endState.digest
            ? ""
            : "; the digests differ")
    );
  }
  const failedTopicJobs = store.failedJobs.filter((row) => row.type.startsWith("topic-"));
  const failedOtherJobs = store.failedJobs.filter((row) => !row.type.startsWith("topic-"));
  const failedRuns = store.ingestionRuns.filter((row) => row.status !== "succeeded");
  check(
    "lane",
    "Both imports and the light lane finished in time without failed topic work",
    run.stoppedBy === null && run.errors.length === 0 && failedTopicJobs.length === 0,
    run.stoppedBy !== null
      ? `stopped by ${run.stoppedBy}`
      : [
          ...failedTopicJobs.map((row) => `${row.count} failed ${row.type} jobs`),
          ...run.errors
        ].join("; ") || "drained"
  );

  // The gate: a replay on the final code plus the live record's download term, from app launch.
  const t1MinusT0 = run.clock.t1Ms;
  const withDownload = t1MinusT0 === null ? null : t1MinusT0 + run.clock.download.criticalPathMs;
  if (run.mode === "replay") {
    const timed = run.cassette.timing === "recorded";
    const live = run.recorded?.timing.live !== false;
    check(
      "gate",
      `T1 - T0 plus D is at most ${formatDuration(run.budgetMs)} (recorded timing, from app launch)`,
      timed && live && withDownload !== null && withDownload <= run.budgetMs,
      withDownload === null
        ? "T1 was not reached"
        : `${formatDuration(t1MinusT0)} + D ${formatDuration(run.clock.download.criticalPathMs)} = ` +
            `${formatDuration(withDownload)}${timed ? "" : "; the replay ran without recorded timing, so this is not E6's clock"}` +
            `${live ? "" : "; the recording was resumed from an earlier take, so its D is not a live figure"}`
    );
  }

  const failedWork = [
    ...failedRuns.map((row) => `${row.count} ingestion runs ${row.status}`),
    ...(store.failedStages > 0 ? [`${store.failedStages} failed stages`] : []),
    ...failedOtherJobs.map((row) => `${row.count} failed ${row.type} jobs`),
    ...(run.mode === "record"
      ? store.aiCalls
          .filter((row) => row.status !== "succeeded")
          .map(
            (row) =>
              `${row.count} ${row.taskType} AI calls ${row.status} (no cassette entry: a replay misses on them)`
          )
      : [])
  ];

  return {
    format: "memora-firstrun-e2e",
    version: 1,
    passed: checks.every((entry) => entry.passed),
    mode: run.mode,
    synthetic: run.synthetic,
    sources: run.sources,
    contentLanguage: run.contentLanguage,
    checks,
    reported: {
      notes: store.currentNotes,
      nonRootTopics: store.topics.length,
      topicsWithNotes: withNotes.length,
      sources: run.sourceFacts,
      relations: run.relations,
      connection,
      fallbackNotes: store.fallback.notes,
      endState: store.endState,
      clock: run.clock,
      t1MinusT0Ms: t1MinusT0,
      withDownloadMs: withDownload,
      budgetMs: run.budgetMs,
      cassette: run.cassette,
      aiCalls: store.aiCalls,
      ipc: run.ipc,
      hybrid: run.hybrid,
      models: run.models,
      modelSource: run.modelSource,
      firstRunRanker: run.firstRunRanker,
      setup: run.setup,
      blockedJobs: run.blockedJobs,
      statusAtStalls: run.statusAtStalls,
      failedWork,
      stoodIn: run.stoodIn,
      engine: run.engine
    },
    errors: run.errors
  };
}

function count(routes: Readonly<Record<string, string>>, role: string): number {
  return Object.values(routes).filter((entry) => entry === role).length;
}

export function renderFirstRunMarkdown(report: FirstRunReport, store: StoreFacts): string {
  const r = report.reported;
  const clock = r.clock;
  const lines = [
    `# First-run Hybrid end-to-end test (E6): ${report.passed ? "PASSED" : "FAILED"}`,
    "",
    `Mode ${report.mode}${report.synthetic ? " (synthetic self-test)" : ""}, sources ${report.sources.first} then ${report.sources.second}, content language ${report.contentLanguage}.`,
    "",
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...report.checks.map(
      (entry) => `| ${entry.label} | ${entry.passed ? "pass" : "FAIL"} | ${entry.detail} |`
    ),
    "",
    "## The clock (E6)",
    "",
    `- T0 is the app launch on an empty userData (${formatDuration(clock.appLaunchMs)} for the database, the migrations and the services).`,
    `- T1 (a note of the first source in a named topic with a shown relation): ${formatDuration(clock.t1Ms)} after T0; the light lane drained at ${formatDuration(clock.drainedMs)}.`,
    `- D, the download term ${clock.download.source === "the recording" ? "of the live record" : "of this run"}: ${formatDuration(clock.download.criticalPathMs)} on the critical path` +
      `${clock.download.setupMs === null ? "" : ` (${formatDuration(clock.download.setupMs)} in the setup, ${formatDuration(clock.download.userMs)} after it)`}; ` +
      `the downloads took ${formatDuration(clock.download.windowMs)} from the first request to the last model ready.`,
    `- T1 - T0 + D = ${formatDuration(r.withDownloadMs)} against ${formatDuration(r.budgetMs)}.`,
    "",
    "| Step | At |",
    "| --- | --- |",
    ...Object.entries(clock.marks).map(([name, ms]) => `| ${name} | ${formatDuration(ms)} |`),
    "",
    "## Models",
    "",
    ...clock.installs.map(
      (install) =>
        `- ${install.catalogId}: requested ${formatDuration(install.requestedAtMs)}, ready ${formatDuration(install.readyAtMs)}, ${install.bytes} bytes (${r.modelSource}).`
    ),
    `- First-run ranker: ${r.firstRunRanker ? `${r.firstRunRanker.catalogId ?? "none"} ${r.firstRunRanker.state}` : "not started"}.`,
    "",
    "## Library",
    "",
    `- Notes ${r.notes}; non-root topics ${r.nonRootTopics}, ${r.topicsWithNotes} hold notes; fallback decisions on ${r.fallbackNotes} notes.`,
    ...r.sources.map((source) => `- ${source.title}: ${source.notes} notes.`),
    `- Relations shown: ${r.relations.shown} (${
      Object.entries(r.relations.byState)
        .map(([state, n]) => `${state} ${n}`)
        .join(", ") || "none"
    }), ${r.relations.betweenSources} between the two sources.`,
    `- End state: ${r.endState.noteRelations} note relations, ${r.endState.sourceRelations} source relations; digest ${r.endState.digest.slice(0, 16)} (two replays of one recording share it).`,
    `- Failed work outside the topics: ${r.failedWork.length > 0 ? r.failedWork.join("; ") : "none"}.`,
    ...(r.statusAtStalls
      ? [
          `- Status while the run waited for a download: ${r.statusAtStalls.stalls} readings, ${
            Object.entries(r.statusAtStalls.classes)
              .map(([name, n]) => `${name} ${n}`)
              .join(", ") || "none"
          }, ${r.statusAtStalls.unexplained} unexplained.`
        ]
      : []),
    `- Jobs a blocker still holds: ${
      Object.entries(r.blockedJobs)
        .map(([blocker, n]) => `${blocker} ${n}`)
        .join(", ") || "none"
    }.`,
    `- AI cassette ${r.cassette.mode}${r.cassette.timing ? ` with ${r.cassette.timing} timing (waited ${formatDuration(r.cassette.waitedMs ?? 0)} in all)` : ""}: ` +
      `${r.cassette.served} served, ${r.cassette.recorded} recorded, ${r.cassette.misses} misses, ${r.cassette.liveTokens} live tokens.`,
    `- Engine status: ${
      r.engine
        ? `${r.engine.phase}${r.engine.blocked ? ` (${r.engine.blocked})` : ""}, ${r.engine.counts.placed} of ${r.engine.counts.items} items placed, ${r.engine.counts.needsGate} waiting for the gate`
        : "not read"
    }.`,
    ...(r.stoodIn.length > 0 ? ["", `Stood in by the self-test: ${r.stoodIn.join("; ")}.`] : []),
    "",
    "## Topics",
    "",
    "| Topic | Name source | Language | Notes |",
    "| --- | --- | --- | --- |",
    ...store.topics.map(
      (topic) =>
        `| ${topic.title ?? "(unnamed)"} | ${topic.nameSource ?? "-"} | ${topic.nameLanguage ?? "-"} | ${topic.notes} |`
    ),
    "",
    "## IPC calls",
    ""
  ];
  for (const [phase, entries] of Object.entries(r.ipc.phases)) {
    lines.push(`### ${phase}`, "");
    for (const entry of entries) lines.push(`- ${entry.class} ${entry.channel} x${entry.calls}`);
    lines.push("");
  }
  lines.push(
    `Handlers wrapped: ${r.ipc.registered.settings} Settings, ${r.ipc.registered.product} product.`
  );
  if (report.errors.length > 0)
    lines.push("", "## Errors", "", ...report.errors.map((e) => `- ${e}`));
  return `${lines.join("\n")}\n`;
}

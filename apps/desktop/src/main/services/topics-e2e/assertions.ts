// The verdict of the zero-config end-to-end test (F2 T32, exit criterion E6, spec section 8):
// an empty database, one model and one PDF give notes in named topics without opening Settings.
// Pure: the facts come from `facts.ts` and the runner; this file decides and renders.
import type { AiCassetteStats } from "@app/ai";
import type { TopicsStatus } from "@app/domain";

import type { IpcSummary } from "./ipc-counters.js";
import type { StoreFacts } from "./facts.js";

export interface RunFacts {
  mode: "record" | "replay";
  source: string;
  contentLanguage: string;
  /** Settings channels wrapped, and the calls made in the setup and in the user phase. */
  ipc: IpcSummary;
  settingsCalls: { setup: number; user: number };
  cassette: Pick<AiCassetteStats, "mode" | "served" | "recorded" | "misses" | "liveTokens"> & {
    byTask: AiCassetteStats["byTask"];
    missDetails: AiCassetteStats["missDetails"];
    maxLiveTokens: number | null;
  };
  /** The setup seeded these routes (task or class route key to the profile it points at). */
  routes: Record<string, string>;
  timing: {
    importStartedAt: Date;
    heavyDoneAt: Date | null;
    drainedAt: Date | null;
  };
  /** The light lane did not drain within its budget, or the run stopped early. */
  stoppedBy: "drain_timeout" | "cassette_miss" | "token_limit" | "error" | null;
  /** What the run reports besides the checks; empty when nothing went wrong. */
  errors: string[];
  /** `topics.status` as the screens read it once the lane drained; null when the run stopped before. */
  engine: TopicsStatus | null;
  /** Notes and topics the recording produced; a replay must produce the same. */
  recorded: { notes: number; topics: number } | null;
}

export interface E6Check {
  id:
    | "settings"
    | "tree"
    | "placement"
    | "topics"
    | "names"
    | "unnamed"
    | "e1"
    | "cassette"
    | "replay"
    | "lane";
  label: string;
  passed: boolean;
  detail: string;
}

export interface E6Report {
  format: "memora-topics-e2e";
  version: 1;
  passed: boolean;
  mode: RunFacts["mode"];
  source: string;
  contentLanguage: string;
  checks: E6Check[];
  /** Reported, not gating. */
  reported: {
    notes: number;
    nonRootTopics: number;
    topicsWithNotes: number;
    rootDirectNotes: number;
    rootNeedsGate: number;
    /** D27: notes at the root or waiting at an internal topic, over the expected items. */
    unsortedShare: number;
    needsVectorItems: number;
    importToNamedMs: number | null;
    importToHeavyDoneMs: number | null;
    importToDrainedMs: number | null;
    cassette: RunFacts["cassette"];
    aiCalls: StoreFacts["aiCalls"];
    ipc: IpcSummary;
    routes: Record<string, string>;
    engine: TopicsStatus | null;
  };
  errors: string[];
}

const share = (value: number) => `${(value * 100).toFixed(1)}%`;

/** `m:ss` for a duration, `n/a` for one that was not reached. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "n/a";
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function between(from: Date, to: Date | null): number | null {
  return to === null ? null : Math.max(0, to.getTime() - from.getTime());
}

export function evaluateE6(store: StoreFacts, run: RunFacts): E6Report {
  const checks: E6Check[] = [];
  const check = (id: E6Check["id"], label: string, passed: boolean, detail: string): void =>
    void checks.push({ id, label, passed, detail });

  const withNotes = store.topics.filter((topic) => topic.notes > 0);
  const unnamed = store.topics.filter((topic) => topic.nameState === "unnamed" || !topic.title);
  const notLlm = withNotes.filter((topic) => topic.nameSource !== "llm");
  const wrongLanguage = withNotes.filter((topic) => topic.nameLanguage !== run.contentLanguage);

  // 0 calls to Settings handlers, with the counters proven alive (handlers wrapped, product calls made).
  const productCalls = run.ipc.phases.user?.filter((entry) => entry.class === "product") ?? [];
  check(
    "settings",
    "0 calls to Settings IPC handlers after the first-run setup",
    run.settingsCalls.user === 0 && run.ipc.registered.settings > 0 && productCalls.length > 0,
    run.settingsCalls.user === 0
      ? `${run.ipc.registered.settings} Settings handlers wrapped, 0 called; ` +
          `${productCalls.reduce((total, entry) => total + entry.calls, 0)} product calls ` +
          `on ${productCalls.length} channels; the setup made ${run.settingsCalls.setup} Settings calls`
      : `${run.settingsCalls.user} Settings calls in the user phase: ` +
          (run.ipc.phases.user ?? [])
            .filter((entry) => entry.class === "settings")
            .map((entry) => `${entry.channel} x${entry.calls}`)
            .join(", ")
  );
  check(
    "tree",
    "An active tree exists on its own and the profile has no legacy content",
    store.activeTree !== null && store.legacyRows === 0,
    store.activeTree
      ? `tree ${store.activeTree.id} at generation ${store.activeTree.generation}; legacy rows ${store.legacyRows}`
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
    "E1: reachability 100%, 0 orphans, 0 hard violations",
    e1 !== null && e1.reachability === 1 && e1.orphans.total === 0 && e1.hardViolations === 0,
    e1
      ? `${e1.reachable} of ${e1.items} items reachable; orphans ${e1.orphans.total} ` +
          `(topics ${e1.orphans.topics}, retired placements ${e1.orphans.retiredPlacements}, ` +
          `unplaced ${e1.orphans.unplaced}); hard violations ${e1.hardViolations}` +
          (e1.hardReasons.length > 0 ? ` (${e1.hardReasons.slice(0, 3).join("; ")})` : "")
      : "the tree could not be read"
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
    check(
      "replay",
      "The replay reproduces the recording (same notes and topics)",
      run.recorded.notes === store.currentNotes && run.recorded.topics === store.topics.length,
      `${store.currentNotes} notes and ${store.topics.length} topics; the recording made ` +
        `${run.recorded.notes} notes and ${run.recorded.topics} topics`
    );
  }
  const failedRuns = store.ingestionRuns.filter((row) => row.status !== "succeeded");
  check(
    "lane",
    "The import and the light lane finished in time without failed work",
    run.stoppedBy === null &&
      run.errors.length === 0 &&
      failedRuns.length === 0 &&
      store.failedStages === 0 &&
      store.failedJobs.length === 0,
    run.stoppedBy !== null
      ? `stopped by ${run.stoppedBy}`
      : [
          ...failedRuns.map((row) => `${row.count} ingestion runs ${row.status}`),
          ...(store.failedStages > 0 ? [`${store.failedStages} failed stages`] : []),
          ...store.failedJobs.map((row) => `${row.count} failed ${row.type} jobs`),
          ...run.errors
        ].join("; ") || "drained"
  );

  return {
    format: "memora-topics-e2e",
    version: 1,
    passed: checks.every((entry) => entry.passed),
    mode: run.mode,
    source: run.source,
    contentLanguage: run.contentLanguage,
    checks,
    reported: {
      notes: store.currentNotes,
      nonRootTopics: store.topics.length,
      topicsWithNotes: withNotes.length,
      rootDirectNotes: store.root.directNotes,
      rootNeedsGate: store.root.needsGate,
      unsortedShare: e1?.unsortedShare ?? 0,
      needsVectorItems: e1?.needsVectorItems ?? 0,
      importToNamedMs: between(run.timing.importStartedAt, store.lastNamedAt),
      importToHeavyDoneMs: between(run.timing.importStartedAt, run.timing.heavyDoneAt),
      importToDrainedMs: between(run.timing.importStartedAt, run.timing.drainedAt),
      cassette: run.cassette,
      aiCalls: store.aiCalls,
      ipc: run.ipc,
      routes: run.routes,
      engine: run.engine
    },
    errors: run.errors
  };
}

const label = (title: string | null) => (title ? `"${title}"` : "an unnamed topic");

export function renderE6Markdown(report: E6Report, store: StoreFacts): string {
  const r = report.reported;
  const lines = [
    `# Zero-config end-to-end test (E6): ${report.passed ? "PASSED" : "FAILED"}`,
    "",
    `Mode ${report.mode}, source ${report.source}, content language ${report.contentLanguage}.`,
    "",
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...report.checks.map(
      (entry) => `| ${entry.label} | ${entry.passed ? "pass" : "FAIL"} | ${entry.detail} |`
    ),
    "",
    "## Reported",
    "",
    `- Notes ${r.notes}; non-root topics ${r.nonRootTopics}, ${r.topicsWithNotes} hold notes.`,
    `- Notes left at the root (Unsorted, \`needs_gate\` without a ranker): ${r.rootDirectNotes} ` +
      `(${r.rootNeedsGate} waiting for the gate), ${share(r.rootDirectNotes / Math.max(1, r.notes))} of the notes; ` +
      `Unsorted share (D27, notes and root sources) ${share(r.unsortedShare)}; \`needs_vector\` items ${r.needsVectorItems}.`,
    `- Import start to named topics ${formatDuration(r.importToNamedMs)}; to the end of the heavy work ` +
      `${formatDuration(r.importToHeavyDoneMs)}; to a drained light lane ${formatDuration(r.importToDrainedMs)} (m:ss).`,
    `- AI cassette ${r.cassette.mode}: ${r.cassette.served} served, ${r.cassette.recorded} recorded, ` +
      `${r.cassette.misses} misses, ${r.cassette.liveTokens} live tokens.`,
    `- Engine status: ${
      r.engine
        ? `${r.engine.phase}${r.engine.blocked ? ` (${r.engine.blocked})` : ""}, ${r.engine.counts.placed} of ${r.engine.counts.items} items placed, ${r.engine.counts.needsGate} waiting for the gate`
        : "not read"
    }.`,
    `- Routes seeded by the setup: ${
      Object.entries(r.routes)
        .map(([route, profile]) => `${route} -> ${profile}`)
        .join(", ") || "none"
    }.`,
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

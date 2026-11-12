import type { MessageKey } from "@app/i18n";

import type { LibrarySourceProgress } from "../../../../shared/ipc-library";

/**
 * The live generation strip of the Source panel as a model (design record 6.2): which of the seven
 * forms it takes, the six steps with their words, and the section ruler. It is a pure function of
 * `library.sourceProgress` and the time of the read, so every rule is tested without a renderer.
 * Nothing here reads a clock: `now` is the instant the answer was read, and a time left is worked
 * out from what the run has done so far, never invented (no value, no sentence).
 */

export type StripKind =
  /** Work is under way: header, steps and ruler. */
  | "running"
  /** The run finished: one line. */
  | "done"
  /** Stored and searchable on purpose (the mode "Pesquisável e organizado"): one line and "Gerar notas". */
  | "searchable"
  /** A step failed or the run stopped. */
  | "error"
  /** Work waits for the person (a model to choose). */
  | "needsYou"
  /** The person paused the work. */
  | "paused"
  /** Nothing ever ran and nothing waits: no strip. */
  | "none";

export type StripStepId = "read" | "chunks" | "notes" | "placed" | "summary" | "relations";
export type StripStepState = "done" | "running" | "pending" | "failed" | "notApplicable";

/** A sentence of the catalog with its variable parts: keys never hold a number or a name. */
export interface StripMessage {
  key: MessageKey;
  values?: Readonly<Record<string, string | number>>;
}

export interface StripStep {
  id: StripStepId;
  state: StripStepState;
  label: MessageKey;
  /** What the step has done, or when it will; absent when there is nothing true to say. */
  value: StripMessage | null;
}

export type RulerState = "done" | "reading" | "pending";

export interface StripSection {
  title: string;
  /** Percent of the ruler's width, from the section's share of the text. */
  widthPct: number;
  state: RulerState;
  notes: number;
}

export interface StripModel {
  kind: StripKind;
  steps: StripStep[];
  /** One segment per section; empty when fewer than two (a single segment says nothing). */
  sections: StripSection[];
  /** The run's start, for "desde 09:12". */
  startedAt: string | null;
  /** Milliseconds the run still needs, worked out from its pace; null when that is not known. */
  remainingMs: number | null;
  /** Milliseconds the finished run took. */
  tookMs: number | null;
  /** "Já dá para perguntar": the passages are indexed. */
  canAsk: boolean;
  /** The stage that failed (a name, never raw error text). */
  failedStage: string | null;
  /** The blocker key when the work waits for a person. */
  blocker: string | null;
  notes: number;
  relations: number;
  indexed: number;
  /** A step that gives a note or a connection is still to come, so the notes list expects more. */
  expectsNotes: boolean;
}

const stepLabels: Record<StripStepId, MessageKey> = {
  read: "sourcePage.strip.steps.read",
  chunks: "sourcePage.strip.steps.chunks",
  notes: "sourcePage.strip.steps.notes",
  placed: "sourcePage.strip.steps.placed",
  summary: "sourcePage.strip.steps.summary",
  relations: "sourcePage.strip.steps.relations"
};

const count = (one: MessageKey, many: MessageKey, n: number, extra = {}): StripMessage =>
  n === 1
    ? { key: one, values: { count: n, ...extra } }
    : { key: many, values: { count: n, ...extra } };

type Steps = NonNullable<LibrarySourceProgress>["steps"];

function stepValues(steps: Steps): Record<StripStepId, StripMessage | null> {
  const later: StripMessage = { key: "sourcePage.strip.values.afterNotes" };
  const waiting: StripMessage = { key: "sourcePage.strip.values.waiting" };
  const notApplicable: StripMessage = { key: "sourcePage.strip.values.notApplicable" };
  const pick = (
    state: StripStepState,
    active: StripMessage | null,
    pending: StripMessage | null
  ) => (state === "notApplicable" ? notApplicable : state === "pending" ? pending : active);

  const read = pick(
    steps.read.state,
    steps.read.pages !== null
      ? count("sourcePage.strip.values.pagesOne", "sourcePage.strip.values.pages", steps.read.pages)
      : {
          key:
            steps.read.state === "done"
              ? "sourcePage.strip.values.readDone"
              : "sourcePage.strip.values.reading"
        },
    waiting
  );
  const chunks = pick(
    steps.chunks.state,
    steps.chunks.indexed > 0
      ? count(
          "sourcePage.strip.values.searchableOne",
          "sourcePage.strip.values.searchable",
          steps.chunks.indexed
        )
      : null,
    waiting
  );
  const notesActive =
    steps.notes.state === "running"
      ? steps.notes.soFar > 0 && steps.notes.estimate !== null
        ? ({
            key: "sourcePage.strip.values.notesOfEstimate",
            values: { count: steps.notes.soFar, estimate: steps.notes.estimate }
          } satisfies StripMessage)
        : steps.notes.soFar > 0
          ? count(
              "sourcePage.strip.values.notesSoFarOne",
              "sourcePage.strip.values.notesSoFar",
              steps.notes.soFar
            )
          : ({ key: "sourcePage.strip.values.writing" } satisfies StripMessage)
      : count(
          "sourcePage.strip.values.notesDoneOne",
          "sourcePage.strip.values.notesDone",
          steps.notes.soFar
        );
  const notes = pick(steps.notes.state, notesActive, waiting);
  const placed = pick(
    steps.placed.state,
    count(
      "sourcePage.strip.values.placedOne",
      "sourcePage.strip.values.placed",
      steps.placed.count
    ),
    later
  );
  const summary = pick(
    steps.summary.state,
    {
      key:
        steps.summary.state === "done"
          ? "sourcePage.strip.values.summaryDone"
          : "sourcePage.strip.values.writing"
    },
    later
  );
  const relations = pick(
    steps.relations.state,
    steps.relations.state === "done"
      ? count(
          "sourcePage.strip.values.relationsDoneOne",
          "sourcePage.strip.values.relationsDone",
          steps.relations.count
        )
      : { key: "sourcePage.strip.values.searching" },
    later
  );
  return { read, chunks, notes, placed, summary, relations };
}

/** The ruler: one segment per section, widths from the shares; fewer than two segments draw nothing. */
export function rulerSections(progress: NonNullable<LibrarySourceProgress>): StripSection[] {
  if (progress.sections.length < 2) return [];
  return progress.sections.map((section) => ({
    title: section.title,
    widthPct: Math.round(section.share * 1000) / 10,
    state: section.state,
    notes: section.notes
  }));
}

/**
 * About how long the run still needs, from its pace: the time since it started divided by the notes
 * written so far, times the notes still to come. Unknown (null) without a start, an estimate of the
 * notes, a first note, or while the estimate has already been passed.
 */
export function remainingMs(
  progress: NonNullable<LibrarySourceProgress>,
  now: number
): number | null {
  const { run, steps } = progress;
  if (!run || run.startedAt === null || steps.notes.state !== "running") return null;
  const { soFar, estimate } = steps.notes;
  if (estimate === null || soFar <= 0 || soFar >= estimate) return null;
  const elapsed = now - Date.parse(run.startedAt);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null;
  return Math.round((elapsed / soFar) * (estimate - soFar));
}

/** Minutes shown for a duration, never below one. */
export const minutesOf = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

export function stripModel(
  progress: LibrarySourceProgress | null | undefined,
  now: number
): StripModel {
  const base: StripModel = {
    kind: "none",
    steps: [],
    sections: [],
    startedAt: null,
    remainingMs: null,
    tookMs: null,
    canAsk: false,
    failedStage: null,
    blocker: null,
    notes: 0,
    relations: 0,
    indexed: 0,
    expectsNotes: false
  };
  if (!progress) return base;
  const { run, steps } = progress;
  const values = stepValues(steps);
  const ids: StripStepId[] = ["read", "chunks", "notes", "placed", "summary", "relations"];
  const stripSteps = ids.map((id): StripStep => ({
    id,
    state: steps[id].state,
    label: stepLabels[id],
    value: values[id]
  }));
  const active = run !== null && (run.status === "pending" || run.status === "running");
  const waitsForNotes = steps.notes.state === "pending" || steps.notes.state === "running";
  const tookMs =
    run?.startedAt && run.completedAt
      ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt))
      : null;
  const shared = {
    ...base,
    steps: stripSteps,
    sections: rulerSections(progress),
    startedAt: run?.startedAt ?? null,
    canAsk: steps.chunks.indexed > 0,
    notes: steps.notes.soFar,
    relations: steps.relations.count,
    indexed: steps.chunks.indexed
  };
  // The precedence of the person's eyes: what only they can fix, then what they chose, then what broke.
  if (progress.needsYou !== null)
    return { ...shared, kind: "needsYou", blocker: progress.needsYou, expectsNotes: false };
  if (progress.paused && (active || run === null))
    return { ...shared, kind: "paused", expectsNotes: waitsForNotes };
  if (run && (run.status === "failed" || run.status === "canceled"))
    return {
      ...shared,
      kind: "error",
      failedStage: run.failedStage,
      expectsNotes: false
    };
  if (active)
    return {
      ...shared,
      kind: "running",
      remainingMs: remainingMs(progress, now),
      expectsNotes: waitsForNotes
    };
  if (run && run.status === "succeeded") {
    if (steps.notes.state === "notApplicable")
      return { ...shared, kind: "searchable", tookMs, expectsNotes: false };
    return { ...shared, kind: "done", tookMs, expectsNotes: false };
  }
  return base;
}

/** The ruler's labels that fit: a segment narrower than this shows no name (its title stays on hover). */
export const rulerLabelMinPx = 44;

/** Which segments of a ruler `widthPx` wide have room for their name. Everything fits where nothing is measured. */
export function rulerLabelsShown(sections: readonly StripSection[], widthPx: number): boolean[] {
  if (widthPx <= 0) return sections.map(() => true);
  return sections.map((section) => (section.widthPct / 100) * widthPx >= rulerLabelMinPx);
}

/**
 * Scores a Memora library against the matching-quality fixture (`build-matching-fixture.ts`):
 * which human-labelled root pairs the matching layers linked, and what the reranking calls cost.
 *
 * Notes and sources are aggregated to benchmark roots through the source hierarchy (a note belongs to
 * `created_from_source_item_id`, a chapter to its book), so the result does not depend on how a
 * pipeline version splits, orders or stores its relations. Pure functions plus one read-only query
 * function; `evaluate-matching.ts` is the command line.
 */
import {
  summarizeCallsPerChapter,
  type CallsPerChapter,
  type OperationCount
} from "./calls-per-chapter.ts";
import { sealedNotice } from "./freeze-guard.ts";
import {
  pairKey,
  type MappingRoot,
  type MatchingMapping,
  type Partition
} from "./matching-fixture.ts";

/** Relation states that count as a link: not rejected. */
export const defaultRelationStatuses = ["accepted", "pending_review"] as const;
/** The AI task the matching contracts run under. */
export const defaultAiTasks = ["reranking"] as const;
/** Seconds per note of the v6 note-matching contract (`docs/kpi-golden.md`, golden-small record run). */
export const v6SecondsPerNote = 10.4;
/** F1a exit (`docs/plan.md`): held-out expected pairs found, forbidden accepted, v6 time share. */
export const exitCriterion = { minExpected: 27, maxForbidden: 0, secondsShare: 1 / 3 } as const;

const partitions: readonly Partition[] = ["tuning", "holdout"];
const noteOperation = /^note_matching/u;
const sourceOperation = /^source_(relation_)?matching/u;

export interface SourceRow {
  id: string;
  parentId: string | null;
  title: string;
}
export interface NoteRow {
  id: string;
  sourceItemId: string;
}
/** A relation between two notes or two sources; direction is irrelevant at root level. */
export interface RelationRow {
  sourceId: string;
  targetId: string;
  status: string;
  /**
   * The visibility clause's verdicts (`relation-visibility.ts`). Absent: the relation counts when its
   * status is among the counted ones, both as shown and as applied.
   */
  shown?: boolean | undefined;
  applied?: boolean | undefined;
  /** Source relations: how the row came to be (`promoted` from note relations, `judged`); null when unknown. */
  origin?: string | null | undefined;
}
export interface AiCallRow {
  task: string;
  status: string;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** From the monitoring record; null when there is none. */
  operation: string | null;
  noteId: string | null;
  /** The source the call was about (source matching records the root being matched). */
  sourceItemId: string | null;
  /** The prompt contract (for example `atomic-note-matching-v6`) from the monitoring record. */
  promptVersion: string | null;
  /** The call was answered from an AI cassette, so its duration is not a model latency. */
  replayed: boolean;
  /** When the call started and ended (ISO), for wall seconds per source; absent when unknown. */
  startedAt?: string | null | undefined;
  finishedAt?: string | null | undefined;
}

/** Calls of the window by AI task and operation, for calls per chapter. */
export interface OperationRow {
  task: string;
  operation: string | null;
  calls: number;
  replayed: number;
}

export interface EvaluationInput {
  mapping: MatchingMapping;
  sources: readonly SourceRow[];
  /** Notes that count as the library's notes (not rejected, archived or superseded). */
  notes: readonly NoteRow[];
  noteRelations: readonly RelationRow[];
  sourceRelations: readonly RelationRow[];
  aiCalls: readonly AiCallRow[];
  /** Benchmark id to source item id, for a library built by the benchmark controller (not by title). */
  ids?: Readonly<Record<string, string>> | undefined;
  /** What the schema could not provide (reported as warnings). */
  gaps?: readonly string[] | undefined;
  /** Every AI call of the window by task and operation (any task), for calls per chapter. */
  operations?: readonly OperationRow[] | undefined;
  /** The library's chunk count, for calls per chapter. */
  chunks?: number | null | undefined;
}

export interface EvaluationOptions {
  statuses: readonly string[];
  minExpected: number;
  maxForbidden: number;
  baselineSecondsPerNote: number;
}

export const defaultEvaluationOptions: EvaluationOptions = {
  statuses: defaultRelationStatuses,
  minExpected: exitCriterion.minExpected,
  maxForbidden: exitCriterion.maxForbidden,
  baselineSecondsPerNote: v6SecondsPerNote
};

export interface PairScore {
  /** Labelled pairs of the partition. */
  total: number;
  /** Labelled pairs whose two roots are both in the library. */
  evaluable: number;
  /** Pairs linked by at least one relation of the layer. */
  hit: number;
  hitPairs: string[];
  /** Evaluable expected pairs that were not linked (empty for forbidden pairs). */
  missPairs: string[];
}

export interface LayerScore {
  /** Relations of the layer between two different roots of this partition's pairs. */
  relations: number;
  rootPairs: number;
  expected: PairScore;
  forbidden: PairScore;
  /** Linked root pairs that carry no label (bridges; not errors by themselves). */
  unlabelledPairs: number;
  ambiguousPairs: string[];
  /** Linked root pairs that involve a designated nonconceptual source. */
  nonconceptualPairs: number;
}

export interface PartitionScore {
  roots: { total: number; resolved: number };
  notes: number;
  /**
   * `notes` counts the shown relations (applied plus suggested, decision D23); `notesApplied` only
   * the applied ones; both are equal on a library without the relations v2 columns.
   */
  layers: { notes: LayerScore; notesApplied: LayerScore; sources: LayerScore; either: LayerScore };
  /** True when the freeze guard withheld the partition's result (decision D3); the counts are zero. */
  sealed?: boolean;
}

export interface TokenStats {
  sum: number;
  /** Calls that reported the figure; unknown stays unknown. */
  reported: number;
  perCall: number | null;
}

export interface CallGroup {
  calls: number;
  failed: number;
  replayed: number;
  seconds: { sum: number; measured: number; p50: number | null; p95: number | null };
  inputTokens: TokenStats;
  outputTokens: TokenStats;
  reasoningTokens: TokenStats;
}

export interface NoteMatchingCost {
  group: CallGroup;
  /** Notes of the library: the denominator the v6 baseline uses. */
  notes: number;
  callsPerNote: number | null;
  secondsPerNote: number | null;
  /** Calls whose note is not among the library's notes. */
  unattributedCalls: number;
  /** Calls per prompt contract version (`unknown` when the monitoring record has none). */
  promptVersions: Record<string, number>;
  perPartition: Record<
    Partition,
    {
      notes: number;
      calls: number;
      replayed: number;
      callsPerNote: number | null;
      secondsPerNote: number | null;
      inputTokensPerCall: number | null;
      outputTokensPerCall: number | null;
      reasoningTokensPerCall: number | null;
    }
  >;
}

export interface SourceMatchingCost {
  group: CallGroup;
  roots: number;
  callsPerRoot: number | null;
  /** AI-call seconds per matched source (decision D2's "per source"). */
  secondsPerRoot: number | null;
  /** Wall seconds per matched source: first call start to last call end, averaged over the roots that report it. */
  wallSecondsPerRoot: number | null;
  /** Source relations by origin: promoted from note relations against judged by the source judge. */
  relationsByOrigin: { promoted: number; judged: number; unknown: number };
}

export interface Gate {
  /** True/false once measured; null when it cannot be decided (see `note`). */
  pass: boolean | null;
  note?: string;
}

export interface MatchingEvaluation {
  format: "memora-golden-matching-evaluation";
  version: 1;
  statuses: string[];
  resolution: {
    roots: { total: number; resolved: number; missing: string[]; ambiguous: string[] };
    notes: number;
    notesOutsideFixture: number;
    warnings: string[];
  };
  partitions: Record<Partition, PartitionScore>;
  cost: {
    tasks: string[];
    noteMatching: NoteMatchingCost;
    sourceMatching: SourceMatchingCost;
    /** Calls of the task whose purpose is unknown (no monitoring record) or that belong to neither. */
    unclassified: CallGroup;
    /** Generative calls per reference chapter; null without operations or a chunk count. */
    callsPerChapter: CallsPerChapter | null;
  };
  /** The F1a exit criterion, scored on the note-relation layer of the held-out pairs. */
  exit: {
    layer: "notes";
    expected: Gate & { found: number; total: number; evaluable: number; minimum: number };
    forbidden: Gate & { accepted: number; total: number; evaluable: number; maximum: number };
    secondsPerNote: Gate & {
      value: number | null;
      baseline: number;
      limit: number;
    };
    pass: boolean | null;
  };
}

// --- Root resolution -----------------------------------------------------------------------------

export interface Resolution {
  dbRootByRoot: Map<string, string>;
  rootByDbRoot: Map<string, string>;
  missing: string[];
  ambiguous: string[];
  warnings: string[];
}

/** Finds the library's source item for every fixture root: by explicit id, else by root title. */
function resolveRoots(input: Pick<EvaluationInput, "mapping" | "sources" | "ids">): Resolution {
  const byId = new Map(input.sources.map((source) => [source.id, source]));
  const topLevel = input.sources.filter((source) => !source.parentId || !byId.has(source.parentId));
  const byTitle = new Map<string, string[]>();
  for (const source of topLevel)
    byTitle.set(source.title, [...(byTitle.get(source.title) ?? []), source.id]);
  const children = new Map<string, string[]>();
  for (const source of input.sources)
    if (source.parentId)
      children.set(source.parentId, [...(children.get(source.parentId) ?? []), source.title]);

  const result: Resolution = {
    dbRootByRoot: new Map(),
    rootByDbRoot: new Map(),
    missing: [],
    ambiguous: [],
    warnings: []
  };
  for (const root of input.mapping.roots) {
    let dbId: string | undefined;
    if (input.ids) {
      dbId = input.ids[root.id];
      if (!dbId || !byId.has(dbId)) {
        result.missing.push(root.id);
        continue;
      }
      if (byId.get(dbId)!.title !== root.title)
        result.warnings.push(`${root.id}: the library's title differs from the fixture's`);
    } else {
      const matches = byTitle.get(root.title) ?? [];
      if (matches.length === 0) {
        result.missing.push(root.id);
        continue;
      }
      if (matches.length > 1) {
        result.ambiguous.push(root.id);
        continue;
      }
      dbId = matches[0]!;
    }
    result.dbRootByRoot.set(root.id, dbId);
    result.rootByDbRoot.set(dbId, root.id);
    const expectedTitles = root.records.map((record) => record.title).sort();
    const actualTitles = [...(children.get(dbId) ?? [])].sort();
    if (
      root.kind === "container" &&
      JSON.stringify(expectedTitles) !== JSON.stringify(actualTitles)
    )
      result.warnings.push(`${root.id}: the chapters in the library differ from the fixture's`);
  }
  if (result.missing.length)
    result.warnings.push(`roots not in the library: ${result.missing.join(", ")}`);
  if (result.ambiguous.length)
    result.warnings.push(
      `roots whose title matches several library roots (not scored): ${result.ambiguous.join(", ")}`
    );
  return result;
}

/** Walks up the source hierarchy to the top-most ancestor. */
function createRootFinder(sources: readonly SourceRow[]) {
  const parent = new Map(sources.map((source) => [source.id, source.parentId]));
  const cache = new Map<string, string | null>();
  return (id: string): string | null => {
    if (cache.has(id)) return cache.get(id)!;
    let current = id;
    const seen = new Set<string>();
    while (parent.has(current)) {
      const up = parent.get(current);
      if (!up || !parent.has(up)) break;
      if (seen.has(current)) {
        cache.set(id, null);
        return null;
      }
      seen.add(current);
      current = up;
    }
    const found = parent.has(current) ? current : null;
    cache.set(id, found);
    return found;
  };
}

// --- Root pairs ----------------------------------------------------------------------------------

interface PairLinks {
  a: string;
  b: string;
  relations: number;
}
type PairMap = Map<string, PairLinks>;

/** Whether a relation counts: the visibility clause's verdict when it gave one, else its status. */
function counts(
  relation: RelationRow,
  statuses: ReadonlySet<string>,
  mode: "shown" | "applied"
): boolean {
  const verdict = mode === "applied" ? relation.applied : relation.shown;
  return verdict ?? statuses.has(relation.status);
}

/** Counts relations per root pair; same-root, unmapped and filtered-out relations are not pairs. */
function aggregatePairs(
  relations: readonly RelationRow[],
  rootOf: (id: string) => string | null,
  statuses: ReadonlySet<string>,
  mode: "shown" | "applied" = "shown"
): PairMap {
  const pairs: PairMap = new Map();
  for (const relation of relations) {
    if (!counts(relation, statuses, mode)) continue;
    const a = rootOf(relation.sourceId);
    const b = rootOf(relation.targetId);
    if (!a || !b || a === b) continue;
    const key = pairKey(a, b);
    const existing = pairs.get(key);
    if (existing) existing.relations += 1;
    else pairs.set(key, { a, b, relations: 1 });
  }
  return pairs;
}

function mergePairs(left: PairMap, right: PairMap): PairMap {
  const merged: PairMap = new Map();
  for (const source of [left, right])
    for (const [key, links] of source) {
      const existing = merged.get(key);
      if (existing) existing.relations += links.relations;
      else merged.set(key, { ...links });
    }
  return merged;
}

function scorePairs(
  partition: Partition,
  pairs: PairMap,
  mapping: MatchingMapping,
  resolved: ReadonlySet<string>
): LayerScore {
  const partitionOf = new Map(mapping.roots.map((root) => [root.id, root.partition]));
  const nonconceptual = new Set(mapping.roots.filter((r) => r.nonconceptual).map((r) => r.id));
  const inPartition = (links: PairLinks) =>
    (partitionOf.get(links.a) === "holdout" || partitionOf.get(links.b) === "holdout") ===
    (partition === "holdout");
  const mine = [...pairs.entries()].filter(([, links]) => inPartition(links));
  const keys = new Set(mine.map(([key]) => key));

  const score = (
    labelled: ReadonlyArray<{ pair: [string, string]; partition: Partition }>,
    listMisses: boolean
  ): PairScore => {
    const own = labelled.filter((entry) => entry.partition === partition);
    const hitPairs: string[] = [];
    const missPairs: string[] = [];
    let evaluable = 0;
    for (const { pair } of own) {
      const key = pairKey(...pair);
      const present = resolved.has(pair[0]) && resolved.has(pair[1]);
      if (present) evaluable += 1;
      if (keys.has(key)) hitPairs.push(key);
      else if (present && listMisses) missPairs.push(key);
    }
    return { total: own.length, evaluable, hit: hitPairs.length, hitPairs, missPairs };
  };
  // Forbidden pairs that were not linked are the good outcome and are not listed.
  const expected = score(mapping.expectedRootPairs, true);
  const forbidden = score(mapping.forbiddenRootPairs, false);

  const labelledKeys = new Set(
    [...mapping.expectedRootPairs, ...mapping.forbiddenRootPairs].map(({ pair }) =>
      pairKey(...pair)
    )
  );
  const ambiguousKeys = new Set(mapping.ambiguousRootPairs.map(({ pair }) => pairKey(...pair)));
  return {
    relations: mine.reduce((sum, [, links]) => sum + links.relations, 0),
    rootPairs: mine.length,
    expected,
    forbidden,
    unlabelledPairs: mine.filter(([key]) => !labelledKeys.has(key) && !ambiguousKeys.has(key))
      .length,
    ambiguousPairs: mine.map(([key]) => key).filter((key) => ambiguousKeys.has(key)),
    nonconceptualPairs: mine.filter(([, l]) => nonconceptual.has(l.a) || nonconceptual.has(l.b))
      .length
  };
}

// --- Cost ----------------------------------------------------------------------------------------

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * fraction;
  const low = sorted[Math.floor(position)]!;
  const high = sorted[Math.ceil(position)]!;
  return low + (high - low) * (position - Math.floor(position));
}

function tokenStats(values: ReadonlyArray<number | null>): TokenStats {
  const present = values.filter((value): value is number => typeof value === "number");
  const sum = present.reduce((total, value) => total + value, 0);
  return { sum, reported: present.length, perCall: present.length ? sum / present.length : null };
}

export function summarizeCalls(calls: readonly AiCallRow[]): CallGroup {
  const durations = calls
    .map((call) => call.durationMs)
    .filter((value): value is number => typeof value === "number" && value >= 0)
    .map((ms) => ms / 1000)
    .sort((a, b) => a - b);
  return {
    calls: calls.length,
    failed: calls.filter((call) => call.status !== "succeeded").length,
    replayed: calls.filter((call) => call.replayed).length,
    seconds: {
      sum: durations.reduce((total, value) => total + value, 0),
      measured: durations.length,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95)
    },
    inputTokens: tokenStats(calls.map((call) => call.inputTokens)),
    outputTokens: tokenStats(calls.map((call) => call.outputTokens)),
    reasoningTokens: tokenStats(calls.map((call) => call.reasoningTokens))
  };
}

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

function measureCost(
  input: EvaluationInput,
  tasks: readonly string[],
  roots: {
    noteRoot: ReadonlyMap<string, string | null>;
    rootOfSource: (id: string) => string | null;
    partitionOfRoot: ReadonlyMap<string, Partition>;
    statuses: ReadonlySet<string>;
  }
) {
  const { noteRoot, rootOfSource, partitionOfRoot, statuses } = roots;
  const calls = input.aiCalls.filter((call) => tasks.includes(call.task));
  // Without calls of the task, or without monitoring records to tell note from source matching,
  // a ratio would read as "free". Unknown stays unknown.
  const knownPurpose = calls.some((call) => call.operation !== null);
  const per = (part: number, whole: number) => (knownPurpose ? ratio(part, whole) : null);
  const noteCalls = calls.filter((call) => call.operation && noteOperation.test(call.operation));
  const sourceCalls = calls.filter(
    (call) => call.operation && sourceOperation.test(call.operation)
  );
  const classified = new Set([...noteCalls, ...sourceCalls]);
  const group = summarizeCalls(noteCalls);
  const notesIn = (partition: Partition) =>
    input.notes.filter((note) => {
      const root = noteRoot.get(note.id);
      return root ? partitionOfRoot.get(root) === partition : false;
    }).length;
  const perPartition = Object.fromEntries(
    partitions.map((partition) => {
      const own = noteCalls.filter((call) => {
        const root = call.noteId ? noteRoot.get(call.noteId) : null;
        return root ? partitionOfRoot.get(root) === partition : false;
      });
      const stats = summarizeCalls(own);
      const notes = notesIn(partition);
      return [
        partition,
        {
          notes,
          calls: own.length,
          replayed: stats.replayed,
          callsPerNote: per(own.length, notes),
          secondsPerNote: per(stats.seconds.sum, notes),
          inputTokensPerCall: stats.inputTokens.perCall,
          outputTokensPerCall: stats.outputTokens.perCall,
          reasoningTokensPerCall: stats.reasoningTokens.perCall
        }
      ];
    })
  ) as NoteMatchingCost["perPartition"];
  const sources = summarizeCalls(sourceCalls);
  const matchedRoots = new Set(
    sourceCalls.map((call) => (call.sourceItemId ? rootOfSource(call.sourceItemId) : null))
  );
  matchedRoots.delete(null);
  // Wall seconds per source: the span from the first call's start to the last call's end of each root.
  const spans = new Map<string, { start: number; end: number }>();
  for (const call of sourceCalls) {
    const root = call.sourceItemId ? rootOfSource(call.sourceItemId) : null;
    const start = call.startedAt ? Date.parse(call.startedAt) : Number.NaN;
    const end = call.finishedAt ? Date.parse(call.finishedAt) : Number.NaN;
    if (!root || Number.isNaN(start) || Number.isNaN(end) || end < start) continue;
    const span = spans.get(root);
    if (span) {
      span.start = Math.min(span.start, start);
      span.end = Math.max(span.end, end);
    } else spans.set(root, { start, end });
  }
  const walls = [...spans.values()].map((span) => (span.end - span.start) / 1000);
  const origins = { promoted: 0, judged: 0, unknown: 0 };
  for (const relation of input.sourceRelations) {
    if (!counts(relation, statuses, "shown")) continue;
    if (relation.origin === "promoted") origins.promoted += 1;
    else if (relation.origin === "judged") origins.judged += 1;
    else origins.unknown += 1;
  }
  const operations: OperationCount[] | null =
    input.operations && input.chunks
      ? input.operations.map((row) => ({
          operation: row.operation,
          task: row.task,
          calls: row.calls,
          replayed: row.replayed
        }))
      : null;
  return {
    tasks: [...tasks],
    noteMatching: {
      group,
      notes: input.notes.length,
      callsPerNote: per(group.calls, input.notes.length),
      secondsPerNote: per(group.seconds.sum, input.notes.length),
      unattributedCalls: noteCalls.filter((call) => !call.noteId || !noteRoot.has(call.noteId))
        .length,
      promptVersions: tally(noteCalls.map((call) => call.promptVersion ?? "unknown")),
      perPartition
    },
    sourceMatching: {
      group: sources,
      roots: matchedRoots.size,
      callsPerRoot: per(sources.calls, matchedRoots.size),
      secondsPerRoot: per(sources.seconds.sum, matchedRoots.size),
      wallSecondsPerRoot: walls.length
        ? walls.reduce((total, value) => total + value, 0) / walls.length
        : null,
      relationsByOrigin: origins
    },
    callsPerChapter: operations ? summarizeCallsPerChapter(operations, input.chunks ?? null) : null,
    unclassified: summarizeCalls(calls.filter((call) => !classified.has(call)))
  };
}

// --- Evaluation ----------------------------------------------------------------------------------

/** Maps a library's sources and notes to the fixture's roots. */
export interface RootIndex {
  /** Fixture root id of a source item (a chapter rolls up to its book); null outside the fixture. */
  rootOfSource: (id: string) => string | null;
  /** Fixture root id of a note; null for notes outside the library's notes or the fixture. */
  rootOfNote: (id: string) => string | null;
  /** Fixture roots found in the library. */
  resolved: ReadonlySet<string>;
  noteRoot: ReadonlyMap<string, string | null>;
  resolution: Resolution;
}

export function createRootIndex(
  input: Pick<EvaluationInput, "mapping" | "sources" | "notes" | "ids">
): RootIndex {
  const resolution = resolveRoots(input);
  const resolved = new Set(resolution.dbRootByRoot.keys());
  const findRoot = createRootFinder(input.sources);
  const rootOfSource = (id: string): string | null => {
    const top = findRoot(id);
    return top ? (resolution.rootByDbRoot.get(top) ?? null) : null;
  };
  const noteRoot = new Map(input.notes.map((note) => [note.id, rootOfSource(note.sourceItemId)]));
  return {
    rootOfSource,
    rootOfNote: (id) => noteRoot.get(id) ?? null,
    resolved,
    noteRoot,
    resolution
  };
}

export function evaluateMatching(
  input: EvaluationInput,
  options: EvaluationOptions = defaultEvaluationOptions,
  tasks: readonly string[] = defaultAiTasks
): MatchingEvaluation {
  const { mapping } = input;
  const statuses = new Set(options.statuses);
  const { resolution, resolved, rootOfSource, rootOfNote, noteRoot } = createRootIndex(input);
  const partitionOfRoot = new Map(mapping.roots.map((root) => [root.id, root.partition]));

  const notePairs = aggregatePairs(input.noteRelations, rootOfNote, statuses, "shown");
  const appliedPairs = aggregatePairs(input.noteRelations, rootOfNote, statuses, "applied");
  const sourcePairs = aggregatePairs(input.sourceRelations, rootOfSource, statuses);
  const eitherPairs = mergePairs(notePairs, sourcePairs);

  const warnings = [...resolution.warnings, ...(input.gaps ?? [])];
  const outside = [...noteRoot.values()].filter((root) => root === null).length;
  if (outside) warnings.push(`${outside} notes belong to sources outside the fixture (not scored)`);
  const scored = Object.fromEntries(
    partitions.map((partition) => {
      const rootsOf = mapping.roots.filter((root: MappingRoot) => root.partition === partition);
      const score: PartitionScore = {
        roots: {
          total: rootsOf.length,
          resolved: rootsOf.filter((root) => resolved.has(root.id)).length
        },
        notes: [...noteRoot.values()].filter(
          (root) => root !== null && partitionOfRoot.get(root) === partition
        ).length,
        layers: {
          notes: scorePairs(partition, notePairs, mapping, resolved),
          notesApplied: scorePairs(partition, appliedPairs, mapping, resolved),
          sources: scorePairs(partition, sourcePairs, mapping, resolved),
          either: scorePairs(partition, eitherPairs, mapping, resolved)
        }
      };
      return [partition, score];
    })
  ) as Record<Partition, PartitionScore>;

  const cost = measureCost(input, tasks, { noteRoot, rootOfSource, partitionOfRoot, statuses });
  const taskCalls = input.aiCalls.filter((call) => tasks.includes(call.task));
  if (taskCalls.length === 0)
    warnings.push(
      `no ${tasks.join("/")} calls in the library or window (use --task for another task type): cost per note is unknown`
    );
  else if (taskCalls.some((call) => call.operation === null))
    warnings.push(
      `${taskCalls.filter((call) => call.operation === null).length} of ${taskCalls.length} ${tasks.join("/")} calls have no monitoring record, so they are not counted as note or source matching`
    );
  return {
    format: "memora-golden-matching-evaluation",
    version: 1,
    statuses: [...options.statuses],
    resolution: {
      roots: {
        total: mapping.roots.length,
        resolved: resolved.size,
        missing: resolution.missing,
        ambiguous: resolution.ambiguous
      },
      notes: input.notes.length,
      notesOutsideFixture: outside,
      warnings
    },
    partitions: scored,
    cost,
    exit: exitScore(scored.holdout.layers.notes, cost.noteMatching, options)
  };
}

function exitScore(
  layer: LayerScore,
  notes: NoteMatchingCost,
  options: EvaluationOptions
): MatchingEvaluation["exit"] {
  const complete = (score: PairScore) => score.evaluable === score.total;
  const incomplete = "some labelled pairs involve roots that are not in the library";
  const expectedPass = complete(layer.expected) ? layer.expected.hit >= options.minExpected : null;
  const forbiddenPass = complete(layer.forbidden)
    ? layer.forbidden.hit <= options.maxForbidden
    : null;
  const limit = options.baselineSecondsPerNote * exitCriterion.secondsShare;
  const value = notes.secondsPerNote;
  const replayed = notes.group.replayed > 0;
  const secondsPass: Gate =
    value === null
      ? { pass: null, note: "cost per note is unknown" }
      : replayed
        ? { pass: null, note: "calls were replayed from a cassette: durations are not latencies" }
        : { pass: value <= limit };
  const gates = [expectedPass, forbiddenPass, secondsPass.pass];
  return {
    layer: "notes",
    expected: {
      found: layer.expected.hit,
      total: layer.expected.total,
      evaluable: layer.expected.evaluable,
      minimum: options.minExpected,
      pass: expectedPass,
      ...(expectedPass === null ? { note: incomplete } : {})
    },
    forbidden: {
      accepted: layer.forbidden.hit,
      total: layer.forbidden.total,
      evaluable: layer.forbidden.evaluable,
      maximum: options.maxForbidden,
      pass: forbiddenPass,
      ...(forbiddenPass === null ? { note: incomplete } : {})
    },
    secondsPerNote: { value, baseline: options.baselineSecondsPerNote, limit, ...secondsPass },
    pass: gates.includes(false) ? false : gates.includes(null) ? null : true
  };
}

/**
 * Withholds the held-out partition's result (decision D3, until `frozen.json` exists): its counts and
 * pair lists are emptied, `sealed` is set and the F1a exit gates for the partition become undecided.
 * Costs and library facts stay. Call it before anything is rendered or written.
 */
export function sealHeldOut(evaluation: MatchingEvaluation, reason: string): MatchingEvaluation {
  const emptyScore = (score: PairScore): PairScore => ({
    total: score.total,
    evaluable: score.evaluable,
    hit: 0,
    hitPairs: [],
    missPairs: []
  });
  const emptyLayer = (layer: LayerScore): LayerScore => ({
    relations: 0,
    rootPairs: 0,
    expected: emptyScore(layer.expected),
    forbidden: emptyScore(layer.forbidden),
    unlabelledPairs: 0,
    ambiguousPairs: [],
    nonconceptualPairs: 0
  });
  const held = evaluation.partitions.holdout;
  const notice = sealedNotice(reason);
  const sealed: PartitionScore = {
    roots: held.roots,
    notes: held.notes,
    layers: {
      notes: emptyLayer(held.layers.notes),
      notesApplied: emptyLayer(held.layers.notesApplied),
      sources: emptyLayer(held.layers.sources),
      either: emptyLayer(held.layers.either)
    },
    sealed: true
  };
  return {
    ...evaluation,
    partitions: { ...evaluation.partitions, holdout: sealed },
    resolution: { ...evaluation.resolution, warnings: [...evaluation.resolution.warnings, notice] },
    exit: {
      ...evaluation.exit,
      expected: { ...evaluation.exit.expected, found: 0, pass: null, note: notice },
      forbidden: { ...evaluation.exit.forbidden, accepted: 0, pass: null, note: notice },
      pass: null
    }
  };
}

/** `--check`: 0 when every measure passes, 1 when one fails, 2 when none failed but one is undecided. */
export const checkExitCode = (pass: boolean | null): 0 | 1 | 2 =>
  pass === true ? 0 : pass === false ? 1 : 2;

// --- Markdown ------------------------------------------------------------------------------------

const number = (value: number | null, digits = 1): string =>
  value === null ? "unknown" : value.toFixed(digits);
const count = (hit: number, total: number): string => `${hit}/${total}`;
const verdict = (pass: boolean | null): string =>
  pass === null ? "not decided" : pass ? "pass" : "FAIL";
const list = (items: readonly string[]): string => (items.length ? items.join(", ") : "none");

export function renderEvaluationMarkdown(
  evaluation: MatchingEvaluation,
  context: { label?: string | null; database?: string | null; fixtureSha256?: string | null } = {}
): string {
  const { exit, cost, resolution } = evaluation;
  const heldOutSealed = evaluation.partitions.holdout.sealed === true;
  const lines: string[] = [
    `# Matching-quality evaluation${context.label ? `: ${context.label}` : ""}`,
    ""
  ];
  const facts = [
    context.database ? `Database ${context.database}` : null,
    context.fixtureSha256 ? `fixture sha256 ${context.fixtureSha256.slice(0, 12)}` : null,
    `relations counted: ${evaluation.statuses.join(", ")}`,
    `${resolution.roots.resolved} of ${resolution.roots.total} fixture roots found, ${resolution.notes} notes`
  ].filter(Boolean);
  lines.push(`${facts.join("; ")}.`, "");

  lines.push(
    "## F1a exit criterion (held-out pairs, note relations)",
    "",
    "| Measure | Result | Target | Verdict |",
    "| --- | --- | --- | --- |",
    `| Expected root pairs linked | ${heldOutSealed ? "sealed" : count(exit.expected.found, exit.expected.total)} | at least ${exit.expected.minimum}/${exit.expected.total} | ${verdict(exit.expected.pass)} |`,
    `| Forbidden root pairs linked | ${heldOutSealed ? "sealed" : count(exit.forbidden.accepted, exit.forbidden.total)} | at most ${exit.forbidden.maximum}/${exit.forbidden.total} | ${verdict(exit.forbidden.pass)} |`,
    `| Seconds per note (note-matching calls) | ${number(exit.secondsPerNote.value, 2)} | at most ${number(exit.secondsPerNote.limit, 2)} (1/3 of the v6 ${number(exit.secondsPerNote.baseline)}) | ${verdict(exit.secondsPerNote.pass)} |`,
    `| All three | | | ${verdict(exit.pass)} |`,
    ""
  );
  for (const gate of [exit.expected, exit.forbidden, exit.secondsPerNote])
    if (gate.note) lines.push(`- ${gate.note}`);
  if (lines.at(-1) !== "") lines.push("");

  for (const partition of ["holdout", "tuning"] as const) {
    const score = evaluation.partitions[partition];
    lines.push(
      `## Root pairs: ${partition === "holdout" ? "held-out" : "tuning"} partition`,
      "",
      `${score.roots.resolved} of ${score.roots.total} roots found, ${score.notes} notes.`,
      ""
    );
    if (score.sealed) {
      lines.push("Result sealed until the freeze (decision D3).", "");
      continue;
    }
    lines.push(
      "| Layer | Relations | Root pairs | Expected linked | Forbidden linked | Unlabelled pairs | With nonconceptual sources |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
    );
    const names: Array<[keyof PartitionScore["layers"], string]> = [
      ["notes", "Note relations"],
      ["notesApplied", "Applied note relations"],
      ["sources", "Source relations"],
      ["either", "Either layer"]
    ];
    // Applied-only differs from shown only on libraries with the relations v2 bands.
    const shown = names.filter(
      ([layer]) =>
        layer !== "notesApplied" ||
        score.layers.notesApplied.relations !== score.layers.notes.relations
    );
    for (const [layer, label] of shown) {
      const row = score.layers[layer];
      lines.push(
        `| ${label} | ${row.relations} | ${row.rootPairs} | ${count(row.expected.hit, row.expected.total)} | ${count(row.forbidden.hit, row.forbidden.total)} | ${row.unlabelledPairs} | ${row.nonconceptualPairs} |`
      );
    }
    lines.push("");
    for (const [layer, label] of shown) {
      const row = score.layers[layer];
      lines.push(
        `- ${label}: expected not linked: ${list(row.expected.missPairs)}; forbidden linked: ${list(row.forbidden.hitPairs)}`
      );
    }
    lines.push("");
  }

  const matching = cost.noteMatching;
  const group = matching.group;
  const sources = cost.sourceMatching;
  lines.push(
    `## Cost of the ${cost.tasks.join(", ")} task`,
    "",
    "| Scope | Notes | Calls | Replayed | Calls per note | Seconds per note | Input tokens per call | Output tokens per call | Reasoning tokens per call |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| Note matching, library | ${matching.notes} | ${group.calls} | ${group.replayed} | ${number(matching.callsPerNote, 2)} | ${number(matching.secondsPerNote, 2)} | ${number(group.inputTokens.perCall, 0)} | ${number(group.outputTokens.perCall, 0)} | ${number(group.reasoningTokens.perCall, 0)} |`
  );
  for (const partition of ["holdout", "tuning"] as const) {
    const row = matching.perPartition[partition];
    lines.push(
      `| Note matching, ${partition === "holdout" ? "held-out" : "tuning"} notes | ${row.notes} | ${row.calls} | ${row.replayed} | ${number(row.callsPerNote, 2)} | ${number(row.secondsPerNote, 2)} | ${number(row.inputTokensPerCall, 0)} | ${number(row.outputTokensPerCall, 0)} | ${number(row.reasoningTokensPerCall, 0)} |`
    );
  }
  lines.push(
    `| Source matching, per root | ${sources.roots} roots | ${sources.group.calls} | ${sources.group.replayed} | ${number(sources.callsPerRoot, 2)} | ${number(sources.secondsPerRoot, 2)} | ${number(sources.group.inputTokens.perCall, 0)} | ${number(sources.group.outputTokens.perCall, 0)} | ${number(sources.group.reasoningTokens.perCall, 0)} |`,
    ""
  );
  lines.push(
    `Source matching: ${number(sources.secondsPerRoot, 2)} AI-call seconds and ${number(sources.wallSecondsPerRoot, 2)} wall seconds per source, ${number(sources.callsPerRoot, 2)} calls per source, ${sources.group.replayed} of ${sources.group.calls} calls replayed from a cassette; ` +
      `source relations promoted ${sources.relationsByOrigin.promoted}, judged ${sources.relationsByOrigin.judged}, origin unknown ${sources.relationsByOrigin.unknown}.`,
    ""
  );
  lines.push(
    `Note-matching call seconds p50 / p95: ${number(group.seconds.p50, 2)} / ${number(group.seconds.p95, 2)}; ` +
      `${group.failed} failed, ${group.replayed} replayed from a cassette, ${matching.unattributedCalls} not tied to a library note; ` +
      `contracts: ${
        Object.entries(matching.promptVersions)
          .map(([version, n]) => `${version} x${n}`)
          .join(", ") || "none"
      }. ` +
      `Tokens are means over the calls that reported them (input ${group.inputTokens.reported}, output ${group.outputTokens.reported} of ${group.calls}).`
  );
  if (cost.unclassified.calls)
    lines.push(
      `${cost.unclassified.calls} calls of the task are neither note nor source matching (no monitoring record or another operation).`
    );
  lines.push("");

  const chapter = cost.callsPerChapter;
  if (chapter) {
    lines.push(
      "## Generative calls per chapter",
      "",
      `${chapter.generative.calls} generative calls over ${chapter.chunks} chunks: ${number(chapter.generative.perChunk, 2)} per chunk, ${number(chapter.generative.perChapter, 1)} per ${chapter.chapterChunks}-chunk chapter` +
        (chapter.topic.calls ? `; ${chapter.topic.calls} topic calls reported apart` : "") +
        ".",
      "",
      "| Operation | Calls | Per chapter |",
      "| --- | ---: | ---: |",
      ...chapter.rows
        .filter((row) => row.class === "generative")
        .map((row) => `| ${row.key} | ${row.calls} | ${number(row.perChapter, 1)} |`),
      ""
    );
  }

  if (resolution.warnings.length)
    lines.push("## Warnings", "", ...resolution.warnings.map((warning) => `- ${warning}`), "");
  return `${lines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trimEnd()}\n`;
}

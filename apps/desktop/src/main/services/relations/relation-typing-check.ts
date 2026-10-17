// The typer's position-bias check (F3 G25, T51t proof). Directed pairs a panel rated related, with
// the panel's type and which note is its subject, are typed twice by the product's own typing step
// (`typeRelationPairs`), once with the notes shown in content order and once in the opposite
// positions. It reports the direction accuracy against the panel and the swap consistency (the
// verdict does not change with the order), the two numbers gate F reads (bars 85% and 90%, *(cal.)*).
//
// DEV only (`MEMORA_TYPER_CHECK=<pairs file>`, refused when packaged): it persists nothing. The
// typing cache is not read or written and no relation is created; the only rows written are the AI
// audit of the calls themselves. The text it sends is whatever the pairs file holds (public or
// synthetic text, never the library).
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { createAiConfigRepository, type PgPool } from "@app/db";
import {
  directedNoteRelationTypes,
  NoteRelationWriteTypeSchema,
  type NoteRelationWriteType
} from "@app/domain";

import type { AiService } from "../ai-service.js";
import {
  createTyperRouteResolver,
  typeRelationPairs,
  type RelationTypingDeps,
  type RelationTypingOptions,
  type TypingOutcome,
  type TypingPair
} from "./relation-typing.js";

export const typerCheckEnvironmentKnob = "MEMORA_TYPER_CHECK";
export const typerCheckReportFile = "typer-check.json";
const reportFormat = "memora-typer-position-check";
/** A guard against a runaway list: the check needs 60 pairs, a few calls in each order. */
export const maxTyperCheckPairs = 120;

/** The bars gate F reads, as calibrated start values *(cal.)*. */
export const typerCheckBars = { directionAccuracy: 0.85, swapConsistency: 0.9 } as const;

const directedTypes: readonly string[] = directedNoteRelationTypes;

export const TyperCheckPairSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    /** The rendered text of each note, as the decider reads it (title, idea, first body characters). */
    a: z.string().min(1).max(20_000),
    b: z.string().min(1).max(20_000),
    /** The panel's majority type: a directed write type. */
    type: NoteRelationWriteTypeSchema.refine((type) => directedTypes.includes(type), {
      message: "The check needs a directed type."
    }),
    /** Which of the two notes the panel names as the subject of the type. */
    subject: z.enum(["a", "b"])
  })
  .strict();
export type TyperCheckPair = z.infer<typeof TyperCheckPairSchema>;

export const TyperCheckPairsFileSchema = z
  .object({ pairs: z.array(TyperCheckPairSchema).min(1).max(maxTyperCheckPairs) })
  .strict()
  .superRefine((file, context) => {
    const seen = new Set<string>();
    for (const [index, pair] of file.pairs.entries()) {
      if (seen.has(pair.id))
        context.addIssue({
          code: "custom",
          message: "Pair ids repeat.",
          path: ["pairs", index, "id"]
        });
      seen.add(pair.id);
    }
  });

/** What the typer said about one pair in one presentation. */
export interface TyperCheckReading {
  /** The note shown first (as `a` of the prompt): the panel's a or b. */
  shownFirst: "a" | "b";
  verdict: "typed" | "none" | "untyped";
  type: NoteRelationWriteType | null;
  /** The note the typer names as the subject, null for a symmetric type, a veto or no answer. */
  subject: "a" | "b" | null;
}

export interface TyperCheckPairResult {
  id: string;
  panel: { type: NoteRelationWriteType; subject: "a" | "b" };
  /** Content order first, the opposite positions second. */
  readings: [TyperCheckReading, TyperCheckReading];
}

export interface TyperCheckSummary {
  pairs: number;
  /** Two readings per pair. */
  typings: number;
  /** Readings naming the panel's subject, over all readings (a veto or no answer is a miss). */
  directionAccuracy: number | null;
  directionAccuracyByOrder: [number | null, number | null];
  /** The same over the readings that gave a directed type. */
  directionAccuracyWhenDirected: number | null;
  /** Readings with the panel's type, over all readings. */
  typeAgreement: number | null;
  /** Pairs whose two readings name the same subject (both directed). */
  swapConsistency: number | null;
  /** Pairs whose two readings have the same type. */
  typeSwapConsistency: number | null;
  /** Pairs whose two readings have the same type and subject. */
  verdictSwapConsistency: number | null;
  /** Directed readings that name the note shown first, and the share the panel expects. */
  firstPositionShare: number | null;
  panelFirstPositionShare: number | null;
  vetoes: number;
  symmetricAnswers: number;
  untyped: number;
  meetsBars: { directionAccuracy: boolean; swapConsistency: boolean } | null;
}

const share = (count: number, total: number): number | null => (total ? count / total : null);

/** The check's numbers, pure over the readings. */
export function summarizeTyperCheck(results: readonly TyperCheckPairResult[]): TyperCheckSummary {
  const readings = results.flatMap((result) =>
    result.readings.map((reading, order) => ({ result, reading, order }))
  );
  const correct = (entry: (typeof readings)[number]) =>
    entry.reading.subject === entry.result.panel.subject;
  const directed = readings.filter((entry) => entry.reading.subject !== null);
  const byOrder = (order: number) => {
    const own = readings.filter((entry) => entry.order === order);
    return share(own.filter(correct).length, own.length);
  };
  const sameSubject = results.filter(
    ({ readings: [first, second] }) => first.subject !== null && first.subject === second.subject
  );
  const sameType = results.filter(({ readings: [first, second] }) => first.type === second.type);
  const sameVerdict = sameType.filter(
    ({ readings: [first, second] }) => first.subject === second.subject
  );
  const firstNamed = directed.filter((entry) => entry.reading.subject === entry.reading.shownFirst);
  const panelFirst = readings.filter(
    (entry) => entry.result.panel.subject === entry.reading.shownFirst
  );
  const directionAccuracy = share(readings.filter(correct).length, readings.length);
  const swapConsistency = share(sameSubject.length, results.length);
  return {
    pairs: results.length,
    typings: readings.length,
    directionAccuracy,
    directionAccuracyByOrder: [byOrder(0), byOrder(1)],
    directionAccuracyWhenDirected: share(directed.filter(correct).length, directed.length),
    typeAgreement: share(
      readings.filter((entry) => entry.reading.type === entry.result.panel.type).length,
      readings.length
    ),
    swapConsistency,
    typeSwapConsistency: share(sameType.length, results.length),
    verdictSwapConsistency: share(sameVerdict.length, results.length),
    firstPositionShare: share(firstNamed.length, directed.length),
    panelFirstPositionShare: share(panelFirst.length, readings.length),
    vetoes: readings.filter((entry) => entry.reading.verdict === "none").length,
    symmetricAnswers: readings.filter(
      (entry) => entry.reading.verdict === "typed" && entry.reading.subject === null
    ).length,
    untyped: readings.filter((entry) => entry.reading.verdict === "untyped").length,
    meetsBars:
      directionAccuracy === null || swapConsistency === null
        ? null
        : {
            directionAccuracy: directionAccuracy >= typerCheckBars.directionAccuracy,
            swapConsistency: swapConsistency >= typerCheckBars.swapConsistency
          }
  };
}

function reading(outcome: TypingOutcome, shownFirst: "a" | "b"): TyperCheckReading {
  if (outcome.kind === "untyped")
    return { shownFirst, verdict: "untyped", type: null, subject: null };
  if (outcome.kind === "none") return { shownFirst, verdict: "none", type: null, subject: null };
  return {
    shownFirst,
    verdict: "typed",
    type: outcome.relationType,
    // The pair's two notes are `<id>:a` and `<id>:b`, so the lower ID is the panel's a.
    subject: outcome.direction === "symmetric" ? null : outcome.direction === "lo_to_hi" ? "a" : "b"
  };
}

export interface TyperCheckRun {
  results: TyperCheckPairResult[];
  summary: TyperCheckSummary;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  aiTaskRunIds: string[];
  typerKey: string | null;
}

/**
 * Types every pair in both orders through the product's typing step. The cache is never read or
 * written. The notes of a pair get the IDs `<id>:a` and `<id>:b`, so which one a stored direction
 * names is read back without any lookup.
 */
export async function runTyperPositionCheck(
  deps: Omit<RelationTypingDeps, "store">,
  pairs: readonly TyperCheckPair[],
  options: Omit<RelationTypingOptions, "reverseOrder"> = {},
  signal?: AbortSignal
): Promise<TyperCheckRun> {
  const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");
  const typingPairs: TypingPair[] = pairs.map((pair) => ({
    first: { id: `${pair.id}:a`, text: pair.a, hash: hashOf(pair.a) },
    second: { id: `${pair.id}:b`, text: pair.b, hash: hashOf(pair.b) },
    band: "apply"
  }));
  const run: Omit<TyperCheckRun, "results" | "summary"> = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    aiTaskRunIds: [],
    typerKey: null
  };
  const orders: Array<Map<string, TyperCheckReading>> = [];
  for (const reverseOrder of [false, true]) {
    const typed = await typeRelationPairs(
      { ...deps, store: null },
      typingPairs,
      { ...options, reverseOrder },
      signal
    );
    run.calls += typed.calls;
    run.inputTokens += typed.inputTokens;
    run.outputTokens += typed.outputTokens;
    run.aiTaskRunIds.push(...typed.aiTaskRunIds);
    run.typerKey = typed.typerKey;
    const readings = new Map<string, TyperCheckReading>();
    for (const pair of pairs) {
      const entry = typed.pairs.get(`${pair.id}:a:${pair.id}:b`);
      if (!entry) throw new Error(`The check lost the pair ${pair.id}.`);
      readings.set(
        pair.id,
        reading(entry.outcome, entry.shownFirstNoteId === `${pair.id}:a` ? "a" : "b")
      );
    }
    orders.push(readings);
  }
  const results = pairs.map((pair): TyperCheckPairResult => ({
    id: pair.id,
    panel: { type: pair.type, subject: pair.subject },
    readings: [orders[0]!.get(pair.id)!, orders[1]!.get(pair.id)!]
  }));
  return { ...run, results, summary: summarizeTyperCheck(results) };
}

// ---------------------------------------------------------------------------
// The DEV knob

export interface TyperCheckEnvironment {
  pairsPath: string;
}

/** Reads MEMORA_TYPER_CHECK; null when unset. Packaged builds refuse it. */
export function readTyperCheckEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean; workspaceRoot: string }
): TyperCheckEnvironment | null {
  const path = env[typerCheckEnvironmentKnob]?.trim();
  if (!path) return null;
  if (options.isPackaged)
    throw new Error(`${typerCheckEnvironmentKnob} is refused in packaged builds`);
  return { pairsPath: resolve(options.workspaceRoot, path) };
}

export async function readTyperCheckPairs(path: string): Promise<TyperCheckPair[]> {
  return TyperCheckPairsFileSchema.parse(JSON.parse(await readFile(path, "utf8"))).pairs;
}

export interface TyperCheckReport extends TyperCheckRun {
  format: typeof reportFormat;
  generatedAt: string;
  pairsFile: string;
  route: { provider: string; modelId: string; runtime: string; lane: string } | null;
}

export interface TyperCheckOptions {
  environment: TyperCheckEnvironment;
  workspaceRoot: string;
  pool: Pick<PgPool, "query">;
  ai: Pick<AiService, "runDefaultTask">;
  readContentLanguage: () => Promise<string>;
  quit: () => void;
  log?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => Date;
}

/** Runs the check, writes `.cache/f3/typer-check/<utc time>/typer-check.json` and quits the app. */
export async function runTyperCheckFromEnvironment(options: TyperCheckOptions): Promise<void> {
  const log = options.log ?? ((event, data) => console.log(`TYPER_CHECK ${event}`, data ?? ""));
  try {
    const pairs = await readTyperCheckPairs(options.environment.pairsPath);
    const resolveRoute = createTyperRouteResolver(createAiConfigRepository(options.pool));
    const route = await resolveRoute();
    if (!route) throw new Error("The check needs a writer route for structured output.");
    log("start", { pairs: pairs.length, model: route.modelId, lane: route.lane });
    const run = await runTyperPositionCheck(
      {
        ai: options.ai,
        resolveRoute: async () => route,
        contentLanguage: await options.readContentLanguage(),
        logger: { warn: (message, error) => log(message, { error: String(error) }) }
      },
      pairs
    );
    const generatedAt = (options.now ?? (() => new Date()))().toISOString();
    const directory = join(
      options.workspaceRoot,
      ".cache",
      "f3",
      "typer-check",
      generatedAt.replace(/[:.]/gu, "-")
    );
    await mkdir(directory, { recursive: true });
    const report: TyperCheckReport = {
      format: reportFormat,
      generatedAt,
      pairsFile: options.environment.pairsPath,
      route: {
        provider: route.provider,
        modelId: route.modelId,
        runtime: route.runtime,
        lane: route.lane
      },
      ...run
    };
    const target = join(directory, typerCheckReportFile);
    await writeFile(`${target}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
    await rename(`${target}.tmp`, target);
    log("done", { report: target, calls: run.calls, ...run.summary });
  } catch (error) {
    log("failed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    options.quit();
  }
}

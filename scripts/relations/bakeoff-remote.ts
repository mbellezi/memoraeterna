/**
 * The Decisions API decider of plan decision 30 (T58): its own calibration identity, frozen from
 * dense (product-shaped) requests answered in two candidate orders, and its gate F reads.
 *
 *   npx tsx scripts/relations/bakeoff-remote.ts select     the D18 bands on the dense fit scores -> proposal-decisions.{json,md}
 *   npx tsx scripts/relations/bakeoff-remote.ts freeze --refreeze    adds the Decisions entry to frozen.json
 *   npx tsx scripts/relations/bakeoff-remote.ts requests   plans gate F's requests (X1's S0 export, R_v6, pool A's eval split)
 *   npx tsx scripts/relations/bakeoff-remote.ts run [--env-file <.env>] [--dry-run] [--concurrency 2]   live, capped
 *   npx tsx scripts/relations/bakeoff-remote.ts scores --set <x1|rv6|eval-A> --out <scores.json>
 *   npx tsx scripts/relations/bakeoff-remote.ts gate-f --x1-scores <file> --rv6-scores <file> --eval-scores <files>
 *
 * Every path defaults under `--cache` (default the checkout's `.cache`); see `remotePaths`. The
 * freeze record is the freeze guard's (`MEMORA_F3_FROZEN_FILE` or `.cache/f3/freeze/frozen.json`).
 *
 * The decider is the dense validation's: `gpt-6-luna`, one predicate question per candidate (the
 * spike's `buildRequest`), the frozen `mechanism` instruction, 600-character texts, a note's whole
 * decided neighbourhood in id order chunked at 20, both directions of every pair, answered in the
 * bake-off's two candidate orders, the two orders' probabilities averaged and read as log-odds at
 * epsilon 1e-7, and the two directions' mean. `select` applies D18 (cell weights, the local
 * proposal's folds) on the dense fit scores and reports decision 29's tuning edge beside it.
 * `freeze` writes a new `frozen.json` that keeps every earlier calibration as it was, adds this one
 * under its own identity, and keeps the first record beside it (D3: a re-freeze is reported beside
 * the first). A remote decider has no runtime build: its parity is the request design fingerprint.
 *
 * Live calls (`run`) send only synthetic text: the fixture's notes (ENV-F) and Spike A's benchmark
 * notes. A request with any other note is refused. The key is read from `.env` at run time by the
 * spike's `readApiKey`, stays in the client and is never printed or written; the run refuses a
 * projection above its cap (US$ 0.50).
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  calibrate,
  fitIsotonic,
  relationPairTextTemplate,
  RelationCalibrationEntrySchema,
  relationDecideDecisionsContract,
  relationsConfig,
  weightedPrecision,
  type RelationCalibrationBlock,
  type RelationCalibrationEntry,
  type RemoteRelationCalibrationIdentity
} from "@app/domain";
import { z } from "zod";

import { frozenFileLocation, readHeldOutAccess, requireHeldOut } from "../golden/freeze-guard.ts";
import { matchingMappingSchema } from "../golden/matching-fixture.ts";
import { notePairKey } from "../golden/relations-export.ts";
import { costUsd, observedCharsPerToken, type RawRecord } from "../spikes/decisions/budget.ts";
import {
  DecisionsClient,
  DecisionsError,
  decisionsModel,
  type DecisionRequest
} from "../spikes/decisions/client.ts";
import {
  buildRequest,
  designFingerprint,
  maxCandidatesPerRequest
} from "../spikes/decisions/design.ts";
import { readApiKey, redactSecrets } from "../spikes/decisions/env.ts";
import { chunk } from "../spikes/decisions/plan.ts";
import { predicatesOf } from "../spikes/decisions/scores.ts";
import {
  acceptedPairs,
  areaUnderCurve,
  assignFolds,
  brierScore,
  canonicalJson,
  chooseBands,
  crossValidatedProbabilities,
  decideThreshold,
  expectedCalibrationError,
  foldCount,
  foldSeed,
  freezeDirectory,
  labelFixtureSchema,
  listsOf,
  pools,
  readScores,
  retrievalExportSchema,
  reverseOnlyLossR6,
  reverseOnlyLossR9,
  rootLevel,
  scoreAtLevel,
  scoredLabels,
  sha256Hex,
  tuningLists,
  weightedPoolLabels,
  weightedRecall,
  type BandChoice,
  type Calibration,
  type DecideThreshold,
  type DirectedScores,
  type FreezeRecord,
  type LabelFixture,
  type ReverseOnlyLoss,
  type RootLevel,
  type ScoreFileFacts
} from "./bakeoff.ts";
import { readSpikeNotes } from "./bakeoff-sets.ts";
import { readNoteTexts, renderNoteText } from "./note-texts.ts";
import { pairScoresFormat } from "./pair-scoring.ts";

const checkoutCache = dirname(dirname(freezeDirectory));

// --- The decider and its identity -----------------------------------------------------------------

/** The decide contract of the Decisions API decider (the domain's). */
export const decisionsDecideContract = relationDecideDecisionsContract;

/** The two candidate orders: the bake-off's shuffle salts (order A and order B). */
export const decisionsOrderSalts = ["bakeoff-1", "bakeoff-2"] as const;
/** The bake-off's log-odds scale of a probability. */
export const decisionsEpsilon = 1e-7;
export const decisionsBodyCharacters = 600;
/** The cap of this card's live calls, US$. */
export const decisionsGateFCapUsd = 0.5;

export const logitAt = (probability: number, epsilon = decisionsEpsilon): number => {
  const p = Math.min(1 - epsilon, Math.max(epsilon, probability));
  return Math.log(p / (1 - p));
};

/**
 * Everything the request design is, beyond what the spike's `designFingerprint` covers (the
 * instruction, the question wording, the candidates per request and the model): the predicate
 * question, the neighbourhood, the two orders and how their answers are combined, and the scale.
 */
export function decisionsRequestDesign(instruction: string) {
  return {
    designFingerprint: designFingerprint(instruction),
    question: "predicate",
    model: decisionsModel,
    candidates:
      "the note's decided neighbourhood (its own list and the notes whose lists hold it), in id order, chunked at 20 (balanced)",
    directions: "both",
    orderSalts: [...decisionsOrderSalts],
    orders: "the mean of the two orders' predicate probabilities",
    scale: { kind: "logit", epsilon: decisionsEpsilon },
    bodyCharacters: decisionsBodyCharacters,
    maxCandidatesPerRequest
  };
}

/** The fingerprint of the request design (the identity's and the parity's). */
export const decisionsRequestDesignSha256 = (instruction: string): string =>
  sha256Hex(canonicalJson(decisionsRequestDesign(instruction)));

export function decisionsIdentity(instruction: string): RemoteRelationCalibrationIdentity {
  return {
    contract: decisionsDecideContract,
    instructionSha256: sha256Hex(instruction),
    template: relationPairTextTemplate,
    bodyCharacters: decisionsBodyCharacters,
    rule: "mean",
    provider: "openai",
    model: decisionsModel,
    runtimeKind: "remote",
    requestDesignSha256: decisionsRequestDesignSha256(instruction)
  };
}

// --- select -----------------------------------------------------------------------------------------

export interface RemoteProposal {
  format: "memora-f3-bakeoff-remote-proposal";
  version: 1;
  decider: "decisions";
  computedAt: string;
  inputs: Record<string, string>;
  instruction: { sha256: string; designFingerprint: string };
  /** The request design the scores were answered under (the identity's fingerprint covers it). */
  requestDesign: Record<string, unknown>;
  identity: RemoteRelationCalibrationIdentity;
  folds: { seed: number; count: number };
  fitLabels: { labels: number; positives: number };
  blocks: RelationCalibrationBlock[];
  /** D18 (plan decision 30: the Decisions decider keeps D18's bands, apply included). */
  bands: BandChoice & { applyFromScore: number | null; suggestFromScore: number | null };
  /** The fixture tuning partition at D18's bands. */
  tuning: RootLevel;
  /** Decision 29's tuning edge and the panel at it, reported beside D18 (not frozen). */
  threshold: DecideThreshold | null;
  cvQuality: {
    ece: number;
    brier: number;
    auc: number | null;
    aucByPool: Record<string, number | null>;
  };
  acceptByPool: Record<string, { labels: number; precision: number | null; recall: number | null }>;
}

export function proposeRemoteDecider(input: {
  labels: LabelFixture;
  weights: { weights: Record<string, number>; excludedPairs: readonly string[] };
  fitScores: DirectedScores;
  tuningScores: DirectedScores;
  tuningExport: z.infer<typeof retrievalExportSchema>;
  lists: ReturnType<typeof tuningLists>;
  identity: RemoteRelationCalibrationIdentity;
  /** The fold seed (D18's is `foldSeed`; others are a reported sensitivity). */
  seed?: number;
}): Omit<
  RemoteProposal,
  "format" | "version" | "decider" | "computedAt" | "inputs" | "instruction" | "requestDesign"
> {
  const labels = weightedPoolLabels(
    input.labels,
    {
      weightOf: new Map(Object.entries(input.weights.weights)),
      excluded: new Set(input.weights.excludedPairs)
    },
    "fit"
  );
  const folds = assignFolds(
    labels.map((label) => ({ group: label.group, cell: `${label.pool}:${label.stratum}` })),
    { seed: input.seed ?? foldSeed }
  );
  const scored = scoredLabels(
    labels,
    input.fitScores,
    input.identity.rule,
    "the Decisions fit scores"
  );
  const blocks = fitIsotonic(scored);
  const oofValues = crossValidatedProbabilities(
    scored.map((label) => ({ ...label, fold: folds.get(label.group)! }))
  );
  const oof = scored.map((label, index) => ({ ...label, probability: oofValues[index]! }));
  const unbanded: Calibration = {
    blocks,
    applyFrom: null,
    suggestFrom: null,
    rule: input.identity.rule
  };
  const before = rootLevel({
    data: input.tuningExport,
    scores: input.tuningScores,
    calibration: unbanded,
    lists: input.lists
  });
  const bands = chooseBands({
    oof,
    blocks,
    forbiddenBestScores: before.forbiddenBest.flatMap((row) =>
      row.bestScore === null ? [] : [row.bestScore]
    )
  });
  const applyFromScore = scoreAtLevel(blocks, bands.pApply);
  const suggestFromScore = scoreAtLevel(blocks, bands.pSuggest);
  const tuning = rootLevel({
    data: input.tuningExport,
    scores: input.tuningScores,
    calibration: {
      blocks,
      applyFrom: applyFromScore,
      suggestFrom: suggestFromScore,
      rule: input.identity.rule
    },
    lists: input.lists
  });
  const threshold = decideThreshold({
    data: input.tuningExport,
    scores: input.tuningScores,
    rule: input.identity.rule,
    blocks,
    lists: input.lists,
    labels: scored
  });
  const acceptByPool: RemoteProposal["acceptByPool"] = {};
  for (const pool of pools) {
    const own = oof.filter((label) => label.pool === pool);
    const level = bands.acceptLevel;
    const inBand = level === null ? [] : own.filter((label) => label.probability >= level);
    acceptByPool[pool] = {
      labels: inBand.length,
      precision: weightedPrecision(inBand)?.precision ?? null,
      recall: level === null ? null : weightedRecall(own, level)
    };
  }
  const aucByPool: Record<string, number | null> = {};
  for (const pool of pools)
    aucByPool[pool] = areaUnderCurve(scored.filter((label) => label.pool === pool));
  return {
    identity: input.identity,
    folds: { seed: input.seed ?? foldSeed, count: foldCount },
    fitLabels: {
      labels: scored.length,
      positives: scored.filter((label) => label.positive).length
    },
    blocks,
    bands: { ...bands, applyFromScore, suggestFromScore },
    tuning,
    threshold,
    cvQuality: {
      ece: expectedCalibrationError(oof).ece,
      brier: brierScore(oof),
      auc: areaUnderCurve(scored),
      aucByPool
    },
    acceptByPool
  };
}

// --- freeze ------------------------------------------------------------------------------------------

/** The basis a frozen Decisions entry records. */
export const decisionsBasis = (proposal: Pick<RemoteProposal, "bands">): string =>
  `D18 on dense two-order requests (plan decision 30): p_apply ${proposal.bands.pApply ?? "none"}, p_suggest ${proposal.bands.pSuggest ?? "none"}, cross-validated, cell weights, 0 forbidden tuning root pairs`;

export interface RemoteFreezeRecord extends FreezeRecord {
  remote?: Record<
    string,
    {
      proposal: { sha256: string; computedAt: string };
      inputHashes: Record<string, string>;
      requestDesign: Record<string, unknown>;
      parity: string;
      /** Earlier entries of the same model under another request design, which this one replaces. */
      superseded?: Array<{ requestDesignSha256: string; freezeHash: string }>;
      frozenAt: string;
    }
  >;
}

/**
 * The record of a re-freeze that adds a remote decider (pure): every earlier calibration as it was
 * (its own `freezeHash` names the freeze that fitted it), the new entry under a new config hash, and
 * the earlier record named in `previous`.
 */
export function addRemoteCalibration(input: {
  previous: RemoteFreezeRecord;
  previousFile: string;
  proposal: RemoteProposal;
  proposalSha256: string;
  frozenAt: Date;
  /**
   * Set when this entry replaces the same model's entry under another request design (the earlier
   * one no longer describes the requests sent; it stays in the earlier record, kept beside).
   */
  supersedes?: string;
  basis?: string;
}): RemoteFreezeRecord {
  const { proposal } = input;
  const sameModel = (entry: RelationCalibrationEntry) =>
    entry.identity.runtimeKind === "remote" &&
    entry.identity.provider === proposal.identity.provider &&
    entry.identity.model === proposal.identity.model;
  const replaced = input.previous.calibrations.filter(sameModel);
  if (
    replaced.some(
      (entry) =>
        entry.identity.runtimeKind === "remote" &&
        entry.identity.requestDesignSha256 === proposal.identity.requestDesignSha256
    )
  )
    throw new Error(`The freeze already holds this ${proposal.identity.model} identity.`);
  if (replaced.length > 0 && !input.supersedes)
    throw new Error(`The freeze already holds a ${proposal.identity.model} calibration.`);
  const previous = {
    ...input.previous,
    calibrations: input.previous.calibrations.filter((entry) => !sameModel(entry))
  };
  if (proposal.bands.applyFromScore === null && proposal.bands.suggestFromScore === null)
    throw new Error("D18 gives the Decisions decider no band: nothing to freeze.");
  if (proposal.tuning.forbiddenBeforeTyping > 0)
    throw new Error("The bands link a forbidden fixture-tuning root pair.");
  const entry = {
    kind: "isotonic" as const,
    identity: proposal.identity,
    blocks: proposal.blocks,
    applyFrom: proposal.bands.applyFromScore,
    suggestFrom: proposal.bands.suggestFromScore,
    basis: input.basis ?? decisionsBasis(proposal),
    labelSetHash: proposal.inputs.labelSetSha256!,
    fittedAt: proposal.computedAt,
    parity: { requestDesignSha256: proposal.identity.requestDesignSha256 }
  };
  const unhashed = (value: RelationCalibrationEntry | typeof entry) => ({
    ...value,
    fittedAt: undefined,
    freezeHash: undefined
  });
  const configHash = sha256Hex(
    canonicalJson({
      config: previous.config,
      calibrations: [...previous.calibrations.map(unhashed), unhashed(entry)]
    })
  );
  const frozenAt = input.frozenAt.toISOString();
  return {
    ...previous,
    configHash,
    frozenAt,
    calibrations: [
      ...previous.calibrations,
      RelationCalibrationEntrySchema.parse({ ...entry, freezeHash: configHash })
    ],
    inputHashes: {
      ...previous.inputHashes,
      ...Object.fromEntries(
        Object.entries(proposal.inputs).map(([key, value]) => [`remote:decisions:${key}`, value])
      ),
      "remote:decisions:proposal": input.proposalSha256
    },
    parity: {
      ...previous.parity,
      decisions: {
        requestDesignSha256: proposal.identity.requestDesignSha256,
        verdict: "a remote decider: parity is the request design fingerprint's equality"
      }
    },
    remote: {
      ...(previous.remote ?? {}),
      decisions: {
        proposal: { sha256: input.proposalSha256, computedAt: proposal.computedAt },
        inputHashes: proposal.inputs,
        requestDesign: proposal.requestDesign,
        parity:
          "the request design fingerprint (no runtime build: the provider's model is named by the identity)",
        frozenAt,
        ...(replaced.length > 0
          ? {
              superseded: replaced.flatMap((entry) =>
                entry.identity.runtimeKind === "remote" && entry.kind === "isotonic"
                  ? [
                      {
                        requestDesignSha256: entry.identity.requestDesignSha256,
                        freezeHash: entry.freezeHash
                      }
                    ]
                  : []
              )
            }
          : {})
      }
    },
    previous: [
      ...(input.previous.previous ?? []),
      {
        configHash: input.previous.configHash,
        frozenAt: input.previous.frozenAt,
        file: input.previousFile
      }
    ]
  };
}

// --- The gate F requests (synthetic text only) -------------------------------------------------------

export interface PlannedRequest {
  key: string;
  order: "A" | "B";
  set: string;
  request: DecisionRequest;
  meta: { queryId: string; candidateIds: string[] };
}

/** Every note's decided neighbourhood: both endpoints of every candidate row (prepare.ts's dense shape). */
export function neighbourhoods(
  pairs: ReadonlyArray<readonly [string, string]>
): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const [a, b] of pairs) {
    if (a === b) continue;
    (out.get(a) ?? out.set(a, new Set()).get(a)!).add(b);
    (out.get(b) ?? out.set(b, new Set()).get(b)!).add(a);
  }
  return new Map(
    [...out].sort(([a], [b]) => (a < b ? -1 : 1)).map(([note, set]) => [note, [...set].sort()])
  );
}

/** Each query's `k` nearest candidates by cosine (ties by id) of a judged-row list, as pairs. */
export function nearestRows(
  rows: ReadonlyArray<{ query: string; doc: string; cosine: number }>,
  k: number
): Array<readonly [string, string]> {
  const best = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (row.query === row.doc) continue;
    const own = best.get(row.query) ?? best.set(row.query, new Map()).get(row.query)!;
    own.set(row.doc, Math.max(own.get(row.doc) ?? Number.NEGATIVE_INFINITY, row.cosine));
  }
  return [...best].flatMap(([query, docs]) =>
    [...docs]
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
      .slice(0, k)
      .map(([doc]) => [query, doc] as const)
  );
}

/** The requests of a set in both orders: chunks of 20 in id order, the spike's request, the bake-off's salts. */
export function planRequests(input: {
  set: string;
  neighbourhoods: ReadonlyMap<string, readonly string[]>;
  text: (id: string) => string;
  instruction: string;
}): PlannedRequest[] {
  const out: PlannedRequest[] = [];
  for (const [order, salt] of [
    ["A", decisionsOrderSalts[0]],
    ["B", decisionsOrderSalts[1]]
  ] as const)
    for (const [query, candidates] of input.neighbourhoods)
      chunk(candidates, maxCandidatesPerRequest).forEach((part, index) => {
        const key = `${input.set}:${query}:${index}`;
        const built = buildRequest({
          key: `bakeoff:${query}:${index}`,
          instruction: input.instruction,
          query: { id: query, text: input.text(query) },
          candidates: part.map((id) => ({ id, text: input.text(id) })),
          config: "predicate",
          orderSalt: salt
        });
        out.push({
          key,
          order,
          set: input.set,
          request: built.request,
          meta: { queryId: query, candidateIds: built.candidateIds }
        });
      });
  return out;
}

/** Directed meanAB log-odds from the two orders' predicate probabilities; a pair needs both orders. */
export function meanOfOrders(
  answers: ReadonlyArray<{
    order: "A" | "B";
    query: string;
    doc: string;
    probability: number | null;
  }>
): {
  scores: Array<{ query: string; doc: string; probability: number; logOdds: number }>;
  incomplete: number;
} {
  const byPair = new Map<string, { query: string; doc: string; A?: number; B?: number }>();
  for (const answer of answers) {
    if (answer.probability === null) continue;
    const key = `${answer.query}>${answer.doc}`;
    const row = byPair.get(key) ?? { query: answer.query, doc: answer.doc };
    row[answer.order] = answer.probability;
    byPair.set(key, row);
  }
  const scores: Array<{ query: string; doc: string; probability: number; logOdds: number }> = [];
  let incomplete = 0;
  for (const row of [...byPair.values()].sort((a, b) =>
    a.query + a.doc < b.query + b.doc ? -1 : 1
  )) {
    if (row.A === undefined || row.B === undefined) {
      incomplete++;
      continue;
    }
    const probability = (row.A + row.B) / 2;
    scores.push({ query: row.query, doc: row.doc, probability, logOdds: logitAt(probability) });
  }
  return { scores, incomplete };
}

// --- CLI helpers ---------------------------------------------------------------------------------------

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 1)}\n`);
  await rename(`${path}.tmp`, path);
};
const fmt = (value: number | null | undefined, digits = 3) =>
  value === null || value === undefined
    ? "-"
    : Number.isFinite(value)
      ? value.toFixed(digits)
      : String(value);

/** Every input and output of this script under one cache root. */
export function remotePaths(cache: string) {
  const decisions = join(cache, "f3", "decisions-api");
  const freeze = join(cache, "f3", "freeze");
  return {
    fitScores: join(decisions, "dense", "scores", "fit-meanAB-bakeoff.json"),
    tuningScores: join(decisions, "dense", "scores", "tuning-meanAB-bakeoff.json"),
    labels: join(cache, "f3", "labels", "topup-2026-10-18", "merged", "f3-relation-labels.json"),
    proposal: join(freeze, "proposal.json"),
    remoteProposal: join(freeze, "proposal-decisions.json"),
    tuningExport: join(cache, "f3", "m1", "out", "m1-run-export.json"),
    mapping: join(cache, "golden", "matching-fixture", "mapping.json"),
    x1Export: join(freeze, "x1", "x1-s0-retrieval.json"),
    spikeFrozen: join(cache, "spikes", "reranker", "frozen.json"),
    spikeDataset: join(cache, "spikes", "reranker", "dataset.json"),
    benchmarkDirectory: join(cache, "matching-benchmark"),
    fixtureTexts: join(cache, "f3", "scratch", "t46a", "env-f-note-texts.json"),
    rv9Relations: join(cache, "f3", "labels", "r-v9", "relations.json"),
    freezePass: join(cache, "f3", "labels", "passes", "freeze", "tally.json"),
    gateDirectory: join(freeze, "gate-f", "decisions"),
    requests: join(decisions, "gate-f", "requests.json"),
    scores: join(decisions, "gate-f", "scores"),
    raw: join(decisions, "gate-f", "raw", "decisions-gate-f.jsonl")
  };
}
export type RemotePaths = ReturnType<typeof remotePaths>;

/** The frozen instruction of the request design, checked against the dense validation's fingerprint. */
async function readInstruction(
  path: string,
  fitFacts?: ScoreFileFacts & { designFingerprint?: string | null }
) {
  const frozen = z
    .object({ instruction: z.string().min(1) })
    .passthrough()
    .parse(await readJson(path));
  const sha = sha256Hex(frozen.instruction);
  if (fitFacts?.instructionSha256 && fitFacts.instructionSha256 !== sha)
    throw new Error(
      `The instruction of ${path} is not the one the fit scores were answered under.`
    );
  return frozen.instruction;
}

async function readRun(path: string): Promise<Record<string, unknown>> {
  const file = z
    .object({ run: z.record(z.string(), z.unknown()) })
    .passthrough()
    .parse(await readJson(path));
  return file.run;
}

// --- CLI ----------------------------------------------------------------------------------------------

export async function runRemoteCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "fit-scores": { type: "string" },
      "tuning-scores": { type: "string" },
      labels: { type: "string" },
      proposal: { type: "string" },
      "proposal-remote": { type: "string" },
      "tuning-export": { type: "string" },
      mapping: { type: "string" },
      "spike-frozen": { type: "string" },
      out: { type: "string" },
      refreeze: { type: "boolean" },
      "x1-export": { type: "string" },
      "fixture-texts": { type: "string" },
      "spike-dataset": { type: "string" },
      "benchmark-directory": { type: "string" },
      "eval-scores": { type: "string" },
      requests: { type: "string" },
      "env-file": { type: "string" },
      "dry-run": { type: "boolean" },
      concurrency: { type: "string" },
      scores: { type: "string" },
      "rv9-relations": { type: "string" },
      "rv9-pass": { type: "string" },
      "out-dir": { type: "string" },
      cache: { type: "string" },
      set: { type: "string" },
      "x1-scores": { type: "string" },
      "rv6-scores": { type: "string" }
    }
  });
  const command = positionals[0];
  const defaults = remotePaths(
    resolve(typeof values.cache === "string" ? values.cache : checkoutCache)
  );
  const path = (key: keyof typeof values, fallback: string) =>
    resolve(typeof values[key] === "string" ? (values[key] as string) : fallback);
  const paths = {
    ...defaults,
    fitScores: path("fit-scores", defaults.fitScores),
    tuningScores: path("tuning-scores", defaults.tuningScores),
    labels: path("labels", defaults.labels),
    proposal: path("proposal", defaults.proposal),
    remoteProposal: path("proposal-remote", defaults.remoteProposal),
    tuningExport: path("tuning-export", defaults.tuningExport),
    mapping: path("mapping", defaults.mapping),
    spikeFrozen: path("spike-frozen", defaults.spikeFrozen),
    x1Export: path("x1-export", defaults.x1Export),
    requests: path("requests", defaults.requests)
  };
  const selectInputs = async () => {
    const bytes = async (file: string) => sha256Hex(await readFile(file));
    const fit = await readScores(paths.fitScores);
    const tuning = await readScores(paths.tuningScores);
    const fitRun = await readRun(paths.fitScores);
    const instruction = await readInstruction(paths.spikeFrozen, fit.facts);
    if (fitRun.designFingerprint !== designFingerprint(instruction))
      throw new Error(
        "The fit scores were not answered under this request design (its fingerprint differs)."
      );
    if (fitRun.variant !== "meanAB" || (await readRun(paths.tuningScores)).variant !== "meanAB")
      throw new Error(
        "The Decisions decider is the mean of two orders: the scores must be meanAB."
      );
    const labels = labelFixtureSchema.parse(await readJson(paths.labels));
    const proposal = z
      .object({
        weighting: z
          .object({ weights: z.record(z.string(), z.number()), excludedPairs: z.array(z.string()) })
          .passthrough()
      })
      .passthrough()
      .parse(await readJson(paths.proposal));
    const tuningExport = retrievalExportSchema.parse(await readJson(paths.tuningExport));
    const mapping = matchingMappingSchema.parse(await readJson(paths.mapping));
    return {
      instruction,
      fit,
      tuning,
      labels,
      proposal,
      tuningExport,
      mapping,
      inputs: {
        fitScores: fit.facts.sha256,
        tuningScores: tuning.facts.sha256,
        labels: await bytes(paths.labels),
        labelSetSha256: labels.labelSetSha256,
        localProposal: await bytes(paths.proposal),
        tuningExport: await bytes(paths.tuningExport),
        mapping: await bytes(paths.mapping),
        instruction: sha256Hex(instruction)
      }
    };
  };

  if (command === "select") {
    const read = await selectInputs();
    const identity = decisionsIdentity(read.instruction);
    const proposed = proposeRemoteDecider({
      labels: read.labels,
      weights: read.proposal.weighting,
      fitScores: read.fit.scores,
      tuningScores: read.tuning.scores,
      tuningExport: read.tuningExport,
      lists: tuningLists(read.mapping),
      identity
    });
    const proposal: RemoteProposal = {
      format: "memora-f3-bakeoff-remote-proposal",
      version: 1,
      decider: "decisions",
      computedAt: new Date().toISOString(),
      inputs: read.inputs,
      instruction: {
        sha256: identity.instructionSha256,
        designFingerprint: designFingerprint(read.instruction)
      },
      requestDesign: decisionsRequestDesign(read.instruction),
      ...proposed
    };
    const out = resolve(typeof values.out === "string" ? values.out : paths.remoteProposal);
    await writeJson(out, proposal);
    await writeFile(out.replace(/\.json$/u, ".md"), renderRemoteProposal(proposal));
    console.info(renderRemoteProposal(proposal));
    return;
  }
  if (command === "freeze") {
    if (values.refreeze !== true)
      throw new Error("Adding a decider is a re-freeze (D3): pass --refreeze.");
    const frozenPath = resolve(frozenFileLocation());
    const previous = JSON.parse(await readFile(frozenPath, "utf8")) as RemoteFreezeRecord;
    if (previous.format !== "memora-f3-freeze")
      throw new Error(`${frozenPath} is not a freeze record.`);
    const proposalBytes = await readFile(paths.remoteProposal);
    const proposal = JSON.parse(proposalBytes.toString("utf8")) as RemoteProposal;
    const current = (await selectInputs()).inputs;
    for (const [key, hash] of Object.entries(proposal.inputs))
      if ((current as Record<string, string>)[key] !== hash)
        throw new Error(
          `The remote proposal's input ${key} changed since it was computed: run select again.`
        );
    const kept = frozenPath.replace(
      /\.json$/u,
      `-${previous.frozenAt.replace(/[:.]/gu, "-")}.json`
    );
    const record = addRemoteCalibration({
      previous,
      previousFile: kept,
      proposal,
      proposalSha256: sha256Hex(proposalBytes),
      frozenAt: new Date()
    });
    await rename(frozenPath, kept);
    await writeJson(frozenPath, record);
    console.info(
      `re-frozen ${record.configHash} at ${record.frozenAt} -> ${frozenPath}; the first freeze is kept as ${kept}`
    );
    return;
  }
  if (command === "requests") {
    const instruction = await readInstruction(paths.spikeFrozen);
    const fixtureTexts = await readNoteTexts(
      path("fixture-texts", defaults.fixtureTexts),
      decisionsBodyCharacters
    );
    const spikeDataset = path("spike-dataset", defaults.spikeDataset);
    const spike = await readSpikeNotes(
      spikeDataset,
      path("benchmark-directory", defaults.benchmarkDirectory)
    );
    // Synthetic text only: the fixture's notes and Spike A's benchmark notes.
    const text = (id: string): string => {
      const fixture = fixtureTexts.rendered.get(id);
      if (fixture) return fixture.text;
      const note = spike.notes.get(id);
      if (note) return renderNoteText(note, decisionsBodyCharacters);
      throw new Error(
        `Note ${id} is not a fixture or Spike A note: only synthetic text may be sent.`
      );
    };
    const x1 = retrievalExportSchema.parse(await readJson(paths.x1Export));
    const x1Pairs = x1.candidates.map((row) => [row.noteId, row.candidateId] as const);
    const labels = labelFixtureSchema.parse(await readJson(paths.labels));
    // R_v6 has no F3 retrieval export (Spike A's library), so its dense shape is approximated the
    // way F3 lists candidates: each Spike A note's nearest rows by cosine (K = fusedK), the notes whose
    // nearest rows hold it, and its R_v6 partner.
    const dataset = z
      .object({
        rows: z.array(
          z.object({ query: z.string(), doc: z.string(), cosine: z.number() }).passthrough()
        )
      })
      .passthrough()
      .parse(await readJson(spikeDataset));
    const rv6 = labels.items.filter((item) => item.sets.includes("rv6"));
    const rv6Notes = new Set(rv6.flatMap((item) => [item.lo, item.hi]));
    const rv6Pairs: Array<readonly [string, string]> = [
      ...nearestRows(dataset.rows, relationsConfig.retrieval.fusedK),
      ...rv6.map((item) => [item.lo, item.hi] as const)
    ];
    const rv6Neighbourhoods = new Map(
      [...neighbourhoods(rv6Pairs)].filter(([note]) => rv6Notes.has(note))
    );
    // The eval split of pool A (fixture): pairs not already scored in the dense fit or tuning requests,
    // each note's M1 neighbourhood plus the labelled partner. Pools B and C are public, not synthetic:
    // they are read only where earlier dense requests already scored them.
    const existing = new Set<string>();
    for (const file of [paths.fitScores, paths.tuningScores])
      for (const key of (await readScores(file)).scores.keys()) existing.add(key);
    const m1 = retrievalExportSchema.parse(await readJson(paths.tuningExport));
    const m1Neighbourhoods = neighbourhoods(
      m1.candidates.map((row) => [row.noteId, row.candidateId] as const)
    );
    const evalMissing = labels.items.filter(
      (item) =>
        item.kind === "note" &&
        item.split === "eval" &&
        item.pool === "A" &&
        item.related !== null &&
        !(existing.has(`${item.lo}>${item.hi}`) && existing.has(`${item.hi}>${item.lo}`))
    );
    const evalNeighbourhoods = new Map<string, string[]>();
    for (const item of evalMissing)
      for (const [note, partner] of [
        [item.lo, item.hi],
        [item.hi, item.lo]
      ] as const)
        evalNeighbourhoods.set(
          note,
          [
            ...new Set([
              ...(evalNeighbourhoods.get(note) ?? m1Neighbourhoods.get(note) ?? []),
              partner
            ])
          ].sort()
        );
    const planned = [
      ...planRequests({ set: "x1", neighbourhoods: neighbourhoods(x1Pairs), text, instruction }),
      ...planRequests({ set: "rv6", neighbourhoods: rv6Neighbourhoods, text, instruction }),
      ...planRequests({ set: "eval-A", neighbourhoods: evalNeighbourhoods, text, instruction })
    ];
    const chars = planned.reduce((total, job) => total + JSON.stringify(job.request).length, 0);
    const charsPerToken = 2.23;
    const tokens = Math.ceil(chars / charsPerToken);
    const bySet = Object.fromEntries(
      ["x1", "rv6", "eval-A"].map((set) => [set, planned.filter((job) => job.set === set).length])
    );
    await writeJson(paths.requests, {
      format: "memora-f3-decisions-gate-f-requests",
      version: 1,
      instructionSha256: sha256Hex(instruction),
      designFingerprint: designFingerprint(instruction),
      requestDesignSha256: decisionsRequestDesignSha256(instruction),
      evalMissing: evalMissing.map((item) => [item.lo, item.hi]),
      jobs: planned
    });
    console.info(
      `${planned.length} requests (${JSON.stringify(bySet)}), ${chars} characters, about ${tokens} input tokens = US$ ${costUsd(tokens).toFixed(4)} at ${charsPerToken} characters per token (the dense run's); cap US$ ${decisionsGateFCapUsd}; pool A eval pairs to score ${evalMissing.length}`
    );
    return;
  }
  if (command === "run") {
    const file = z
      .object({ jobs: z.array(z.unknown()) })
      .passthrough()
      .parse(await readJson(paths.requests));
    const jobs = file.jobs as PlannedRequest[];
    await runLive(jobs, paths.raw, {
      dryRun: values["dry-run"] === true,
      concurrency: Number(values.concurrency ?? 2),
      envFile: typeof values["env-file"] === "string" ? resolve(values["env-file"]) : undefined
    });
    return;
  }
  if (command === "scores") {
    const set = typeof values.set === "string" ? values.set : null;
    if (!set)
      throw new Error(
        "scores needs --set <x1|rv6|eval-A>: each set's answers stay in their own requests."
      );
    const file = z
      .object({
        jobs: z.array(z.unknown()),
        instructionSha256: z.string(),
        designFingerprint: z.string(),
        requestDesignSha256: z.string()
      })
      .passthrough()
      .parse(await readJson(paths.requests));
    const jobs = (file.jobs as PlannedRequest[]).filter((job) => job.set === set);
    const out = path("out", join(paths.scores, `decisions-${set}-meanAB.json`));
    const records = await readRecords(paths.raw);
    const answers: Array<{
      order: "A" | "B";
      query: string;
      doc: string;
      probability: number | null;
    }> = [];
    let missingRequests = 0;
    for (const job of jobs) {
      const record = records.get(`${job.order}:${job.key}`);
      if (!record) {
        missingRequests++;
        continue;
      }
      for (const answer of predicatesOf(record)) answers.push({ order: job.order, ...answer });
    }
    const { scores, incomplete } = meanOfOrders(answers);
    await writeJson(out, {
      format: pairScoresFormat,
      version: 1,
      decider: `openai-decisions:${decisionsModel} predicate, dense requests, both directions, meanAB, log-odds at epsilon ${decisionsEpsilon}`,
      scale: "log-odds",
      scores,
      run: {
        task: "T58-decisions-gate-f",
        set,
        variant: "meanAB",
        instructionSha256: file.instructionSha256,
        designFingerprint: file.designFingerprint,
        requestDesignSha256: file.requestDesignSha256,
        model: decisionsModel,
        shuffleSalts: [...decisionsOrderSalts],
        missingRequests,
        incompletePairs: incomplete
      }
    });
    console.info(
      `${set}: ${scores.length} directed meanAB scores; ${missingRequests} requests without an answer; ${incomplete} pairs with one order only -> ${out}`
    );
    return;
  }
  if (command === "gate-f") {
    requireHeldOut(await readHeldOutAccess());
    const record = JSON.parse(
      await readFile(resolve(frozenFileLocation()), "utf8")
    ) as RemoteFreezeRecord;
    const entry = record.calibrations.find(
      (candidate) => candidate.identity.runtimeKind === "remote"
    );
    if (!entry || entry.kind !== "isotonic")
      throw new Error("The freeze holds no Decisions calibration.");
    const design = (entry.identity as RemoteRelationCalibrationIdentity).requestDesignSha256;
    const readSet = async (files: readonly string[]): Promise<DirectedScores> => {
      const scores: DirectedScores = new Map();
      for (const file of files) {
        const run = await readRun(file);
        // The dense validation's files name the spike fingerprint; this card's the whole design's.
        if (run.requestDesignSha256 !== undefined && run.requestDesignSha256 !== design)
          throw new Error(`${file} was answered under another request design.`);
        for (const [key, value] of (await readScores(file)).scores)
          if (!scores.has(key)) scores.set(key, value);
      }
      return scores;
    };
    const list = (key: "x1-scores" | "rv6-scores" | "eval-scores", fallback: string[]) =>
      typeof values[key] === "string"
        ? (values[key] as string).split(",").map((file) => resolve(file))
        : fallback;
    const result = await decisionsGateF({
      record,
      entry,
      x1Scores: await readSet(list("x1-scores", [join(paths.scores, "decisions-x1-meanAB.json")])),
      rv6Scores: await readSet(
        list("rv6-scores", [join(paths.scores, "decisions-rv6-meanAB.json")])
      ),
      evalScores: await readSet(
        list("eval-scores", [
          join(paths.scores, "decisions-eval-A-meanAB.json"),
          paths.fitScores,
          paths.tuningScores
        ])
      ),
      x1: retrievalExportSchema.parse(await readJson(paths.x1Export)),
      labels: labelFixtureSchema.parse(await readJson(paths.labels)),
      mapping: matchingMappingSchema.parse(await readJson(paths.mapping)),
      weights: z
        .object({
          weighting: z
            .object({
              weights: z.record(z.string(), z.number()),
              excludedPairs: z.array(z.string())
            })
            .passthrough()
        })
        .passthrough()
        .parse(await readJson(paths.proposal)).weighting,
      rv9Relations: z
        .array(
          z
            .object({
              source_note: z.string(),
              target_note: z.string(),
              source_root: z.string(),
              target_root: z.string()
            })
            .passthrough()
        )
        .parse(await readJson(path("rv9-relations", defaults.rv9Relations))),
      passes: await Promise.all(
        (typeof values["rv9-pass"] === "string"
          ? values["rv9-pass"].split(",")
          : [defaults.freezePass]
        ).map(async (file) =>
          z
            .object({
              items: z.array(
                z
                  .object({
                    lo: z.string(),
                    hi: z.string(),
                    related: z.object({ majority: z.boolean().nullable() })
                  })
                  .passthrough()
              )
            })
            .passthrough()
            .parse(await readJson(resolve(file)))
        )
      )
    });
    const outDir = path("out-dir", defaults.gateDirectory);
    await writeJson(join(outDir, "gate-f-decisions.json"), result);
    await writeFile(join(outDir, "gate-f-decisions.md"), renderDecisionsGateF(result));
    console.info(renderDecisionsGateF(result));
    return;
  }
  throw new Error("The command is select, freeze, requests, run, scores or gate-f.");
}

// --- live calls -----------------------------------------------------------------------------------------

async function readRecords(rawFile: string): Promise<Map<string, RawRecord>> {
  const out = new Map<string, RawRecord>();
  let text = "";
  try {
    text = await readFile(rawFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as RawRecord & { order: "A" | "B" };
    if (record.ok) out.set(`${record.order}:${record.key}`, record);
  }
  return out;
}

async function spentSoFar(rawFile: string): Promise<{ inputTokens: number; records: RawRecord[] }> {
  let text = "";
  try {
    text = await readFile(rawFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const records = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RawRecord);
  return {
    inputTokens: records.reduce((total, record) => total + (record.usage?.inputTokens ?? 0), 0),
    records
  };
}

async function runLive(
  jobs: PlannedRequest[],
  rawFile: string,
  options: { dryRun: boolean; concurrency: number; envFile: string | undefined }
) {
  const done = await readRecords(rawFile);
  const pending = jobs.filter((job) => !done.has(`${job.order}:${job.key}`));
  const spent = await spentSoFar(rawFile);
  const charsPerToken = spent.records.length ? observedCharsPerToken(spent.records) : 2.23 * 0.85;
  const projected = Math.ceil(
    pending.reduce((total, job) => total + JSON.stringify(job.request).length, 0) / charsPerToken
  );
  console.info(
    `${jobs.length} requests (${jobs.length - pending.length} done, ${pending.length} to send); projected US$ ${costUsd(projected).toFixed(4)}; spent US$ ${costUsd(spent.inputTokens).toFixed(4)}; cap US$ ${decisionsGateFCapUsd}`
  );
  if (costUsd(spent.inputTokens + projected) > decisionsGateFCapUsd)
    throw new Error(`The projection exceeds the cap of US$ ${decisionsGateFCapUsd}: nothing sent.`);
  if (options.dryRun || pending.length === 0) return;
  const client = new DecisionsClient({ apiKey: await readApiKey(options.envFile) });
  await mkdir(dirname(rawFile), { recursive: true });
  const abort = new AbortController();
  let tokens = spent.inputTokens;
  let next = 0,
    sent = 0,
    failed = 0,
    consecutive = 0;
  let stopped: string | null = null;
  const stop = (reason: string) => {
    if (stopped) return;
    stopped = reason;
    abort.abort();
  };
  const worker = async () => {
    for (;;) {
      if (abort.signal.aborted) return;
      const job = pending[next++];
      if (!job) return;
      const base = {
        runId: "decisions-gate-f",
        key: job.key,
        order: job.order,
        kind: "decisions-gate-f/predicate",
        meta: job.meta as unknown as Record<string, unknown>,
        at: new Date().toISOString(),
        questions: job.request.questions.length,
        bodyChars: JSON.stringify(job.request).length
      };
      let record: RawRecord & { order: "A" | "B" };
      try {
        const result = await client.decide(job.request, abort.signal);
        const named = result.answers.length === job.request.questions.length;
        record = {
          ...base,
          ok: named,
          ...(named
            ? {}
            : { error: { kind: "answers", status: 200, message: "answer count differs" } }),
          model: result.model,
          usage: {
            inputTokens: result.usage.input_tokens,
            cachedTokens: result.usage.input_tokens_details?.cached_tokens ?? 0,
            outputTokens: result.usage.output_tokens ?? 0,
            reasoningTokens: result.usage.output_tokens_details?.reasoning_tokens ?? 0
          },
          requestId: result.requestId,
          totalMs: result.totalMs,
          answers: result.answers
        };
      } catch (error) {
        const failure =
          error instanceof DecisionsError
            ? error
            : new DecisionsError("network", redactSecrets(String(error)).slice(0, 200), null, []);
        if (failure.kind === "aborted") return;
        record = {
          ...base,
          ok: false,
          error: { kind: failure.kind, status: failure.status, message: failure.message }
        };
        if (failure.kind === "auth" || failure.kind === "quota") stop(`${failure.kind} error`);
      }
      await appendFile(rawFile, `${JSON.stringify(record)}\n`);
      sent++;
      tokens += record.usage?.inputTokens ?? 0;
      if (record.ok) consecutive = 0;
      else if (++consecutive >= 6) stop("6 consecutive failures");
      if (!record.ok) failed++;
      if (costUsd(tokens) > decisionsGateFCapUsd) stop("the cap is reached");
      if (sent % 50 === 0 || sent === pending.length)
        console.info(
          `${sent}/${pending.length} sent, ${failed} failed, spent US$ ${costUsd(tokens).toFixed(4)}`
        );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, () => worker()));
  console.info(
    `sent ${sent}, failed ${failed}, spent US$ ${costUsd(tokens).toFixed(4)}${stopped ? `, stopped: ${stopped}` : ""}`
  );
  if (stopped) process.exitCode = 1;
}

// --- gate F ---------------------------------------------------------------------------------------------

export interface DecisionsGateF {
  configHash: string;
  frozenAt: string;
  readAt: string;
  calibration: { applyFrom: number | null; suggestFrom: number | null; rule: string };
  x1: RootLevel & { tuning: RootLevel; reached: number; scoredPairs: number; decidedPairs: number };
  rv6: ReverseOnlyLoss & { scored: number };
  rv9: ReverseOnlyLoss;
  cleanCheck: {
    labels: number;
    byPool: Record<string, number>;
    uncovered: number;
    precisionAtApply: number | null;
    precisionAtSuggest: number | null;
    recallAtAccept: number | null;
    ece: number | null;
    brier: number | null;
  };
}

export async function decisionsGateF(input: {
  record: RemoteFreezeRecord;
  entry: Extract<RelationCalibrationEntry, { kind: "isotonic" }>;
  x1Scores: DirectedScores;
  rv6Scores: DirectedScores;
  evalScores: DirectedScores;
  x1: z.infer<typeof retrievalExportSchema>;
  labels: LabelFixture;
  mapping: z.infer<typeof matchingMappingSchema>;
  weights: { weights: Record<string, number>; excludedPairs: readonly string[] };
  rv9Relations: ReadonlyArray<{
    source_note: string;
    target_note: string;
    source_root: string;
    target_root: string;
  }>;
  passes: ReadonlyArray<{
    items: ReadonlyArray<{ lo: string; hi: string; related: { majority: boolean | null } }>;
  }>;
  now?: () => Date;
}): Promise<DecisionsGateF> {
  const calibration: Calibration = {
    blocks: input.entry.blocks,
    applyFrom: input.entry.applyFrom,
    suggestFrom: input.entry.suggestFrom,
    rule: input.entry.identity.rule
  };
  const scores = input.x1Scores;
  const heldOut = rootLevel({
    data: input.x1,
    scores,
    calibration,
    lists: listsOf(input.mapping, "holdout")
  });
  const tuning = rootLevel({
    data: input.x1,
    scores,
    calibration,
    lists: listsOf(input.mapping, "tuning")
  });
  const decided = input.x1.decisions.length;
  const scoredPairs = input.x1.decisions.filter(
    (row) => scores.has(`${row.lo}>${row.hi}`) && scores.has(`${row.hi}>${row.lo}`)
  ).length;
  if (scoredPairs !== decided)
    throw new Error(
      `${decided - scoredPairs} decided S0 pairs have no Decisions score in both directions.`
    );
  const rv6Items = input.labels.items.filter((item) => item.sets.includes("rv6"));
  const rv6 = reverseOnlyLossR6({
    items: input.labels.items,
    scores: input.rv6Scores,
    calibration
  });
  const rv6Scored = rv6Items.filter(
    (item) =>
      input.rv6Scores.has(`${item.lo}>${item.hi}`) && input.rv6Scores.has(`${item.hi}>${item.lo}`)
  ).length;
  const accepted = new Set(
    acceptedPairs({ data: input.x1, scores, calibration }).map((pair) =>
      notePairKey(pair.lo, pair.hi)
    )
  );
  const known = new Map<string, boolean>();
  for (const item of input.labels.items)
    if (item.related !== null) known.set(notePairKey(item.lo, item.hi), item.related);
  for (const pass of input.passes)
    for (const item of pass.items)
      if (item.related.majority !== null)
        known.set(notePairKey(item.lo, item.hi), item.related.majority);
  const rv9 = reverseOnlyLossR9({
    pairs: input.rv9Relations.map((row) => ({
      lo: row.source_note,
      hi: row.target_note,
      sameRoot: row.source_root === row.target_root
    })),
    accepted,
    sample: input.labels.items
      .filter((item) => item.sets.includes("rv9-sample") && item.related !== null)
      .map((item) => ({ lo: item.lo, hi: item.hi, related: item.related! })),
    labels: known
  });
  // The clean check: the eval labels whose both directions were answered in a dense request.
  const evalLabels = weightedPoolLabels(
    input.labels,
    {
      weightOf: new Map(Object.entries(input.weights.weights)),
      excluded: new Set(input.weights.excludedPairs)
    },
    "eval"
  );
  const covered = evalLabels.filter(
    (label) =>
      input.evalScores.has(`${label.lo}>${label.hi}`) &&
      input.evalScores.has(`${label.hi}>${label.lo}`)
  );
  const scored = scoredLabels(
    covered,
    input.evalScores,
    calibration.rule,
    "the Decisions eval scores"
  );
  const points = scored.map((label) => ({
    ...label,
    probability: calibrate(label.score, calibration.blocks)
  }));
  const at = (edge: number | null) =>
    edge === null
      ? null
      : (weightedPrecision(points.filter((point) => point.score >= edge))?.precision ?? null);
  const acceptFrom = calibration.suggestFrom ?? calibration.applyFrom;
  const positives = points
    .filter((point) => point.positive)
    .reduce((total, point) => total + point.weight, 0);
  return {
    configHash: input.record.configHash,
    frozenAt: input.record.frozenAt,
    readAt: (input.now ?? (() => new Date()))().toISOString(),
    calibration: {
      applyFrom: calibration.applyFrom,
      suggestFrom: calibration.suggestFrom,
      rule: calibration.rule
    },
    x1: {
      ...heldOut,
      tuning,
      reached: heldOut.expectedOf - heldOut.missed.filter((row) => !row.reached).length,
      scoredPairs,
      decidedPairs: decided
    },
    rv6: { ...rv6, scored: rv6Scored },
    rv9,
    cleanCheck: {
      labels: points.length,
      byPool: Object.fromEntries(
        pools.map((pool) => [pool, points.filter((point) => point.pool === pool).length])
      ),
      uncovered: evalLabels.length - covered.length,
      precisionAtApply: at(calibration.applyFrom),
      precisionAtSuggest: at(calibration.suggestFrom),
      recallAtAccept:
        acceptFrom === null || positives === 0
          ? null
          : points
              .filter((point) => point.positive && point.score >= acceptFrom)
              .reduce((total, point) => total + point.weight, 0) / positives,
      ece: points.length ? expectedCalibrationError(points).ece : null,
      brier: points.length ? brierScore(points) : null
    }
  };
}

// --- reports --------------------------------------------------------------------------------------------

export function renderRemoteProposal(proposal: RemoteProposal): string {
  const { bands, tuning, threshold } = proposal;
  return [
    "# The Decisions API decider: D18 on dense two-order requests (plan decision 30)",
    "",
    `Computed ${proposal.computedAt}. Identity: ${proposal.identity.provider}/${proposal.identity.model}, instruction sha256 ${proposal.identity.instructionSha256.slice(0, 12)}..., request design ${proposal.identity.requestDesignSha256.slice(0, 12)}... (spike fingerprint ${proposal.instruction.designFingerprint.slice(0, 12)}...), rule ${proposal.identity.rule}, ${proposal.identity.bodyCharacters} characters. Fit labels ${proposal.fitLabels.labels} (${proposal.fitLabels.positives} related), folds seed ${proposal.folds.seed}, cell weights of the local proposal.`,
    "",
    "| From score | P |",
    "| ---: | ---: |",
    ...proposal.blocks.map(
      (block) => `| ${fmt(block.fromScore, 4)} | ${fmt(block.probability, 4)} |`
    ),
    "",
    `- D18: p_apply ${fmt(bands.pApply, 4)} (apply from s >= ${fmt(bands.applyFromScore, 4)}; cross-validated precision ${fmt(bands.apply?.precision)}, Wilson ${fmt(bands.apply?.wilsonLower)}, n_eff ${fmt(bands.apply?.effectiveCount, 1)}, ${bands.apply?.labels ?? 0} labels), p_suggest ${fmt(bands.pSuggest, 4)} (suggest from s >= ${fmt(bands.suggestFromScore, 4)}; precision ${fmt(bands.suggest?.precision)}, ${bands.suggest?.labels ?? 0} labels).`,
    `- Fixture tuning at the bands: ${tuning.expected}/${tuning.expectedOf} expected (pessimistic ${tuning.expectedPessimistic}, applied ${tuning.expectedApplied}), forbidden ${tuning.forbidden}/${tuning.forbiddenOf} (before typing ${tuning.forbiddenBeforeTyping}).`,
    `- Decision 29's tuning edge (reported, not frozen): ${threshold?.edge === null || threshold === null ? "none" : `s >= ${fmt(threshold.edge, 4)}`}, ${threshold?.expectedBeforeTyping ?? 0}/${threshold?.expectedOf ?? 0} expected at ${threshold?.forbiddenBeforeTyping ?? 0} forbidden; panel at it ${fmt(threshold?.panel.pooled?.precision)} (Wilson ${fmt(threshold?.panel.pooled?.wilson)}, ${threshold?.panel.pooled?.labels ?? 0} labels).`,
    `- Cross-validated quality: ECE ${fmt(proposal.cvQuality.ece)}, Brier ${fmt(proposal.cvQuality.brier)}, AUC ${fmt(proposal.cvQuality.auc)} (A ${fmt(proposal.cvQuality.aucByPool.A)}, B ${fmt(proposal.cvQuality.aucByPool.B)}, C ${fmt(proposal.cvQuality.aucByPool.C)}).`,
    `- The accept band by pool (cross-validated): ${pools.map((pool) => `${pool} ${fmt(proposal.acceptByPool[pool]?.precision)} (${proposal.acceptByPool[pool]?.labels ?? 0} labels, recall ${fmt(proposal.acceptByPool[pool]?.recall)})`).join("; ")}.`,
    ""
  ].join("\n");
}

export function renderDecisionsGateF(result: DecisionsGateF): string {
  const pass = (ok: boolean | null) => (ok === null ? "pending" : ok ? "pass" : "FAIL");
  const loss = (row: ReverseOnlyLoss) =>
    row.loss === null
      ? `pending (${row.unlabelledLost} lost pairs unlabelled)`
      : `${fmt(row.loss)}${row.interval ? ` [${fmt(row.interval[0])}, ${fmt(row.interval[1])}]` : ""}`;
  const { x1, rv6, rv9, cleanCheck } = result;
  return [
    `# Gate F reads of the Decisions decider (frozen ${result.configHash.slice(0, 16)} at ${result.frozenAt}; read ${result.readAt})`,
    "",
    `Bands: apply from s >= ${fmt(result.calibration.applyFrom, 4)}, suggest from s >= ${fmt(result.calibration.suggestFrom, 4)} (${result.calibration.rule} of both directions, mean of two orders).`,
    "",
    "| Check | Value | Bar | Verdict |",
    "| --- | --- | --- | --- |",
    `| X1 held-out expected (optimistic typing) | ${x1.expected}/${x1.expectedOf} | >= 27/28 | ${pass(x1.expected >= 27)} |`,
    `| X1 held-out forbidden | ${x1.forbidden}/${x1.forbiddenOf} | 0/35 | ${pass(x1.forbidden === 0)} |`,
    `| X1 applied only (the apply band) | ${x1.expectedApplied}/${x1.expectedOf} | reported | - |`,
    `| X1 pessimistic (only typed pairs) | ${x1.expectedPessimistic}/${x1.expectedOf} | reported | - |`,
    `| Held-out candidate recall | ${x1.reached}/${x1.expectedOf} | reported | - |`,
    `| Tuning in the same export | ${x1.tuning.expected}/${x1.tuning.expectedOf}, ${x1.tuning.forbidden}/${x1.tuning.forbiddenOf} forbidden (applied ${x1.tuning.expectedApplied}) | reported | - |`,
    `| X2 R_v6 loss (panel-related) | ${loss(rv6)} | <= 0.05 | ${pass(rv6.loss === null ? null : rv6.loss <= 0.05)} |`,
    `| X2 R_v6 literal loss | ${rv6.lost}/${rv6.pairs} (${fmt(rv6.literalLoss)}); same-root ${rv6.sameRoot.lost}/${rv6.sameRoot.pairs}; scored ${rv6.scored}/${rv6.pairs} | reported | - |`,
    `| X2 R_v9 loss (panel-related) | ${loss(rv9)} | <= 0.05 | ${pass(rv9.loss === null ? null : rv9.loss <= 0.05)} |`,
    `| X2 R_v9 literal loss | ${rv9.lost}/${rv9.pairs} (${fmt(rv9.literalLoss)}); same-root ${rv9.sameRoot.lost}/${rv9.sameRoot.pairs} | reported | - |`,
    "",
    `Clean check (the eval split's labels answered in a dense request; nothing chosen on them): ${cleanCheck.labels} labels (${pools.map((pool) => `${pool} ${cleanCheck.byPool[pool] ?? 0}`).join(", ")}; ${cleanCheck.uncovered} not covered), precision at apply ${fmt(cleanCheck.precisionAtApply)}, at suggest ${fmt(cleanCheck.precisionAtSuggest)}, recall at the accept band ${fmt(cleanCheck.recallAtAccept)}, ECE ${fmt(cleanCheck.ece)}, Brier ${fmt(cleanCheck.brier)}.`,
    "",
    `Held-out expected missed: ${x1.missed.map((row) => `${row.pair} (${row.reached ? `best ${fmt(row.bestScore)}` : "not reached"})`).join("; ") || "none"}; forbidden linked: ${x1.forbiddenLinked.join(" ") || "none"}.`,
    ""
  ].join("\n");
}

if (import.meta.main) {
  try {
    await runRemoteCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[relations/bakeoff-remote] ${redactSecrets(error instanceof Error ? error.message : String(error))}`
    );
    process.exitCode = 1;
  }
}

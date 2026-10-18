/**
 * The Decisions decider's calibration on the product's own requests (plan decision 30, T58).
 *
 * The product asks online: a note's turn sends one forward list (its retrieval targets and, as room
 * allows, the notes it was decided against before, in content order, `decisionsNeighbourhood`) and
 * one reverse list per candidate (the candidate as the query, the note as its one target, and the
 * candidate's own earlier partners), through `planDecisionRequests` (balanced chunks of 20, the two
 * candidate orders). This script replays the libraries the fit labels and the fixture partitions come
 * from in arrival order through that very builder, so "partners decided so far" builds up as in a
 * live library, and scores the requests on the Decisions API:
 *
 *   npx tsx scripts/relations/bakeoff-online.ts plan [--with-eval]   the lists and requests; projects the cost
 *   npx tsx scripts/relations/bakeoff-online.ts run --phase 1|2 [--env-file <.env>] [--dry-run]   live, capped
 *   npx tsx scripts/relations/bakeoff-online.ts scores                 directed score files from the answers
 *   npx tsx scripts/relations/bakeoff-online.ts select [--seeds 20261022,1000,1001,1002]
 *   npx tsx scripts/relations/bakeoff-online.ts freeze --refreeze
 *   npx tsx scripts/relations/bakeoff-online.ts gate-f
 *
 * Libraries: the fixture's S0 export (M1's tuning turns are its first 111, unchanged; then the 27
 * held-out notes), ENV-G's golden export (pool B, the export's note order) and ENV-C's 200-note sample
 * (pool C; the library around the sample has no turns of its own, so a library note's partners are the
 * sample's earlier decisions only). R_v6's Spike A library has no F3 export: its turns take each
 * note's 10 nearest earlier notes by Spike A's cosine. A labelled pair the retrieval did not produce
 * is added as an extra target to its later note's forward list (a variant list, scored for that label
 * only), as the dense validation did. Reverse lists follow the product's lossless filter: a direction
 * whose forward probability is 0 in both orders is not asked back (its pair cannot reach any edge
 * above 0); labelled pairs are always asked back, so every label has an exact score.
 *
 * Text: the synthetic fixture and Spike A notes, and the public golden and corpus texts (the owner's
 * approval for the dense validation). The key is read from `.env` at run time and never printed.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  buildDecisionsWireRequest,
  combineDecisionAnswers,
  decisionsNeighbourhood,
  decisionsRequestDesign,
  decisionsRequestDesignSha256,
  planDecisionRequests,
  readDecisionsAnswers,
  resolveDecisionsLimits,
  type DecisionsLimits,
  type DecisionsWireRequest
} from "@app/ai";
import {
  promptDefinition,
  relationDecideDecisionsContract,
  relationPairTextTemplate,
  relationsConfig,
  renderRelationPairText,
  type RemoteRelationCalibrationIdentity
} from "@app/domain";
import { z } from "zod";

import { compareContent, contentKey } from "../../apps/desktop/src/main/services/content-order.ts";
import { frozenFileLocation, readHeldOutAccess, requireHeldOut } from "../golden/freeze-guard.ts";
import { matchingMappingSchema } from "../golden/matching-fixture.ts";
import { notePairKey } from "../golden/relations-export.ts";
import { DecisionsClient, DecisionsError } from "../spikes/decisions/client.ts";
import { readApiKey, redactSecrets } from "../spikes/decisions/env.ts";
import {
  freezeDirectory,
  labelFixtureSchema,
  retrievalExportSchema,
  sha256Hex,
  tuningLists,
  type DirectedScores
} from "./bakeoff.ts";
import {
  addRemoteCalibration,
  decisionsGateF,
  proposeRemoteDecider,
  renderDecisionsGateF,
  renderRemoteProposal,
  type RemoteFreezeRecord,
  type RemoteProposal
} from "./bakeoff-remote.ts";
import { readSpikeNotes } from "./bakeoff-sets.ts";
import { noteTextsSchema, type StoredNote } from "./note-texts.ts";
import { pairScoresFormat } from "./pair-scoring.ts";

const checkoutCache = dirname(dirname(freezeDirectory));
export const onlineCapUsd = 1;

/** The basis a frozen entry of the product's request design records. */
export const onlineBasis = (proposal: Pick<RemoteProposal, "bands" | "folds">): string =>
  `D18 on the product's online requests (plan decision 30): p_apply ${proposal.bands.pApply ?? "none"}, p_suggest ${proposal.bands.pSuggest ?? "none"}, cross-validated (seed ${proposal.folds.seed}), cell weights, 0 forbidden tuning root pairs`;

// --- The identity ---------------------------------------------------------------------------------

/** The catalog's Decisions instruction (`relations.decisions.instruction`), as the product renders it. */
export const decisionsInstruction = (): string =>
  promptDefinition("relations.decisions.instruction").fields.find((field) => field.id === "body")!
    .template;

/** The product's calibration identity of the Decisions decider (`decisionsDesign` in the desktop app). */
export function productDecisionsIdentity(
  instruction: string,
  limits: DecisionsLimits,
  bodyCharacters = relationsConfig.decide.bodyCharacters
): RemoteRelationCalibrationIdentity {
  return {
    contract: relationDecideDecisionsContract,
    instructionSha256: sha256Hex(instruction),
    template: relationPairTextTemplate,
    bodyCharacters,
    rule: relationsConfig.decide.rule,
    provider: "openai",
    model: limits.model,
    runtimeKind: "remote",
    requestDesignSha256: decisionsRequestDesignSha256(instruction, limits, bodyCharacters)
  };
}

// --- The online replay (pure) ------------------------------------------------------------------------

export type Direction = "loToHi" | "hiToLo";

/** One list a turn sends: the query note and its neighbourhood, with the directions read from it. */
export interface OnlineList {
  set: string;
  kind: "forward" | "reverse" | "forward-injected" | "reverse-injected";
  turn: string;
  query: string;
  /** The neighbourhood in content order: what the request carries. */
  members: string[];
  wanted: Array<{ member: string; pair: string; direction: Direction }>;
  /** A reverse list is asked only when its pair's forward probability is above 0 (the product's filter). */
  filterPair: string | null;
}

const directionOf = (query: string, member: string): Direction =>
  query < member ? "loToHi" : "hiToLo";

/**
 * Replays a library in arrival order through the product's request makeup. Every turn is simulated,
 * so the partners of later requests are those a live library would have; `emit` chooses the turns
 * whose lists are returned. A turn's forward list carries the note's targets and its partners decided
 * before the turn; then each candidate's reverse list carries the note and the candidate's partners,
 * the turn's own forward decisions included (the product stores them first).
 */
export function replayOnline(input: {
  set: string;
  order: readonly string[];
  targets: ReadonlyMap<string, readonly string[]>;
  compare: (left: string, right: string) => number;
  maxNeighbourhood: number;
  emit: (turn: string) => boolean;
  /** Labelled partners the retrieval did not produce, per turn: added in variant lists only. */
  injected?: ReadonlyMap<string, readonly string[]>;
  /** Pairs whose reverse lists are always asked (labels). */
  always?: ReadonlySet<string>;
  /**
   * Which reverse lists of an emitted turn are returned: all of them (a partition read whole), or
   * only the `always` pairs' (a library read for its labels: the turn's forward list, then each
   * labelled pair's reverse list).
   */
  reverse?: "all" | "always";
}): OnlineList[] {
  const partners = new Map<string, Set<string>>();
  const stored = new Map<string, Set<Direction>>();
  const lists: OnlineList[] = [];
  const objects = (ids: readonly string[]) => ids.map((id) => ({ id }));
  const neighbourhood = (targets: readonly string[], known: Iterable<string>) =>
    decisionsNeighbourhood({
      targets: objects(targets),
      partners: objects([...known].filter((id) => !targets.includes(id))),
      maxNeighbourhood: input.maxNeighbourhood,
      compare: (left, right) => input.compare(left.id, right.id)
    }).map((note) => note.id);
  const decide = (a: string, b: string, direction: Direction) => {
    const key = notePairKey(a, b);
    (stored.get(key) ?? stored.set(key, new Set()).get(key)!).add(direction);
    (partners.get(a) ?? partners.set(a, new Set()).get(a)!).add(b);
    (partners.get(b) ?? partners.set(b, new Set()).get(b)!).add(a);
  };
  for (const note of input.order) {
    const targets = [...new Set(input.targets.get(note) ?? [])].filter((id) => id !== note);
    const before = [...(partners.get(note) ?? [])];
    const emit = input.emit(note);
    const forward = targets.filter((c) => {
      const done = stored.get(notePairKey(note, c));
      return !(done?.has("loToHi") && done.has("hiToLo")) && !done?.has(directionOf(note, c));
    });
    const backward = targets.filter((c) => {
      const done = stored.get(notePairKey(note, c));
      return !(done?.has("loToHi") && done.has("hiToLo")) && !done?.has(directionOf(c, note));
    });
    if (emit && forward.length > 0)
      lists.push({
        set: input.set,
        kind: "forward",
        turn: note,
        query: note,
        members: neighbourhood(targets, before),
        wanted: forward.map((c) => ({
          member: c,
          pair: notePairKey(note, c),
          direction: directionOf(note, c)
        })),
        filterPair: null
      });
    for (const c of forward) decide(note, c, directionOf(note, c));
    const extra = (input.injected?.get(note) ?? []).filter(
      (id) => id !== note && !targets.includes(id)
    );
    if (emit && extra.length > 0)
      lists.push({
        set: input.set,
        kind: "forward-injected",
        turn: note,
        query: note,
        members: neighbourhood([...targets, ...extra], before),
        wanted: extra.map((c) => ({
          member: c,
          pair: notePairKey(note, c),
          direction: directionOf(note, c)
        })),
        filterPair: null
      });
    for (const c of backward) {
      const pair = notePairKey(note, c);
      if (emit && (input.reverse !== "always" || input.always?.has(pair))) {
        lists.push({
          set: input.set,
          kind: "reverse",
          turn: note,
          query: c,
          members: neighbourhood([note], partners.get(c) ?? []),
          wanted: [{ member: note, pair, direction: directionOf(c, note) }],
          filterPair: input.always?.has(pair) ? null : pair
        });
      }
    }
    if (emit)
      for (const c of extra)
        lists.push({
          set: input.set,
          kind: "reverse-injected",
          turn: note,
          query: c,
          members: neighbourhood([note], partners.get(c) ?? []),
          wanted: [{ member: note, pair: notePairKey(note, c), direction: directionOf(c, note) }],
          filterPair: null
        });
    for (const c of backward) decide(c, note, directionOf(c, note));
  }
  return lists;
}

/** Each note's `k` nearest earlier notes by a judged-row score: the retrieval of a library with no export. */
export function nearestEarlier(
  order: readonly string[],
  rows: ReadonlyArray<{ query: string; doc: string; cosine: number }>,
  k: number
): Map<string, string[]> {
  const position = new Map(order.map((id, index) => [id, index]));
  const best = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const q = position.get(row.query),
      d = position.get(row.doc);
    if (q === undefined || d === undefined || d >= q) continue;
    const own = best.get(row.query) ?? best.set(row.query, new Map()).get(row.query)!;
    own.set(row.doc, Math.max(own.get(row.doc) ?? Number.NEGATIVE_INFINITY, row.cosine));
  }
  return new Map(
    [...best].map(([query, docs]) => [
      query,
      [...docs]
        .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
        .slice(0, k)
        .map(([doc]) => doc)
    ])
  );
}

/**
 * Where each labelled pair is decided: the turn of the first note in arrival order that lists the
 * other; a pair no list holds is injected into its later note's turn (a note with no turn of its own
 * counts as later). Pairs with neither note in the order are returned apart.
 */
export function labelTurns(input: {
  pairs: ReadonlyArray<{ lo: string; hi: string }>;
  order: readonly string[];
  targets: ReadonlyMap<string, readonly string[]>;
}): { decided: Map<string, string>; injected: Map<string, string[]>; unplaced: string[] } {
  const position = new Map(input.order.map((id, index) => [id, index]));
  const listed = new Set<string>();
  for (const [note, targets] of input.targets) for (const c of targets) listed.add(`${note}>${c}`);
  const decided = new Map<string, string>();
  const injected = new Map<string, string[]>();
  const unplaced: string[] = [];
  for (const { lo, hi } of input.pairs) {
    const key = notePairKey(lo, hi);
    const turns = [lo, hi].filter(
      (note) => position.has(note) && listed.has(`${note}>${note === lo ? hi : lo}`)
    );
    if (turns.length > 0) {
      decided.set(key, turns.sort((a, b) => position.get(a)! - position.get(b)!)[0]!);
      continue;
    }
    const placed = [lo, hi].filter((note) => position.has(note));
    if (placed.length === 0) {
      unplaced.push(key);
      continue;
    }
    // The later note asks: the one with no turn counts as later than any.
    const later =
      placed.length === 1 ? placed[0]! : position.get(lo)! > position.get(hi)! ? lo : hi;
    const partner = later === lo ? hi : lo;
    injected.set(later, [...(injected.get(later) ?? []), partner]);
  }
  return { decided, injected, unplaced };
}

// --- Requests ---------------------------------------------------------------------------------------

export interface WireJob {
  hash: string;
  request: DecisionsWireRequest;
}

const hashOf = (request: DecisionsWireRequest) =>
  createHash("sha256").update(JSON.stringify(request)).digest("hex");

/** The product's requests of a list (`planDecisionRequests`), each with the hash it is logged under. */
export function listRequests(
  list: OnlineList,
  text: (id: string) => string,
  instruction: string,
  limits: DecisionsLimits
) {
  const planned = planDecisionRequests(
    [{ query: text(list.query), candidates: list.members.map(text) }],
    instruction,
    limits
  );
  return planned.map((request) => {
    const wire = buildDecisionsWireRequest(request.input, limits.model);
    return { planned: request, wire, hash: hashOf(wire) };
  });
}

// --- CLI ----------------------------------------------------------------------------------------------

export function onlinePaths(cache: string) {
  const work = join(cache, "f3", "decisions-api", "online");
  const freeze = join(cache, "f3", "freeze");
  return {
    work,
    plan: join(work, "plan.json"),
    raw: join(work, "raw", "online.jsonl"),
    scores: join(work, "scores"),
    labels: join(cache, "f3", "labels", "topup-2026-10-18", "merged", "f3-relation-labels.json"),
    proposal: join(freeze, "proposal.json"),
    remoteProposal: join(freeze, "proposal-decisions-online.json"),
    mapping: join(cache, "golden", "matching-fixture", "mapping.json"),
    m1Export: join(cache, "f3", "m1", "out", "m1-run-export.json"),
    s0Export: join(freeze, "x1", "x1-s0-retrieval.json"),
    goldenExport: join(cache, "f3", "m1", "export", "envg-f3-retrieval.json"),
    sampleExport: join(cache, "f3", "m1", "export", "envc-sample-f3-retrieval.json"),
    spikeDataset: join(cache, "spikes", "reranker", "dataset.json"),
    benchmarkDirectory: join(cache, "matching-benchmark"),
    texts: [
      join(cache, "f3", "scratch", "t46a", "env-f-note-texts.json"),
      join(cache, "f3", "scratch", "t46a", "env-g-note-texts.json"),
      join(cache, "f3", "labels", "topup-2026-10-18", "frame", "pool-c-note-texts.json"),
      join(cache, "f3", "decisions-api", "dense", "inputs", "dense-note-texts.json")
    ],
    rv9Relations: join(cache, "f3", "labels", "r-v9", "relations.json"),
    freezePass: join(cache, "f3", "labels", "passes", "freeze", "tally.json"),
    gateDirectory: join(freeze, "gate-f", "decisions-online")
  };
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(value)}\n`);
  await rename(`${path}.tmp`, path);
};

async function readNotes(paths: ReturnType<typeof onlinePaths>) {
  const notes = new Map<string, StoredNote>();
  for (const path of paths.texts) {
    const file = noteTextsSchema.parse(await readJson(path));
    for (const note of file.notes) if (!notes.has(note.id)) notes.set(note.id, note);
  }
  const spike = await readSpikeNotes(paths.spikeDataset, paths.benchmarkDirectory);
  for (const [id, note] of spike.notes) if (!notes.has(id)) notes.set(id, note);
  return notes;
}

const orderOf = (
  data: z.infer<typeof retrievalExportSchema> & {
    perNote?: Array<{ noteId: string }>;
    noteOrder?: string[];
  }
) => data.noteOrder ?? data.perNote?.map((row) => row.noteId) ?? data.notes.map((note) => note.id);

const targetsOf = (data: z.infer<typeof retrievalExportSchema>) => {
  const rows = [...data.candidates].sort((a, b) => (a.contentOrder ?? 0) - (b.contentOrder ?? 0));
  const targets = new Map<string, string[]>();
  for (const row of rows)
    targets.set(row.noteId, [...(targets.get(row.noteId) ?? []), row.candidateId]);
  return targets;
};

export async function runOnlineCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cache: { type: "string" },
      "with-eval": { type: "boolean" },
      phase: { type: "string" },
      "env-file": { type: "string" },
      "dry-run": { type: "boolean" },
      concurrency: { type: "string" },
      seeds: { type: "string" },
      refreeze: { type: "boolean" }
    }
  });
  const paths = onlinePaths(
    resolve(typeof values.cache === "string" ? values.cache : checkoutCache)
  );
  const limits = resolveDecisionsLimits();
  const instruction = decisionsInstruction();
  const command = positionals[0];
  const bodyCharacters = relationsConfig.decide.bodyCharacters;

  if (command === "plan") {
    const notes = await readNotes(paths);
    const text = (id: string): string => {
      const note = notes.get(id);
      if (!note) throw new Error(`Note ${id} has no text in the approved sources.`);
      return renderRelationPairText(
        { title: note.title, ideaStatement: note.idea, bodyMarkdown: note.body },
        bodyCharacters
      );
    };
    const compare = (left: string, right: string) => {
      const a = notes.get(left)!,
        b = notes.get(right)!;
      return (
        compareContent(contentKey(a.title, a.idea), contentKey(b.title, b.idea)) ||
        left.localeCompare(right)
      );
    };
    const labels = labelFixtureSchema.parse(await readJson(paths.labels));
    const proposal = z
      .object({ weighting: z.object({ excludedPairs: z.array(z.string()) }).passthrough() })
      .passthrough()
      .parse(await readJson(paths.proposal));
    const excluded = new Set(proposal.weighting.excludedPairs);
    const splits = values["with-eval"] === true ? ["fit", "eval"] : ["fit"];
    const labelled = (pool: string) =>
      labels.items.filter(
        (item) =>
          item.kind === "note" &&
          item.pool === pool &&
          item.related !== null &&
          splits.includes(item.split ?? "") &&
          !excluded.has(notePairKey(item.lo, item.hi))
      );
    const lists: OnlineList[] = [];
    const report: Record<string, unknown> = {};
    const library = async (
      set: string,
      exportPath: string,
      pool: string | null,
      emitAll: boolean
    ) => {
      const data = retrievalExportSchema
        .passthrough()
        .parse(await readJson(exportPath)) as never as z.infer<typeof retrievalExportSchema> & {
        perNote?: Array<{ noteId: string }>;
        noteOrder?: string[];
      };
      const order = orderOf(data);
      const targets = targetsOf(data);
      const pairs = pool ? labelled(pool) : [];
      const turns = labelTurns({ pairs, order, targets });
      const always = new Set(pairs.map((item) => notePairKey(item.lo, item.hi)));
      const emitTurns = new Set([...turns.decided.values(), ...turns.injected.keys()]);
      lists.push(
        ...replayOnline({
          set,
          order,
          targets,
          compare,
          maxNeighbourhood: limits.maxNeighbourhood,
          emit: (turn) => emitAll || emitTurns.has(turn),
          injected: turns.injected,
          always,
          reverse: emitAll ? "all" : "always"
        })
      );
      report[set] = {
        turns: order.length,
        labels: pairs.length,
        labelsDecided: turns.decided.size,
        labelsInjected: [...turns.injected.values()].reduce((total, row) => total + row.length, 0),
        labelsUnplaced: turns.unplaced.length
      };
    };
    // The fixture: S0 in full (M1's tuning turns, then the held-out ones); pool A's labels live in it.
    await library("fixture-s0", paths.s0Export, "A", true);
    await library("golden", paths.goldenExport, "B", false);
    await library("corpus-sample", paths.sampleExport, "C", false);
    // R_v6: Spike A's library in its dataset order, each note's 10 nearest earlier notes.
    const dataset = z
      .object({
        notes: z.array(z.object({ id: z.string() }).passthrough()),
        rows: z.array(
          z.object({ query: z.string(), doc: z.string(), cosine: z.number() }).passthrough()
        )
      })
      .passthrough()
      .parse(await readJson(paths.spikeDataset));
    const spikeOrder = dataset.notes.map((note) => note.id);
    const spikeTargets = nearestEarlier(spikeOrder, dataset.rows, relationsConfig.retrieval.fusedK);
    const rv6 = labels.items.filter((item) => item.sets.includes("rv6"));
    const rv6Turns = labelTurns({ pairs: rv6, order: spikeOrder, targets: spikeTargets });
    lists.push(
      ...replayOnline({
        set: "rv6",
        order: spikeOrder,
        targets: spikeTargets,
        compare,
        maxNeighbourhood: limits.maxNeighbourhood,
        emit: (turn) =>
          new Set([...rv6Turns.decided.values(), ...rv6Turns.injected.keys()]).has(turn),
        injected: rv6Turns.injected,
        always: new Set(rv6.map((item) => notePairKey(item.lo, item.hi))),
        reverse: "always"
      })
    );
    report.rv6 = {
      labels: rv6.length,
      labelsDecided: rv6Turns.decided.size,
      labelsInjected: [...rv6Turns.injected.values()].reduce((total, row) => total + row.length, 0),
      labelsUnplaced: rv6Turns.unplaced.length
    };
    // The requests, deduplicated: an identical request is sent once.
    const jobs = new Map<string, { request: DecisionsWireRequest; phase: 1 | 2; lists: number }>();
    const listJobs = lists.map((list) => {
      const requests = listRequests(list, text, instruction, limits);
      for (const { wire, hash } of requests) {
        const phase = list.filterPair === null ? 1 : 2;
        const existing = jobs.get(hash);
        jobs.set(hash, {
          request: wire,
          phase: existing && existing.phase === 1 ? 1 : phase,
          lists: (existing?.lists ?? 0) + 1
        });
      }
      return requests.map(({ planned, hash }) => ({
        hash,
        candidateIndices: planned.candidateIndices,
        orders: [...planned.orders]
      }));
    });
    const bytes = (request: DecisionsWireRequest) =>
      Buffer.byteLength(JSON.stringify(request), "utf8");
    // The dense run's observed 2.23 characters per input token (hidden question tokens included).
    const tokensOf = (request: DecisionsWireRequest) => Math.ceil(bytes(request) / 2.23);
    const byPhase = (phase: 1 | 2) => [...jobs.values()].filter((job) => job.phase === phase);
    const usd = (rows: Array<{ request: DecisionsWireRequest }>) =>
      (rows.reduce((total, job) => total + tokensOf(job.request), 0) *
        limits.pricePerMillionInputTokensUsd) /
      1_000_000;
    const perSet = Object.fromEntries(
      [...new Set(lists.map((list) => list.set))].map((set) => {
        const own = new Set(
          lists.flatMap((list, index) =>
            list.set === set ? listJobs[index]!.map((job) => job.hash) : []
          )
        );
        const rows = [...own].map((hash) => jobs.get(hash)!);
        return [
          set,
          {
            requests: own.size,
            usdIfAllSent: usd(rows),
            phase2: rows.filter((row) => row.phase === 2).length
          }
        ];
      })
    );
    // Phase 2 sends the reverse lists whose forward was above 0: the dense runs had 55-59% at 0.
    const projection = usd(byPhase(1)) + 0.45 * usd(byPhase(2));
    await writeJson(paths.plan, {
      format: "memora-f3-decisions-online-plan",
      version: 1,
      instructionSha256: sha256Hex(instruction),
      requestDesignSha256: decisionsRequestDesignSha256(instruction, limits, bodyCharacters),
      requestDesign: decisionsRequestDesign(instruction, limits, bodyCharacters),
      report,
      lists: lists.map((list, index) => ({ ...list, requests: listJobs[index] })),
      jobs: Object.fromEntries(
        [...jobs].map(([hash, job]) => [hash, { phase: job.phase, request: job.request }])
      )
    });
    console.info(
      JSON.stringify(
        { report, perSet, requests: { phase1: byPhase(1).length, phase2: byPhase(2).length } },
        null,
        1
      )
    );
    console.info(
      `projection: phase 1 US$ ${usd(byPhase(1)).toFixed(4)}; phase 2 US$ ${usd(byPhase(2)).toFixed(4)} if every reverse list were sent, about US$ ${(0.45 * usd(byPhase(2))).toFixed(4)} at the dense runs' 45% above 0; total about US$ ${projection.toFixed(4)} (cap US$ ${onlineCapUsd})`
    );
    return;
  }

  const plan = z
    .object({
      lists: z.array(z.unknown()),
      jobs: z.record(
        z.string(),
        z.object({ phase: z.union([z.literal(1), z.literal(2)]), request: z.unknown() })
      ),
      requestDesignSha256: z.string(),
      instructionSha256: z.string()
    })
    .passthrough()
    .parse(await readJson(paths.plan));
  const lists = plan.lists as PlannedList[];
  const jobs = plan.jobs as Record<string, { phase: 1 | 2; request: DecisionsWireRequest }>;

  if (command === "run") {
    const phase = Number(values.phase);
    if (phase !== 1 && phase !== 2) throw new Error("run needs --phase 1 or --phase 2.");
    const answers = await readAnswers(paths.raw);
    let pending: string[];
    if (phase === 1) pending = Object.keys(jobs).filter((hash) => jobs[hash]!.phase === 1);
    else {
      // The product's lossless filter: a reverse list goes out only when its pair's forward is above 0.
      const forward = directedFromAnswers(
        lists,
        answers,
        limits,
        (list) => list.kind === "forward" || list.kind === "forward-injected"
      );
      const send = new Set<string>();
      for (const list of lists) {
        if (list.filterPair === null) continue;
        const [lo, hi] = list.filterPair.split(":") as [string, string];
        const wanted = list.wanted[0]!;
        const forwardKey = wanted.direction === "loToHi" ? `${hi}>${lo}` : `${lo}>${hi}`;
        const probability = forward.probability.get(forwardKey);
        if (probability === undefined || probability > 0)
          for (const { hash } of list.requests) send.add(hash);
      }
      pending = [...send];
    }
    pending = pending.filter((hash) => !answers.has(hash));
    await runLive(
      pending.map((hash) => ({ hash, request: jobs[hash]!.request })),
      paths.raw,
      limits,
      {
        dryRun: values["dry-run"] === true,
        concurrency: Number(values.concurrency ?? 2),
        envFile: typeof values["env-file"] === "string" ? resolve(values["env-file"]) : undefined
      }
    );
    return;
  }
  if (command === "scores") {
    const answers = await readAnswers(paths.raw);
    const ceiling = Math.log((1 - limits.probabilityEpsilon) / limits.probabilityEpsilon);
    for (const set of [...new Set(lists.map((list) => list.set))]) {
      const own = lists.filter((list) => list.set === set);
      const scored = directedFromAnswers(own, answers, limits, () => true);
      // A reverse direction the filter left unasked: its pair's mean is at most (forward + ceiling) / 2 = 0.
      let bounded = 0;
      for (const list of own) {
        if (list.filterPair === null) continue;
        const wanted = list.wanted[0]!;
        const [lo, hi] = list.filterPair.split(":") as [string, string];
        const reverseKey = wanted.direction === "loToHi" ? `${lo}>${hi}` : `${hi}>${lo}`;
        if (scored.logOdds.has(reverseKey)) continue;
        bounded++;
        scored.logOdds.set(reverseKey, ceiling);
        scored.bounded.add(reverseKey);
      }
      const scores = [...scored.logOdds].map(([key, logOdds]) => {
        const [query, doc] = key.split(">") as [string, string];
        return {
          query,
          doc,
          probability: scored.probability.get(key) ?? null,
          logOdds,
          ...(scored.bounded.has(key)
            ? { bound: "unasked: the forward was 0, so the mean is at most 0" }
            : {})
        };
      });
      await writeJson(join(paths.scores, `online-${set}-meanAB.json`), {
        format: pairScoresFormat,
        version: 1,
        decider: `openai-decisions:${limits.model} predicate, the product's online requests, both directions, meanAB`,
        scale: "log-odds",
        scores,
        run: {
          task: "T58-decisions-online",
          set,
          variant: "meanAB",
          instructionSha256: plan.instructionSha256,
          requestDesignSha256: plan.requestDesignSha256,
          model: limits.model,
          shuffleSalts: [...limits.orderSalts],
          boundedReverse: bounded,
          missing: scored.missing
        }
      });
      console.info(
        `${set}: ${scores.length} directed scores (${bounded} unasked reverse directions at the bound), ${scored.missing} wanted directions without an answer`
      );
    }
    return;
  }
  if (command === "select" || command === "freeze") {
    const labels = labelFixtureSchema.parse(await readJson(paths.labels));
    const proposal = z
      .object({
        weighting: z
          .object({ weights: z.record(z.string(), z.number()), excludedPairs: z.array(z.string()) })
          .passthrough()
      })
      .passthrough()
      .parse(await readJson(paths.proposal));
    const fitScores = await mergedScores(paths, ["fixture-s0", "golden", "corpus-sample"]);
    const tuningScores = await mergedScores(paths, ["fixture-s0"]);
    const tuningExport = retrievalExportSchema.parse(await readJson(paths.m1Export));
    const mapping = matchingMappingSchema.parse(await readJson(paths.mapping));
    const identity = productDecisionsIdentity(instruction, limits);
    if (identity.requestDesignSha256 !== plan.requestDesignSha256)
      throw new Error("The plan was made under another request design: plan again.");
    const inputs = {
      plan: sha256Hex(await readFile(paths.plan)),
      answers: sha256Hex(await readFile(paths.raw)),
      labels: sha256Hex(await readFile(paths.labels)),
      labelSetSha256: labels.labelSetSha256,
      localProposal: sha256Hex(await readFile(paths.proposal)),
      tuningExport: sha256Hex(await readFile(paths.m1Export)),
      mapping: sha256Hex(await readFile(paths.mapping)),
      instruction: identity.instructionSha256
    };
    const propose = (seed?: number) =>
      proposeRemoteDecider({
        labels,
        weights: proposal.weighting,
        fitScores,
        tuningScores,
        tuningExport,
        lists: tuningLists(mapping),
        identity,
        ...(seed === undefined ? {} : { seed })
      });
    if (command === "select") {
      const proposed = propose();
      const remote: RemoteProposal = {
        format: "memora-f3-bakeoff-remote-proposal",
        version: 1,
        decider: "decisions",
        computedAt: new Date().toISOString(),
        inputs,
        instruction: {
          sha256: identity.instructionSha256,
          designFingerprint: decisionsRequestDesign(instruction, limits, bodyCharacters)
            .designFingerprint
        },
        requestDesign: decisionsRequestDesign(instruction, limits, bodyCharacters) as never,
        ...proposed
      };
      await writeJson(paths.remoteProposal, remote);
      const seeds = (typeof values.seeds === "string" ? values.seeds : "1000,1001,1002")
        .split(",")
        .map(Number);
      const sensitivity = seeds.map((seed) => {
        const other = propose(seed);
        return `| ${seed} | ${other.bands.pApply ?? "none"} | ${other.bands.applyFromScore ?? "-"} | ${other.bands.pSuggest ?? "none"} | ${other.bands.suggestFromScore ?? "-"} | ${other.bands.apply?.precision ?? "-"} (Wilson ${other.bands.apply?.wilsonLower ?? "-"}, ${other.bands.apply?.labels ?? 0} labels) |`;
      });
      const md = [
        renderRemoteProposal(remote).replace(
          "# The Decisions API decider: D18 on dense two-order requests (plan decision 30)",
          "# The Decisions API decider: D18 on the product's own online requests (plan decision 30)"
        ),
        "## D18 against other fold seeds (reported, not chosen on)",
        "",
        "| Seed | p_apply | apply from | p_suggest | suggest from | CV precision at apply |",
        "| ---: | --- | --- | --- | --- | --- |",
        ...sensitivity,
        ""
      ].join("\n");
      await writeFile(paths.remoteProposal.replace(/\.json$/u, ".md"), md);
      console.info(md);
      return;
    }
    if (values.refreeze !== true)
      throw new Error("A new identity is a re-freeze (D3): pass --refreeze.");
    const frozenPath = resolve(frozenFileLocation());
    const previous = JSON.parse(await readFile(frozenPath, "utf8")) as RemoteFreezeRecord;
    const bytes = await readFile(paths.remoteProposal);
    const remote = JSON.parse(bytes.toString("utf8")) as RemoteProposal;
    for (const [key, hash] of Object.entries(remote.inputs))
      if ((inputs as Record<string, string>)[key] !== hash)
        throw new Error(
          `The proposal's input ${key} changed since it was computed: run select again.`
        );
    const kept = frozenPath.replace(
      /\.json$/u,
      `-${previous.frozenAt.replace(/[:.]/gu, "-")}.json`
    );
    const record = addRemoteCalibration({
      previous,
      previousFile: kept,
      proposal: remote,
      proposalSha256: sha256Hex(bytes),
      frozenAt: new Date(),
      supersedes: "the same provider's model under another request design",
      basis: onlineBasis(remote)
    });
    await rename(frozenPath, kept);
    await writeJson(frozenPath, record);
    console.info(
      `re-frozen ${record.configHash} at ${record.frozenAt} -> ${frozenPath}; the earlier record is kept as ${kept}`
    );
    return;
  }
  if (command === "gate-f") {
    requireHeldOut(await readHeldOutAccess());
    const record = JSON.parse(
      await readFile(resolve(frozenFileLocation()), "utf8")
    ) as RemoteFreezeRecord;
    const identity = productDecisionsIdentity(instruction, limits);
    const entry = record.calibrations.find(
      (candidate) =>
        candidate.identity.runtimeKind === "remote" &&
        candidate.identity.requestDesignSha256 === identity.requestDesignSha256
    );
    if (!entry || entry.kind !== "isotonic")
      throw new Error("The freeze holds no calibration of the product's request design.");
    const labels = labelFixtureSchema.parse(await readJson(paths.labels));
    const result = await decisionsGateF({
      record,
      entry,
      x1Scores: await mergedScores(paths, ["fixture-s0"]),
      rv6Scores: await mergedScores(paths, ["rv6"]),
      evalScores: await mergedScores(paths, ["fixture-s0", "golden", "corpus-sample"]),
      x1: retrievalExportSchema.parse(await readJson(paths.s0Export)),
      labels,
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
        .parse(await readJson(paths.rv9Relations)),
      passes: [
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
          .parse(await readJson(paths.freezePass))
      ]
    });
    await writeJson(join(paths.gateDirectory, "gate-f-decisions-online.json"), result);
    await writeFile(
      join(paths.gateDirectory, "gate-f-decisions-online.md"),
      renderDecisionsGateF(result)
    );
    console.info(renderDecisionsGateF(result));
    return;
  }
  throw new Error("The command is plan, run, scores, select, freeze or gate-f.");
}

async function mergedScores(
  paths: ReturnType<typeof onlinePaths>,
  sets: readonly string[]
): Promise<DirectedScores> {
  const scores: DirectedScores = new Map();
  for (const set of sets) {
    const file = z
      .object({
        scores: z.array(
          z.object({ query: z.string(), doc: z.string(), logOdds: z.number() }).passthrough()
        )
      })
      .passthrough()
      .parse(await readJson(join(paths.scores, `online-${set}-meanAB.json`)));
    for (const row of file.scores)
      if (!scores.has(`${row.query}>${row.doc}`))
        scores.set(`${row.query}>${row.doc}`, row.logOdds);
  }
  return scores;
}

// --- Answers --------------------------------------------------------------------------------------------

async function readAnswers(path: string): Promise<Map<string, Array<number | null>>> {
  const out = new Map<string, Array<number | null>>();
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as {
      hash: string;
      ok: boolean;
      probabilities?: Array<number | null>;
    };
    if (record.ok && record.probabilities) out.set(record.hash, record.probabilities);
  }
  return out;
}

/** A list of the plan with its requests: each one's hash, candidate order and the orders it answers. */
export type PlannedList = OnlineList & {
  requests: Array<{ hash: string; candidateIndices: number[]; orders: Array<"A" | "B"> }>;
};

/**
 * The directed scores the lists' wanted directions read, from the answers of their requests: the
 * product's `combineDecisionAnswers` (the mean of the two orders' probabilities, then its log-odds).
 */
export function directedFromAnswers(
  lists: readonly PlannedList[],
  answers: ReadonlyMap<string, ReadonlyArray<number | null>>,
  limits: DecisionsLimits,
  include: (list: OnlineList) => boolean
) {
  const logOdds = new Map<string, number>();
  const probability = new Map<string, number>();
  const bounded = new Set<string>();
  let missing = 0;
  for (const list of lists) {
    if (!include(list)) continue;
    if (list.requests.some((request) => !answers.has(request.hash))) {
      // A phase-2 list the filter did not send is no gap; a list that should have answered is.
      if (list.filterPair === null) missing += list.wanted.length;
      continue;
    }
    const requests = list.requests.map((request, id) => ({
      id,
      listIndex: 0,
      candidateIndices: request.candidateIndices,
      orders: request.orders,
      input: {
        contract: "relation-decisions-v1" as const,
        instruction: "-",
        query: "-",
        candidates: ["-"]
      }
    }));
    const combined = combineDecisionAnswers(
      [{ query: list.query, candidates: list.members }],
      requests,
      new Map(list.requests.map((request, id) => [id, answers.get(request.hash)!])),
      limits
    );
    for (const wanted of list.wanted) {
      const decided = combined[0]![list.members.indexOf(wanted.member)];
      const [lo, hi] = wanted.pair.split(":") as [string, string];
      const key = wanted.direction === "loToHi" ? `${lo}>${hi}` : `${hi}>${lo}`;
      if (!decided || decided.logOdds === null || decided.probability === null) {
        missing++;
        continue;
      }
      if (!logOdds.has(key)) {
        logOdds.set(key, decided.logOdds);
        probability.set(key, decided.probability);
      }
    }
  }
  return { logOdds, probability, bounded, missing };
}

// --- live calls -----------------------------------------------------------------------------------------

async function runLive(
  jobs: readonly WireJob[],
  rawFile: string,
  limits: DecisionsLimits,
  options: { dryRun: boolean; concurrency: number; envFile: string | undefined }
) {
  let text = "";
  try {
    text = await readFile(rawFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const records = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { inputTokens?: number; bytes?: number });
  const spentTokens = records.reduce((total, record) => total + (record.inputTokens ?? 0), 0);
  const cost = (tokens: number) => (tokens * limits.pricePerMillionInputTokensUsd) / 1_000_000;
  // Bytes per input token: this log's own once it holds enough answers (5% kept in reserve), else
  // the dense run's conservative 2.23.
  const measured = records.filter((record) => record.bytes && record.inputTokens);
  const bytesPerToken =
    measured.length >= 50
      ? (0.95 * measured.reduce((total, record) => total + record.bytes!, 0)) /
        measured.reduce((total, record) => total + record.inputTokens!, 0)
      : 2.23;
  const bytesOf = (job: WireJob) => Buffer.byteLength(JSON.stringify(job.request), "utf8");
  const projected = jobs.reduce((total, job) => total + Math.ceil(bytesOf(job) / bytesPerToken), 0);
  console.info(
    `${jobs.length} requests to send; projected US$ ${cost(projected).toFixed(4)} at ${bytesPerToken.toFixed(2)} bytes per token; spent US$ ${cost(spentTokens).toFixed(4)}; cap US$ ${onlineCapUsd}`
  );
  if (cost(spentTokens + projected) > onlineCapUsd)
    throw new Error(`The projection exceeds the cap of US$ ${onlineCapUsd}: nothing sent.`);
  if (options.dryRun || jobs.length === 0) return;
  const client = new DecisionsClient({ apiKey: await readApiKey(options.envFile) });
  await mkdir(dirname(rawFile), { recursive: true });
  const abort = new AbortController();
  let tokens = spentTokens;
  let next = 0,
    sent = 0,
    failed = 0,
    consecutive = 0;
  let stopped: string | null = null;
  const stop = (reason: string) => {
    if (!stopped) {
      stopped = reason;
      abort.abort();
    }
  };
  const worker = async () => {
    for (;;) {
      if (abort.signal.aborted) return;
      const job = jobs[next++];
      if (!job) return;
      let record: Record<string, unknown>;
      try {
        const result = await client.decide(job.request, abort.signal);
        const probabilities = readDecisionsAnswers(result.answers, job.request.questions.length);
        record = {
          hash: job.hash,
          ok: true,
          at: new Date().toISOString(),
          model: result.model,
          bytes: bytesOf(job),
          inputTokens: result.usage.input_tokens,
          requestId: result.requestId,
          totalMs: result.totalMs,
          probabilities
        };
      } catch (error) {
        const failure =
          error instanceof DecisionsError
            ? error
            : new DecisionsError("network", redactSecrets(String(error)).slice(0, 200), null, []);
        if (failure.kind === "aborted") return;
        record = {
          hash: job.hash,
          ok: false,
          at: new Date().toISOString(),
          error: { kind: failure.kind, status: failure.status, message: failure.message }
        };
        if (failure.kind === "auth" || failure.kind === "quota") stop(`${failure.kind} error`);
      }
      await appendFile(rawFile, `${JSON.stringify(record)}\n`);
      sent++;
      tokens += (record.inputTokens as number | undefined) ?? 0;
      if (record.ok) consecutive = 0;
      else {
        failed++;
        if (++consecutive >= 6) stop("6 consecutive failures");
      }
      if (cost(tokens) > onlineCapUsd) stop("the cap is reached");
      if (sent % 100 === 0 || sent === jobs.length)
        console.info(
          `${sent}/${jobs.length} sent, ${failed} failed, spent US$ ${cost(tokens).toFixed(4)}`
        );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, () => worker()));
  console.info(
    `sent ${sent}, failed ${failed}, spent US$ ${cost(tokens).toFixed(4)}${stopped ? `, stopped: ${stopped}` : ""}`
  );
  if (stopped) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await runOnlineCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[relations/bakeoff-online] ${redactSecrets(error instanceof Error ? error.message : String(error))}`
    );
    process.exitCode = 1;
  }
}

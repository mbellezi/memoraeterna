// Seeding the Inbox of a journey profile (F5 T155, J5; spec 5.3, D33, D34). A headless step before the
// app starts: the clone's own PostgreSQL is started by `scripts/lib/profile-server.ts` (only a
// scratch profile under `.cache/f<N>/scratch/` is accepted), the open items are written through the
// product's own writers, the Inbox's read model confirms what it now lists, and the server is stopped
// again before the profile is launched. No direct SQL write: the only SQL here is the read that
// picks notes (through the visibility module's `currentNoteSql`).
//
// What is written, and by which writer:
//
//   a withdrawn relation      `atomicNoteRelationRepository.upsert` then `.veto` (the typer's or the
//                             explainer's own writes), in a relation pass of `relationMatchRunRepository`
//   a contradiction           the same upsert, type `contradicts`, band `suggest`
//   three suggestions         the same upsert, band `suggest`, with a probability of 0.64 (below the
//                             0.85 band: listed and counted), none (null: an uncalibrated decider's,
//                             worded "confiança desconhecida": listed and counted) and 0.92 (above the
//                             band: inline only, never in the Inbox, D33)
//   a pending relation pass   a pass started with `pendingReview` that holds one more relation above
//                             the band (its `review_status` is the verdict `x` writes)
//   a pending change-set      `topicTreeRepository.applyChangeSet` with `status: "pending_review"`
//                             (the engine's proposal path: a rename of a named topic)
//   a duplicate finding       `gardenerFindingRepository.record`
//
// The relation review writer (`relations.review`) is what the journey's own keys drive in the app;
// it is not used to seed. The journey reads each verdict back through `inboxStoreReaders`, the
// repository readers the calibration export of F6 uses (relation events, change-set summaries and
// findings), never by the Inbox's own list.
import {
  closePgPool,
  createAtomicNoteRelationRepository,
  createChangeSetRepository,
  createGardenerFindingRepository,
  createInboxRepository,
  createPgPool,
  createRelationEventRepository,
  createRelationMatchRunRepository,
  createTopicTreeRepository,
  currentNoteSql,
  type InboxCountRows,
  type PgPool,
  type RelationEventRecord
} from "@app/db";
import { formatObjectAddress, type InboxKind } from "@app/domain";

import { startProfileServer } from "../../scripts/lib/profile-server.js";
import { readConnection } from "./db.js";
import type { JourneysRun } from "./profile.js";

/** The decider key every seeded relation carries: a reader can tell the seed from the product's own. */
export const seedDeciderKey = "journeys-seed";
/** The probabilities of the seeded suggestions: below the 0.85 band, none, and above it. */
export const seedProbabilities = { low: 0.64, unknown: null, high: 0.92 } as const;

export type SeededRelationName =
  | "withdrawn"
  | "contradiction"
  | "suggestionLow"
  | "suggestionUnknown"
  | "suggestionHigh"
  | "passRelation";

export interface SeededRelation {
  id: string;
  /** The two notes, as `memora://note/<uuid>` addresses. */
  notes: [string, string];
}

export interface InboxSeed {
  relations: Record<SeededRelationName, SeededRelation>;
  /** The relation pass that waits for review (`review_status = 'pending_review'`). */
  pass: { id: string; relationId: string };
  /** The topic proposal that waits for review (`topic_change_sets.status = 'pending_review'`). */
  proposal: { id: string; topicId: string; topicTitle: string };
  /** The duplicate finding. */
  finding: { id: string; notes: [string, string] };
  /** The keys the Inbox lists them under (`<kind>:<id>`), as `inbox.list` hands them out. */
  keys: {
    withdrawn: string;
    contradiction: string;
    suggestionLow: string;
    suggestionUnknown: string;
    suggestionHigh: string;
    pass: string;
    proposal: string;
    duplicate: string;
  };
  /** What the read model counted before the seed and after it. */
  counts: { before: InboxCountRows; after: InboxCountRows };
}

const addressOf = (id: string) => formatObjectAddress({ kind: "note", id });

/** The key of an unordered pair of notes. */
export const pairKey = (first: string, second: string): string => [first, second].sort().join("|");

/**
 * The first `count` pairs of `ids`, in order, that are not in `taken` (keys of `pairKey`); each pair
 * is new, so no two seeded relations are the same pair. Throws when there are fewer.
 */
export function pickFreePairs(
  ids: readonly string[],
  taken: ReadonlySet<string>,
  count: number
): [string, string][] {
  const pairs: [string, string][] = [];
  for (let first = 0; first < ids.length && pairs.length < count; first += 1)
    for (let second = first + 1; second < ids.length && pairs.length < count; second += 1) {
      const pair: [string, string] = [ids[first]!, ids[second]!];
      if (!taken.has(pairKey(...pair))) pairs.push(pair);
    }
  if (pairs.length < count)
    throw new Error(
      `Only ${pairs.length} free note pairs among ${ids.length} notes; ${count} needed`
    );
  return pairs;
}

/** Pairs of current notes that no relation links yet, found with the relation repository's own reader. */
async function freePairs(pool: PgPool, count: number): Promise<[string, string][]> {
  const { rows } = await pool.query<{ id: string }>(
    `select n.id::text as id from atomic_notes n where ${currentNoteSql("n")} order by n.id limit 14`
  );
  const ids = rows.map((row) => row.id);
  if (ids.length < 6)
    throw new Error(`BASE-J has only ${ids.length} current notes: too few to seed`);
  const relations = createAtomicNoteRelationRepository(pool);
  const taken = new Set<string>();
  for (const id of ids)
    for (const [other] of await relations.pairStatuses(
      id,
      ids.filter((candidate) => candidate !== id)
    ))
      taken.add(pairKey(id, other));
  return pickFreePairs(ids, taken, count);
}

/** Every key the Inbox's read model lists (all pages), with its kind. */
async function listedKeys(pool: PgPool): Promise<Set<string>> {
  const inbox = createInboxRepository(pool);
  const keys = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const page: Awaited<ReturnType<typeof inbox.page>> = await inbox.page({ limit: 50, after });
    for (const row of page.rows) keys.add(row.key);
    const last = page.rows.at(-1);
    if (!page.hasMore || !last) return keys;
    after = last.cursor;
  }
}

const count = (rows: InboxCountRows, kind: InboxKind) => rows.byKind[kind] ?? 0;

/**
 * Seeds `userDataDir` (a closed clone inside the run) and returns what was written. Throws, naming
 * the item, when the Inbox's read model does not list what the seed says it lists.
 */
export async function seedInbox(run: JourneysRun, userDataDir: string): Promise<InboxSeed> {
  const server = await startProfileServer(userDataDir, {
    repoRoot: run.repoRoot,
    allowIncomplete: true
  });
  const pool = createPgPool({ connectionString: server.connectionString, max: 3 });
  try {
    const inbox = createInboxRepository(pool);
    const before = await inbox.counts();
    const free = await freePairs(pool, 6);
    const [pairWithdrawn, pairContradiction, pairLow, pairUnknown, pairHigh, pairPass] = [
      0, 1, 2, 3, 4, 5
    ].map((index) => free[index]!) as [
      [string, string],
      [string, string],
      [string, string],
      [string, string],
      [string, string],
      [string, string]
    ];
    const relations = createAtomicNoteRelationRepository(pool);
    const runs = createRelationMatchRunRepository(pool);

    // The pass that decided the five relations: finished, nothing waits on it.
    const decided = await runs.start({ kind: "match", deciderKey: seedDeciderKey });
    const decide = async (
      pair: [string, string],
      input: {
        relationType: string;
        band: "apply" | "suggest";
        probability: number | null;
        explanation: string;
      },
      runId: string
    ): Promise<SeededRelation> => {
      const written = await relations.upsertDecided({
        subjectAtomicNoteId: pair[0],
        objectAtomicNoteId: pair[1],
        relationType: input.relationType,
        band: input.band,
        probability: input.probability,
        deciderKey: seedDeciderKey,
        finalScore: input.probability ?? 0.5,
        explanation: input.explanation,
        runId
      });
      return { id: written.relation.id, notes: [addressOf(pair[0]), addressOf(pair[1])] };
    };
    const withdrawn = await decide(
      pairWithdrawn,
      {
        relationType: "supports",
        band: "apply",
        probability: 0.9,
        explanation: "Seeded for the Inbox journey: a relation the explainer withdrew."
      },
      decided.id
    );
    if (!(await relations.veto(withdrawn.id, "explainer", decided.id)))
      throw new Error("The seeded relation could not be withdrawn");
    const contradiction = await decide(
      pairContradiction,
      {
        relationType: "contradicts",
        band: "suggest",
        probability: 0.9,
        explanation: "Seeded for the Inbox journey: a suggested contradiction."
      },
      decided.id
    );
    const suggestionLow = await decide(
      pairLow,
      {
        relationType: "supports",
        band: "suggest",
        probability: seedProbabilities.low,
        explanation: "Seeded for the Inbox journey: a suggestion below the high band."
      },
      decided.id
    );
    const suggestionUnknown = await decide(
      pairUnknown,
      {
        relationType: "extends",
        band: "suggest",
        probability: seedProbabilities.unknown,
        explanation: "Seeded for the Inbox journey: a suggestion with no probability."
      },
      decided.id
    );
    const suggestionHigh = await decide(
      pairHigh,
      {
        relationType: "supports",
        band: "suggest",
        probability: seedProbabilities.high,
        explanation: "Seeded for the Inbox journey: a suggestion above the high band."
      },
      decided.id
    );
    await runs.finish(decided.id, { outcome: "journeys-seed" });

    // The pass that waits for review, with one relation above the band so it adds no other item.
    const pending = await runs.start({
      kind: "match",
      deciderKey: seedDeciderKey,
      pendingReview: true,
      risk: "medium"
    });
    const passRelation = await decide(
      pairPass,
      {
        relationType: "supports",
        band: "suggest",
        probability: 0.93,
        explanation: "Seeded for the Inbox journey: a relation of a pass that waits for review."
      },
      pending.id
    );
    await runs.finish(pending.id, { outcome: "journeys-seed", pendingReview: true });

    // The engine's proposal path: a rename of a named topic, recorded and not applied.
    const topics = createTopicTreeRepository(pool);
    const tree = await topics.activeTree();
    if (!tree) throw new Error("BASE-J has no active topic tree");
    const records = await topics.readTreeRecords(tree.id);
    const topic = records.topics.find(
      (entry) =>
        entry.role !== "root" &&
        entry.retiredAt === null &&
        entry.nameState === "named" &&
        entry.title !== null
    );
    if (!topic) throw new Error("BASE-J has no named topic to propose a rename for");
    const name = {
      title: topic.title,
      nameState: topic.nameState,
      nameSource: topic.nameSource,
      nameLanguage: topic.nameLanguage,
      namedChangeSetId: topic.namedChangeSetId,
      aliases: topic.aliases
    };
    const proposed = await topics.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      origin: "naming",
      titleKey: "topics.changeSets.naming",
      titleParams: { topics: 1 },
      risk: "medium",
      events: [
        {
          op: "topic.rename",
          topicId: topic.id,
          before: name,
          after: { ...name, title: `${topic.title} (proposed)` }
        }
      ],
      status: "pending_review"
    });
    if (proposed.kind !== "pending")
      throw new Error(`The topic proposal was not recorded as pending (${proposed.kind})`);

    // A duplicate finding between two of the notes.
    const duplicateNotes: [string, string] = [pairLow[0], pairHigh[1]];
    const findings = createGardenerFindingRepository(pool);
    const fingerprint = `journeys-seed:${duplicateNotes.toSorted().join(":")}`;
    await findings.record([
      {
        kind: "duplicate",
        fingerprint,
        objectRefs: duplicateNotes.map(addressOf),
        params: { reason: "both", cosine: 0.93 },
        risk: "low"
      }
    ]);
    const finding = (await findings.list({ kinds: ["duplicate"], limit: 50 })).findings.find(
      (entry) => entry.fingerprint === fingerprint
    );
    if (!finding) throw new Error("The duplicate finding was not recorded");

    const seed: InboxSeed = {
      relations: {
        withdrawn,
        contradiction,
        suggestionLow,
        suggestionUnknown,
        suggestionHigh,
        passRelation
      },
      pass: { id: pending.id, relationId: passRelation.id },
      proposal: { id: proposed.changeSetId, topicId: topic.id, topicTitle: topic.title ?? "" },
      finding: {
        id: finding.id,
        notes: [addressOf(duplicateNotes[0]), addressOf(duplicateNotes[1])]
      },
      keys: {
        withdrawn: `withdrawn:${withdrawn.id}`,
        contradiction: `contradiction:${contradiction.id}`,
        suggestionLow: `suggestion:${suggestionLow.id}`,
        suggestionUnknown: `suggestion:${suggestionUnknown.id}`,
        suggestionHigh: `suggestion:${suggestionHigh.id}`,
        pass: `review:relation:${pending.id}`,
        proposal: `review:topic:${proposed.changeSetId}`,
        duplicate: `duplicate:${finding.id}`
      },
      counts: { before, after: await inbox.counts() }
    };

    // The read model lists what the seed says it lists, and the high suggestion stays out (D33).
    const listed = await listedKeys(pool);
    for (const name of [
      "withdrawn",
      "contradiction",
      "suggestionLow",
      "suggestionUnknown",
      "pass",
      "proposal",
      "duplicate"
    ] as const)
      if (!listed.has(seed.keys[name])) throw new Error(`The seeded ${name} is not in the Inbox`);
    if (listed.has(seed.keys.suggestionHigh))
      throw new Error("The suggestion above the high band is in the Inbox (D33)");
    const delta = (kind: InboxKind) => count(seed.counts.after, kind) - count(before, kind);
    const expected: [InboxKind, number][] = [
      ["suggestion", 2],
      ["contradiction", 1],
      ["withdrawn", 1],
      ["review", 2],
      ["duplicate", 1]
    ];
    for (const [kind, wanted] of expected)
      if (delta(kind) !== wanted)
        throw new Error(`The Inbox counts ${delta(kind)} more ${kind} items, not ${wanted}`);
    return seed;
  } finally {
    await closePgPool(pool);
    await server.stop();
  }
}

/** The verdicts a journey reads back, through the repository readers (not the Inbox's own list). */
export interface InboxStoreReaders {
  /** A relation's events, in append order: a verdict is the last one (`kept`, `removed`). */
  relationEvents(relationId: string): Promise<RelationEventRecord[]>;
  /** A change-set's status in the `change_sets` view (`pending_review`, `dismissed`, `applied`). */
  changeSetStatus(kind: "topic" | "relation", id: string): Promise<string | null>;
  /** A finding's status (`open`, `dismissed`, `resolved`). */
  findingStatus(id: string): Promise<string | null>;
  /** The Inbox's counts by kind as the database reads them. */
  counts(): Promise<InboxCountRows>;
  close(): Promise<void>;
}

/** Readers on a running journey profile (its `database/dev-connection.json`; never logged). */
export async function inboxStoreReaders(userDataDir: string): Promise<InboxStoreReaders> {
  const connection = await readConnection(userDataDir);
  if (!["127.0.0.1", "localhost", "::1"].includes(connection.host))
    throw new Error("A journey only reads a database on loopback");
  const pool = createPgPool({
    connectionString: `postgresql://${encodeURIComponent(connection.user)}:${encodeURIComponent(connection.password)}@${connection.host}:${connection.port}/${encodeURIComponent(connection.database)}`,
    max: 2
  });
  const events = createRelationEventRepository(pool);
  const changes = createChangeSetRepository(pool);
  const findings = createGardenerFindingRepository(pool);
  const inbox = createInboxRepository(pool);
  return {
    relationEvents: (relationId) => events.listByRelation("note", relationId),
    changeSetStatus: async (kind, id) => (await changes.get(kind, id))?.status ?? null,
    findingStatus: async (id) => (await findings.get(id))?.status ?? null,
    counts: () => inbox.counts(),
    close: () => closePgPool(pool)
  };
}

// Pure core of the owner blind rating (E4, F2 T30): which topics are sampled from the three
// measurement profiles, which notes show as their members, and the files a rating run is made of.
// It reads nothing and writes nothing; `rating-db.ts` reads the profiles and `rating-run.ts` owns
// the run directory.
//
// A run holds three files with different audiences:
//   sample.json   what the owner's page shows: name, description, aliases and members. Nothing else.
//   sealed.json   which profile, level and naming source each page key stands for. The page and the
//                 server never load it; `score` does.
//   manifest.json the seed, each profile's tree and `config_hash`, and the hashes of the two files
//                 above. It is written last, so a run without a manifest is not served.
import { createRng, deriveSeed } from "@app/domain/topic-tree";
import { z } from "zod";

export const ratingProfiles = ["env-c", "env-g", "env-f"] as const;
export type RatingProfile = (typeof ratingProfiles)[number];

export const profileLabels: Readonly<Record<RatingProfile, string>> = {
  "env-c": "ENV-C",
  "env-g": "ENV-G",
  "env-f": "ENV-F"
};

export interface StratumRule {
  profile: RatingProfile;
  /** Name inside the profile (sealed file and result only; the page never shows it). */
  stratum: string;
  count: number;
  /** Depth below the root: the root is 0 and its children (Areas, after Areas grouping) are 1. */
  minLevel: number;
  maxLevel: number | null;
  leafOnly: boolean;
}

/** E4 (spec section 8) and D20. */
export const ratingConfig = {
  sampleSize: 30,
  membersPerTopic: 8,
  /** Topics that must be rated both coherent and well named (D20). */
  passBar: 24,
  titleLimit: 200,
  ideaLimit: 500,
  sourceLimit: 200,
  strata: [
    { profile: "env-c", stratum: "area", count: 6, minLevel: 1, maxLevel: 1, leafOnly: false },
    { profile: "env-c", stratum: "level-2", count: 6, minLevel: 2, maxLevel: 2, leafOnly: false },
    {
      profile: "env-c",
      stratum: "level-3-plus",
      count: 8,
      minLevel: 3,
      maxLevel: null,
      leafOnly: false
    },
    { profile: "env-g", stratum: "leaf", count: 5, minLevel: 1, maxLevel: null, leafOnly: true },
    { profile: "env-f", stratum: "leaf", count: 5, minLevel: 1, maxLevel: null, leafOnly: true }
  ] as readonly StratumRule[]
};

export type RatingConfig = typeof ratingConfig;

export class RatingSampleError extends Error {
  override readonly name = "RatingSampleError";
}

// ---------------------------------------------------------------------------
// What a profile's database provides

export interface RatingTopicRow {
  id: string;
  parentId: string | null;
  role: "root" | "topic";
  title: string | null;
  nameState: "named" | "provisional" | "unnamed";
  nameSource: string | null;
  nameLanguage: string | null;
  description: string | null;
  aliases: readonly string[];
  /** ISO instant, or null for a live topic. */
  retiredAt: string | null;
}

export interface RatingSnapshot {
  profile: RatingProfile;
  tree: {
    id: string;
    configHash: string;
    generation: number;
    /** An Areas change-set is applied, so the root's children are Areas (D12). */
    areasApplied: boolean;
  };
  topics: readonly RatingTopicRow[];
  /** The primary placement of every current note: one row per note. */
  placements: readonly { topicId: string; noteId: string }[];
}

export interface NoteDetail {
  title: string;
  idea: string;
  sourceTitle: string;
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// The live tree

export interface TopicEntry {
  topic: RatingTopicRow;
  depth: number;
  /** No live child topic. */
  leaf: boolean;
  /** Current notes whose primary placement is in the topic's subtree. */
  notes: number;
  children: string[];
}

/**
 * The live part of the tree, reachable from the root through live topics only. A retired topic and
 * everything below it never enters the index.
 */
export function indexTopics(snapshot: RatingSnapshot): Map<string, TopicEntry> {
  const roots = snapshot.topics.filter(
    (topic) => topic.role === "root" && topic.retiredAt === null
  );
  if (roots.length !== 1) {
    throw new RatingSampleError(
      `The ${profileLabels[snapshot.profile]} tree must have exactly one live root, found ${roots.length}.`
    );
  }
  const root = roots[0] as RatingTopicRow;
  const childrenOf = new Map<string, RatingTopicRow[]>();
  for (const topic of snapshot.topics) {
    if (topic.retiredAt !== null || topic.parentId === null) continue;
    const siblings = childrenOf.get(topic.parentId) ?? [];
    siblings.push(topic);
    childrenOf.set(topic.parentId, siblings);
  }
  const index = new Map<string, TopicEntry>();
  const order: TopicEntry[] = [];
  const queue: TopicEntry[] = [{ topic: root, depth: 0, leaf: false, notes: 0, children: [] }];
  for (let next = 0; next < queue.length; next += 1) {
    const entry = queue[next] as TopicEntry;
    index.set(entry.topic.id, entry);
    order.push(entry);
    const children = (childrenOf.get(entry.topic.id) ?? []).sort((a, b) =>
      compareStrings(a.id, b.id)
    );
    entry.leaf = children.length === 0;
    for (const child of children) {
      if (index.has(child.id)) continue;
      entry.children.push(child.id);
      queue.push({ topic: child, depth: entry.depth + 1, leaf: false, notes: 0, children: [] });
    }
  }
  for (const placement of snapshot.placements) {
    const entry = index.get(placement.topicId);
    if (entry) entry.notes += 1;
  }
  // Bottom-up: children are always after their parent in breadth-first order.
  for (let at = order.length - 1; at > 0; at -= 1) {
    const entry = order[at] as TopicEntry;
    const parent = entry.topic.parentId === null ? undefined : index.get(entry.topic.parentId);
    if (parent) parent.notes += entry.notes;
  }
  return index;
}

/** The notes of a topic's subtree: its own and those of every live descendant, in id order. */
export function subtreeNoteIds(
  index: ReadonlyMap<string, TopicEntry>,
  notesByTopic: ReadonlyMap<string, readonly string[]>,
  topicId: string
): string[] {
  const notes: string[] = [];
  const stack = [topicId];
  while (stack.length > 0) {
    const entry = index.get(stack.pop() as string);
    if (!entry) continue;
    notes.push(...(notesByTopic.get(entry.topic.id) ?? []));
    stack.push(...entry.children);
  }
  return notes.sort(compareStrings);
}

function isRateable(entry: TopicEntry): boolean {
  const { topic } = entry;
  return (
    topic.role === "topic" &&
    topic.nameState === "named" &&
    topic.title !== null &&
    topic.title.trim().length > 0 &&
    entry.notes > 0
  );
}

/** The live, named, non-empty topics a stratum can draw from, in id order. */
export function stratumPool(
  index: ReadonlyMap<string, TopicEntry>,
  rule: StratumRule
): TopicEntry[] {
  return [...index.values()]
    .filter(
      (entry) =>
        isRateable(entry) &&
        entry.depth >= rule.minLevel &&
        (rule.maxLevel === null || entry.depth <= rule.maxLevel) &&
        (!rule.leafOnly || entry.leaf)
    )
    .sort((a, b) => compareStrings(a.topic.id, b.topic.id));
}

// ---------------------------------------------------------------------------
// The draw

export interface DrawnTopic {
  profile: RatingProfile;
  stratum: string;
  level: number;
  leaf: boolean;
  subtreeNotes: number;
  treeId: string;
  configHash: string;
  topicId: string;
  title: string;
  description: string | null;
  aliases: string[];
  nameState: string;
  nameSource: string | null;
  nameLanguage: string | null;
  /** The notes that show on the page, already drawn with the seed. */
  memberIds: string[];
}

export interface ProfileDraw {
  profile: RatingProfile;
  tree: RatingSnapshot["tree"];
  /** What the tree holds, for the manifest. */
  counts: {
    liveTopics: number;
    named: number;
    provisional: number;
    unnamed: number;
    byStratum: { stratum: string; eligible: number; picked: number }[];
  };
  topics: DrawnTopic[];
}

function notesByTopicOf(snapshot: RatingSnapshot): Map<string, string[]> {
  const byTopic = new Map<string, string[]>();
  for (const placement of snapshot.placements) {
    const notes = byTopic.get(placement.topicId) ?? [];
    notes.push(placement.noteId);
    byTopic.set(placement.topicId, notes);
  }
  return byTopic;
}

/** Draws one profile's topics and their members. Deterministic for a seed and a database. */
export function drawProfileTopics(
  snapshot: RatingSnapshot,
  seed: number,
  config: RatingConfig = ratingConfig
): ProfileDraw {
  const index = indexTopics(snapshot);
  const notesByTopic = notesByTopicOf(snapshot);
  const live = [...index.values()].filter((entry) => entry.topic.role === "topic");
  const topics: DrawnTopic[] = [];
  const byStratum: ProfileDraw["counts"]["byStratum"] = [];
  for (const rule of config.strata.filter((candidate) => candidate.profile === snapshot.profile)) {
    const pool = stratumPool(index, rule);
    if (pool.length < rule.count) {
      throw new RatingSampleError(
        `${profileLabels[snapshot.profile]} has ${pool.length} eligible ${rule.stratum} topics ` +
          `(live, named, with notes) and ${rule.count} are needed.`
      );
    }
    const chosen = createRng(deriveSeed(seed, `pick:${snapshot.profile}:${rule.stratum}`))
      .shuffle([...pool])
      .slice(0, rule.count);
    byStratum.push({ stratum: rule.stratum, eligible: pool.length, picked: chosen.length });
    for (const entry of chosen) {
      const { topic } = entry;
      const notes = subtreeNoteIds(index, notesByTopic, topic.id);
      const members = createRng(deriveSeed(seed, `members:${snapshot.profile}:${topic.id}`))
        .shuffle([...notes])
        .slice(0, config.membersPerTopic);
      topics.push({
        profile: snapshot.profile,
        stratum: rule.stratum,
        level: entry.depth,
        leaf: entry.leaf,
        subtreeNotes: entry.notes,
        treeId: snapshot.tree.id,
        configHash: snapshot.tree.configHash,
        topicId: topic.id,
        title: (topic.title ?? "").trim(),
        description: topic.description,
        aliases: [...topic.aliases],
        nameState: topic.nameState,
        nameSource: topic.nameSource,
        nameLanguage: topic.nameLanguage,
        memberIds: members
      });
    }
  }
  return {
    profile: snapshot.profile,
    tree: snapshot.tree,
    counts: {
      liveTopics: live.length,
      named: live.filter((entry) => entry.topic.nameState === "named").length,
      provisional: live.filter((entry) => entry.topic.nameState === "provisional").length,
      unnamed: live.filter((entry) => entry.topic.nameState === "unnamed").length,
      byStratum
    },
    topics
  };
}

// ---------------------------------------------------------------------------
// The run's files

const cleanText = (text: string | null | undefined, limit: number): string => {
  const flat = (text ?? "").replace(/\s+/gu, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

export const SampleFileSchema = z.object({
  version: z.literal(1),
  topics: z.array(
    z.object({
      key: z.string().min(1),
      name: z.string().min(1),
      description: z.string().nullable(),
      aliases: z.array(z.string()),
      members: z.array(z.object({ title: z.string(), idea: z.string(), source: z.string() }))
    })
  )
});
export type SampleFile = z.infer<typeof SampleFileSchema>;

export const SealedFileSchema = z.object({
  version: z.literal(1),
  seed: z.number().int(),
  entries: z.array(
    z.object({
      key: z.string().min(1),
      position: z.number().int().min(1),
      profile: z.enum(ratingProfiles),
      stratum: z.string(),
      level: z.number().int().min(1),
      leaf: z.boolean(),
      subtreeNotes: z.number().int().min(0),
      treeId: z.string(),
      configHash: z.string(),
      topicId: z.string(),
      name: z.string(),
      nameState: z.string(),
      nameSource: z.string().nullable(),
      nameLanguage: z.string().nullable(),
      memberNoteIds: z.array(z.string())
    })
  )
});
export type SealedFile = z.infer<typeof SealedFileSchema>;

export const ManifestFileSchema = z.object({
  version: z.literal(1),
  run: z.string().min(1),
  seed: z.number().int(),
  createdAt: z.string(),
  sampleSize: z.number().int().min(1),
  membersPerTopic: z.number().int().min(1),
  passBar: z.number().int().min(1),
  profiles: z.array(
    z.object({
      profile: z.enum(ratingProfiles),
      label: z.string(),
      treeId: z.string(),
      configHash: z.string(),
      generation: z.number().int(),
      areasApplied: z.boolean(),
      counts: z.object({
        liveTopics: z.number().int(),
        named: z.number().int(),
        provisional: z.number().int(),
        unnamed: z.number().int(),
        byStratum: z.array(
          z.object({ stratum: z.string(), eligible: z.number().int(), picked: z.number().int() })
        )
      })
    })
  ),
  files: z.object({
    sample: z.object({ file: z.literal("sample.json"), sha256: z.string() }),
    sealed: z.object({ file: z.literal("sealed.json"), sha256: z.string() })
  })
});
export type ManifestFile = z.infer<typeof ManifestFileSchema>;

export interface RatingParts {
  sample: SampleFile;
  sealed: SealedFile;
  profiles: ManifestFile["profiles"];
}

export const positionKey = (position: number): string => `t${String(position).padStart(2, "0")}`;

/**
 * Puts the three profiles' topics in one shuffled order (the seed decides it) and splits them into
 * what the page shows and what stays sealed. `details` has the notes the draws asked for, by
 * profile; a note that is no longer current is skipped.
 */
export function assembleRating(input: {
  seed: number;
  draws: readonly ProfileDraw[];
  details: Readonly<Record<RatingProfile, ReadonlyMap<string, NoteDetail>>>;
  config?: RatingConfig;
}): RatingParts {
  const config = input.config ?? ratingConfig;
  for (const profile of ratingProfiles) {
    if (input.draws.filter((draw) => draw.profile === profile).length !== 1) {
      throw new RatingSampleError(`The draw needs exactly one ${profileLabels[profile]} profile.`);
    }
  }
  const canonical = ratingProfiles.flatMap(
    (profile) => input.draws.find((draw) => draw.profile === profile)?.topics ?? []
  );
  if (canonical.length !== config.sampleSize) {
    throw new RatingSampleError(
      `The sample has ${canonical.length} topics and ${config.sampleSize} are needed.`
    );
  }
  const ordered = createRng(deriveSeed(input.seed, "order")).shuffle([...canonical]);
  const sample: SampleFile["topics"] = [];
  const entries: SealedFile["entries"] = [];
  ordered.forEach((drawn, at) => {
    const key = positionKey(at + 1);
    const detail = input.details[drawn.profile];
    const members = drawn.memberIds.flatMap((id) => {
      const note = detail.get(id);
      return note ? [{ id, note }] : [];
    });
    if (members.length === 0) {
      throw new RatingSampleError(
        `The topic drawn as ${key} has no readable notes; run the sample again.`
      );
    }
    sample.push({
      key,
      name: cleanText(drawn.title, config.titleLimit),
      description: drawn.description === null ? null : cleanText(drawn.description, 400) || null,
      aliases: drawn.aliases.map((alias) => cleanText(alias, config.titleLimit)).filter(Boolean),
      members: members.map(({ note }) => ({
        title: cleanText(note.title, config.titleLimit),
        idea: cleanText(note.idea, config.ideaLimit),
        source: cleanText(note.sourceTitle, config.sourceLimit)
      }))
    });
    entries.push({
      key,
      position: at + 1,
      profile: drawn.profile,
      stratum: drawn.stratum,
      level: drawn.level,
      leaf: drawn.leaf,
      subtreeNotes: drawn.subtreeNotes,
      treeId: drawn.treeId,
      configHash: drawn.configHash,
      topicId: drawn.topicId,
      name: drawn.title,
      nameState: drawn.nameState,
      nameSource: drawn.nameSource,
      nameLanguage: drawn.nameLanguage,
      memberNoteIds: members.map(({ id }) => id)
    });
  });
  return {
    sample: { version: 1, topics: sample },
    sealed: { version: 1, seed: input.seed, entries },
    profiles: ratingProfiles.map((profile) => {
      const draw = input.draws.find((candidate) => candidate.profile === profile) as ProfileDraw;
      return {
        profile,
        label: profileLabels[profile],
        treeId: draw.tree.id,
        configHash: draw.tree.configHash,
        generation: draw.tree.generation,
        areasApplied: draw.tree.areasApplied,
        counts: draw.counts
      };
    })
  };
}

// Synthetic profiles for the rating tests: a tree with Areas, two levels below them and a few
// deeper branches, plus the topics a sample must never pick (unnamed, provisional, retired, empty,
// below a retired parent). Pure data; no database.
import { assembleRating, drawProfileTopics, ratingProfiles } from "./rating-core.js";
import type {
  NoteDetail,
  RatingParts,
  RatingProfile,
  RatingSnapshot,
  RatingTopicRow
} from "./rating-core.js";

const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export interface FixtureOptions {
  profile: RatingProfile;
  /** Offsets every id so two profiles never share one. */
  base?: number;
  areas?: number;
  configHash?: string;
}

export interface Fixture {
  snapshot: RatingSnapshot;
  /** Topics that are never eligible, by reason. */
  ineligible: {
    unnamed: string;
    provisional: string;
    retired: string;
    empty: string;
    orphan: string;
  };
  /** A note placed below a retired topic, which no draw can reach. */
  hiddenNote: string;
  details: Map<string, NoteDetail>;
}

export function buildFixture(options: FixtureOptions): Fixture {
  const base = options.base ?? 0;
  const areaCount = options.areas ?? 6;
  let counter = 1;
  const next = (): string => uid(base + counter++);
  const topics: RatingTopicRow[] = [];
  const placements: { topicId: string; noteId: string }[] = [];
  const details = new Map<string, NoteDetail>();
  let noteCounter = 0;

  const topic = (parentId: string | null, fields: Partial<RatingTopicRow> = {}): RatingTopicRow => {
    const id = next();
    const row: RatingTopicRow = {
      id,
      parentId,
      role: parentId === null ? "root" : "topic",
      title: parentId === null ? null : `Topic ${topics.length}`,
      nameState: parentId === null ? "unnamed" : "named",
      nameSource: parentId === null ? null : "llm",
      nameLanguage: parentId === null ? null : "pt-BR",
      description: parentId === null ? null : `Description of topic ${topics.length}`,
      aliases: [],
      retiredAt: null,
      ...fields
    };
    topics.push(row);
    return row;
  };
  const note = (topicId: string, count: number): void => {
    for (let at = 0; at < count; at += 1) {
      noteCounter += 1;
      const noteId = uid(base + 100_000 + noteCounter);
      placements.push({ topicId, noteId });
      details.set(noteId, {
        title: `Note ${noteCounter}`,
        idea: `Idea ${noteCounter}`,
        sourceTitle: `Source ${noteCounter % 7}`
      });
    }
  };

  const root = topic(null);
  for (let area = 0; area < areaCount; area += 1) {
    const areaTopic = topic(root.id, { aliases: [`Alias ${area}`] });
    for (let second = 0; second < 2; second += 1) {
      const secondTopic = topic(areaTopic.id);
      for (let third = 0; third < 2; third += 1) {
        const thirdTopic = topic(secondTopic.id);
        note(thirdTopic.id, 1);
        // Every second branch goes one level deeper, so deep topics are not all leaves.
        const fourth = topic(thirdTopic.id);
        note(fourth.id, 12);
      }
    }
  }

  // Never eligible.
  const unnamed = topic(root.id, { title: null, nameState: "unnamed", nameSource: null });
  note(unnamed.id, 3);
  const provisional = topic(root.id, { nameState: "provisional", nameSource: "tfidf" });
  note(provisional.id, 3);
  const empty = topic(root.id);
  const retired = topic(root.id, { retiredAt: "2026-10-01T00:00:00.000Z" });
  const underRetired = topic(retired.id);
  note(underRetired.id, 2);
  const hiddenNote = placements[placements.length - 1]?.noteId as string;
  const orphan = topic(retired.id);

  return {
    snapshot: {
      profile: options.profile,
      tree: {
        id: uid(base + 90_000),
        configHash: options.configHash ?? `config-hash-${options.profile}`,
        generation: 7,
        areasApplied: true
      },
      topics,
      placements
    },
    ineligible: {
      unnamed: unnamed.id,
      provisional: provisional.id,
      retired: retired.id,
      empty: empty.id,
      orphan: orphan.id
    },
    hiddenNote,
    details
  };
}

const bases: Record<RatingProfile, number> = { "env-c": 0, "env-g": 1_000_000, "env-f": 2_000_000 };

/** The three synthetic profiles drawn and assembled, as `sample` would for a seed. */
export function buildRatingParts(seed: number): RatingParts {
  const fixtures = Object.fromEntries(
    ratingProfiles.map((profile) => [
      profile,
      buildFixture({ profile, base: bases[profile], configHash: `hash-of-${profile}` })
    ])
  ) as Record<RatingProfile, Fixture>;
  return assembleRating({
    seed,
    draws: ratingProfiles.map((profile) => drawProfileTopics(fixtures[profile].snapshot, seed)),
    details: {
      "env-c": fixtures["env-c"].details,
      "env-g": fixtures["env-g"].details,
      "env-f": fixtures["env-f"].details
    }
  });
}

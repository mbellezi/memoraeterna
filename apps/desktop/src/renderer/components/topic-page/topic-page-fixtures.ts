import type { TopicCentralNote, TopicNoteLeaf, TopicPage } from "@app/domain";

/** Synthetic Topic page data for tests: no real library content. */
export const topicFixtureId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const topicFixtureAt = "2026-10-15T13:41:00.000Z";

export function centralNote(overrides: Partial<TopicCentralNote> = {}): TopicCentralNote {
  return {
    id: topicFixtureId(100),
    title: "Retention falls fast",
    idea: "Retention drops quickly in the first hours after study and then slows down.",
    sourceId: topicFixtureId(200),
    sourceTitle: "Forgetting curve",
    relationCount: 6,
    provenance: "ai",
    centrality: 0.91,
    ...overrides
  };
}

export function noteLeaf(overrides: Partial<TopicNoteLeaf> = {}): TopicNoteLeaf {
  return {
    kind: "note",
    id: topicFixtureId(300),
    title: "Spaced review flattens the curve",
    role: "primary",
    unsorted: false,
    sourceTitle: "Spacing handbook",
    provenance: "ai",
    ...overrides
  };
}

/** A topic two levels below the root with subtopics, notes, sources, neighbours and a last change. */
export function topicPage(overrides: Partial<TopicPage> = {}): TopicPage {
  const rootId = topicFixtureId(1);
  const areaId = topicFixtureId(2);
  const topicId = topicFixtureId(3);
  return {
    generation: 12,
    topic: {
      id: topicId,
      parentId: areaId,
      title: "Forgetting curve",
      nameState: "named",
      management: "ai",
      items: 23,
      directItems: 3,
      unsorted: 0,
      children: 2,
      health: "good",
      newThisWeek: 2,
      position: 0,
      updatedAt: topicFixtureAt,
      description: "How retention falls with time since study and what slows that fall.",
      aliases: ["Ebbinghaus curve", "memory decay"],
      nameLanguage: "en",
      coherence: 0.82
    },
    redirectedFrom: null,
    path: [
      { id: rootId, title: null },
      { id: areaId, title: "Memory and learning" },
      { id: topicId, title: "Forgetting curve" }
    ],
    counts: { notes: 23, sources: 4, subtopics: 2 },
    subtopics: [
      {
        id: topicFixtureId(10),
        title: "Decay models",
        items: 11,
        description: "Exponential, power or a sum of exponentials: which function fits the loss.",
        health: "good"
      },
      {
        id: topicFixtureId(11),
        title: null,
        items: 9,
        description: null,
        health: "attention"
      }
    ],
    centralNotes: [
      centralNote(),
      centralNote({
        id: topicFixtureId(101),
        title: "Savings method",
        idea: "Ebbinghaus measured memory by the time saved when relearning a list.",
        sourceTitle: "Forgetting curve (encyclopedia)",
        relationCount: 1
      }),
      centralNote({
        id: topicFixtureId(102),
        title: "Review",
        idea: "Each spaced review makes the next curve flatter.",
        sourceId: null,
        sourceTitle: null,
        relationCount: 0,
        provenance: "human"
      })
    ],
    moreNotes: 20,
    sources: [
      {
        id: topicFixtureId(200),
        title: "Forgetting curve",
        subtitle: "Encyclopedia, English",
        noteCount: 8
      },
      { id: topicFixtureId(201), title: "A replication study", subtitle: null, noteCount: 1 }
    ],
    relatedTopics: [
      { id: topicFixtureId(20), title: "Spaced repetition", relationCount: 8 },
      { id: topicFixtureId(21), title: null, relationCount: 1 }
    ],
    relationStances: {
      supports: 9,
      contrasts: 1,
      extends: 5,
      similar_to: 0,
      depends_on: 3,
      clarifies: 0,
      mentions: 0,
      related: 7
    },
    lastChange: {
      changeSetId: topicFixtureId(900),
      titleKey: "topics.changeSets.place",
      titleParams: { items: 2 },
      at: topicFixtureAt,
      undo: "available"
    },
    overview: { status: "absent", canWrite: false },
    ...overrides
  };
}

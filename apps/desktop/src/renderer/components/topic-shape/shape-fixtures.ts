import type {
  TopicChangeSet,
  TopicChangeSetSummary,
  TopicHealth,
  TopicManagement,
  TopicShape,
  TopicShapeNode,
  TopicShapeWarning
} from "@app/domain";

/** Synthetic Shape data for tests: no real library content. */
export const shapeId = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const shapeAt = "2026-10-15T13:41:00.000Z";

export function shapeNode(
  n: number,
  parent: number | null,
  depth: number,
  title: string | null,
  items: number,
  extra: Partial<TopicShapeNode> = {}
): TopicShapeNode {
  return {
    id: shapeId(n),
    parentId: parent === null ? null : shapeId(parent),
    depth,
    title,
    management: "ai" as TopicManagement,
    items,
    directItems: items,
    children: 0,
    health: "good" as TopicHealth,
    newThisWeek: 0,
    coherence: 0.8,
    ...extra
  };
}

/** Ids of the topics in `sampleShape`. */
export const sample = {
  root: 1,
  memory: 2,
  forgetting: 3,
  decay: 4,
  replications: 5,
  retrieval: 6,
  testing: 7,
  spacing: 8,
  language: 9,
  social: 10,
  literature: 11,
  machado: 12,
  alienist: 13,
  cartomancer: 14,
  madness: 15,
  irony: 16,
  science: 17,
  fair: 18,
  pendingChange: 900,
  todayChange: 901
} as const;

/**
 * The shape of the approved Map mockup: 161 items, 17 topics, three Areas and 3 unsorted items;
 * "Forgetting curve" holds 2 subtopics and 6 items of its own, "Open science" is a chain of one
 * child, and a merge on the human topic "Testing effect" waits for the person.
 */
export function sampleNodes(): TopicShapeNode[] {
  return [
    shapeNode(sample.root, null, 0, null, 161, { directItems: 3, children: 3, coherence: null }),
    shapeNode(sample.memory, sample.root, 1, "Memory and learning", 90, {
      directItems: 0,
      children: 6
    }),
    shapeNode(sample.literature, sample.root, 1, "Literature", 58, { directItems: 0, children: 3 }),
    shapeNode(sample.science, sample.root, 1, "Open science", 10, {
      directItems: 0,
      children: 1,
      health: "attention"
    }),
    shapeNode(sample.forgetting, sample.memory, 2, "Forgetting curve", 26, {
      directItems: 6,
      children: 2,
      newThisWeek: 8,
      coherence: 0.74
    }),
    shapeNode(sample.retrieval, sample.memory, 2, "Retrieval practice", 17),
    shapeNode(sample.testing, sample.memory, 2, "Testing effect", 6, {
      management: "human",
      health: "attention"
    }),
    shapeNode(sample.spacing, sample.memory, 2, "Spaced repetition", 14),
    shapeNode(sample.language, sample.memory, 2, "Memory and language", 16),
    shapeNode(sample.social, sample.memory, 2, null, 11),
    shapeNode(sample.machado, sample.literature, 2, "Machado de Assis", 36, {
      directItems: 0,
      children: 2,
      newThisWeek: 36
    }),
    shapeNode(sample.madness, sample.literature, 2, "Madness and reason", 12),
    shapeNode(sample.irony, sample.literature, 2, "Irony and sacrifice", 10),
    shapeNode(sample.fair, sample.science, 2, "FAIR principles", 10),
    shapeNode(sample.decay, sample.forgetting, 3, "Decay models", 11),
    shapeNode(sample.replications, sample.forgetting, 3, "Ebbinghaus replications", 9),
    shapeNode(sample.alienist, sample.machado, 3, "The Alienist", 24),
    shapeNode(sample.cartomancer, sample.machado, 3, "The Fortune Teller", 12)
  ];
}

export const sampleWarnings = (): TopicShapeWarning[] => [
  {
    topicId: shapeId(sample.testing),
    code: "pending-review",
    params: { origin: "rebalance", risk: "medium", titleKey: "topics.changeSets.proposal" },
    changeSetId: shapeId(sample.pendingChange),
    pendingReview: true
  },
  {
    topicId: shapeId(sample.science),
    code: "single-child",
    params: { invariant: "I6", severity: "soft", awaitingApproval: false },
    changeSetId: null,
    pendingReview: false
  }
];

export const sampleChange = (
  overrides: Partial<TopicChangeSetSummary> = {}
): TopicChangeSetSummary => ({
  id: shapeId(sample.todayChange),
  origin: "rebalance",
  status: "applied",
  titleKey: "topics.changeSets.rebalance",
  titleParams: { operations: 2, items: 8 },
  risk: "low",
  at: shapeAt,
  undo: "available",
  ...overrides
});

export function sampleShape(overrides: Partial<TopicShape> = {}): TopicShape {
  return {
    generation: 12,
    summary: {
      items: 161,
      topics: 17,
      meanDepth: 2.6,
      reachable: 1,
      unsortedShare: 3 / 161,
      needsVector: 0,
      soft: 2,
      hard: 0
    },
    nodes: sampleNodes(),
    truncated: false,
    warnings: sampleWarnings(),
    changedToday: [sampleChange()],
    ...overrides
  };
}

export function sampleChangeSet(): TopicChangeSet {
  return {
    summary: sampleChange({
      id: shapeId(sample.pendingChange),
      status: "pending_review",
      undo: "unavailable"
    }),
    before: {
      topics: [
        { id: shapeId(sample.testing), title: "Testing effect", parentTitle: "Memory and learning" }
      ],
      items: [
        {
          kind: "note",
          id: shapeId(5001),
          title: "Quizzing beats rereading",
          topicId: shapeId(sample.testing),
          topicTitle: "Testing effect"
        }
      ]
    },
    after: {
      topics: [
        {
          id: shapeId(sample.retrieval),
          title: "Retrieval practice",
          parentTitle: "Memory and learning"
        }
      ],
      items: [
        {
          kind: "note",
          id: shapeId(5001),
          title: "Quizzing beats rereading",
          topicId: shapeId(sample.retrieval),
          topicTitle: "Retrieval practice"
        }
      ]
    },
    truncated: false
  };
}

/**
 * A big consistent tree for layout timing: `count` topics in `levels` levels below the root, items
 * spread so that every parent holds exactly its children plus its direct items.
 */
export function bigNodes(count: number, levels = 4): TopicShapeNode[] {
  const nodes: TopicShapeNode[] = [];
  let next = 1;
  const fan = Math.max(2, Math.ceil(Math.pow(count, 1 / levels)));
  const build = (
    parent: number | null,
    depth: number,
    budget: { left: number }
  ): { id: number; items: number } => {
    const id = next++;
    const index = nodes.length;
    nodes.push(shapeNode(id, parent, depth, `Topic ${id}`, 0));
    let items = 0;
    let children = 0;
    if (depth < levels) {
      while (children < fan && budget.left > 0) {
        budget.left -= 1;
        const child = build(id, depth + 1, budget);
        items += child.items;
        children += 1;
      }
    }
    const direct = 3 + (id % 7);
    items += direct;
    nodes[index] = shapeNode(id, parent, depth, `Topic ${id}`, items, {
      directItems: direct,
      children
    });
    return { id, items };
  };
  build(null, 0, { left: count - 1 });
  return nodes;
}

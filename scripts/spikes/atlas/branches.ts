// The level-1 branch of a note (F5 D21): the child of the root that holds the note's primary
// placement. Pure: it takes the tree's topics and placements as plain rows.

export interface BranchTopic {
  id: string;
  parentId: string | null;
  role: string;
  title: string | null;
  retiredAt: string | null;
}

export interface BranchPlacement {
  itemKind: string;
  itemId: string;
  topicId: string;
  rank: number;
}

export interface LevelOneBranch {
  topicId: string;
  title: string;
}

/** The live level-1 topics: the live children of the live root, in title then id order. */
export function levelOneBranches(topics: readonly BranchTopic[]): LevelOneBranch[] {
  const root = topics.find((topic) => topic.role === "root" && topic.retiredAt === null);
  if (!root) return [];
  return topics
    .filter((topic) => topic.parentId === root.id && topic.retiredAt === null)
    .map((topic) => ({ topicId: topic.id, title: topic.title ?? "(unnamed)" }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.topicId.localeCompare(b.topicId));
}

/**
 * The level-1 topic id of each note's primary placement (rank 0), or null for a note placed on the
 * root itself or whose topic chain does not reach a level-1 topic. A retired topic on the way up
 * (a placement the tree has not yet moved) is followed through its parent pointer.
 */
export function primaryBranchOfNotes(
  topics: readonly BranchTopic[],
  placements: readonly BranchPlacement[]
): Map<string, string | null> {
  const byId = new Map(topics.map((topic) => [topic.id, topic] as const));
  const root = topics.find((topic) => topic.role === "root" && topic.retiredAt === null);
  const branchOf = new Map<string, string | null>();
  const resolve = (topicId: string): string | null => {
    if (branchOf.has(topicId)) return branchOf.get(topicId) ?? null;
    let current = byId.get(topicId);
    let result: string | null = null;
    for (let hops = 0; current && hops < 64; hops += 1) {
      if (!root || current.parentId === null) break;
      if (current.parentId === root.id) {
        result = current.id;
        break;
      }
      current = byId.get(current.parentId);
    }
    branchOf.set(topicId, result);
    return result;
  };
  const notes = new Map<string, string | null>();
  for (const placement of placements) {
    if (placement.itemKind !== "note" || placement.rank !== 0) continue;
    notes.set(placement.itemId.toLowerCase(), resolve(placement.topicId));
  }
  return notes;
}

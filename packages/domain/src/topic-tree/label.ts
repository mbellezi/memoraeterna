// Topic labels and label mixing (plan 4.1 PLACE: "scoring children by centroid and label
// similarity"). A label is the embedded "title · aliases · description" of a named topic in the
// tree's embedding space (T18 embeds it; strategy `topic-label-v1:<spaceKey>`). PLACE ranks
// children by the centroid cosine mixed with the label cosine at `placement.labelWeight`
// (0 = centroid only, the start value, D10); admission always tests the centroid cosine, because
// the admission threshold is a statistic of member cosines to the centroid (stats.ts).
//
// Labels are engine bookkeeping on the in-memory state, never structure events: the service
// attaches the current label vectors it loaded and drops a label whose text changed (a rename or a
// new description makes it stale until it is re-embedded).
import { compareStrings } from "./ids.js";
import { TopicTreeStateError, getTopic } from "./state.js";
import type { TopicLabel, TopicNode, TopicRecord, TopicTreeState } from "./state.js";
import { dot, maxUnitDeviation } from "./vectors.js";

/** Separator between the parts of a label text. */
export const topicLabelSeparator = " · ";

/** Largest |1 - |v|| accepted for a label vector. */
const unitTolerance = 1e-3;

/**
 * The text a topic label embeds: the title, then the aliases in stored order, then the
 * description. An unnamed topic (no title) has no label.
 */
export function topicLabelText(
  topic: Pick<TopicRecord, "title" | "aliases" | "description">
): string | null {
  if (topic.title === null) return null;
  const parts = [topic.title, ...topic.aliases];
  if (topic.description !== null) parts.push(topic.description);
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(topicLabelSeparator);
}

/** Cosine of a unit vector to a topic's label, or null when the topic has no label. */
export function labelCosine(node: TopicNode, vector: Float32Array): number | null {
  return node.label === null ? null : dot(vector, node.label.vector);
}

/**
 * The ranking score of a child: the centroid cosine, mixed with the label cosine as
 * (1 - w) * cosine + w * label when the topic has a label and w > 0.
 */
export function mixLabelScore(cosine: number, label: number | null, weight: number): number {
  if (label === null || weight === 0) return cosine;
  return (1 - weight) * cosine + weight * label;
}

/** Attaches (or clears, with null) the label of a topic; the vector must be unit length. */
export function setTopicLabel(
  state: TopicTreeState,
  topicId: string,
  label: TopicLabel | null
): void {
  const node = getTopic(state, topicId);
  if (label === null) {
    node.label = null;
    return;
  }
  if (label.vector.length !== state.dim) {
    throw new TopicTreeStateError(
      `Label of topic ${topicId} has ${label.vector.length} dimensions, expected ${state.dim}`
    );
  }
  const deviation = maxUnitDeviation({ dim: state.dim, count: 1, data: label.vector });
  if (!(deviation <= unitTolerance)) {
    throw new TopicTreeStateError(`Label of topic ${topicId} is not a unit vector`);
  }
  node.label = { vector: label.vector.slice(), textHash: label.textHash };
}

/**
 * Drops every label whose text hash no longer matches the topic's current label text (renamed,
 * re-described or unnamed topics, retired ones included). `hashText` must be the hash function
 * the labels were stored with. Returns the topics whose label was dropped, in ID order.
 */
export function dropStaleLabels(
  state: TopicTreeState,
  hashText: (text: string) => string
): string[] {
  const dropped: string[] = [];
  for (const node of state.topics.values()) {
    if (node.label === null) continue;
    const text = topicLabelText(node);
    if (text === null || hashText(text) !== node.label.textHash) {
      node.label = null;
      dropped.push(node.id);
    }
  }
  return dropped.sort(compareStrings);
}

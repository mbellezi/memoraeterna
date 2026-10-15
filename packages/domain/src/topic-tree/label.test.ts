import { describe, expect, it } from "vitest";

import { createTopicTreeEditor } from "./events.js";
import { uuidOf } from "./fixtures/placement-world.js";
import {
  dropStaleLabels,
  labelCosine,
  mixLabelScore,
  setTopicLabel,
  topicLabelText
} from "./label.js";
import { createTopicTreeState, getTopic, topicRecord } from "./state.js";
import { unit } from "./vectors.js";

const rootId = uuidOf(0);
const topicId = uuidOf(1);

function named() {
  const state = createTopicTreeState({ dim: 3, rootId });
  createTopicTreeEditor(state).createTopic(topicId, rootId, {
    title: "Astronomia",
    nameState: "named",
    nameSource: "llm",
    aliases: ["Astronomy", " Céu "],
    description: "Estrelas e planetas."
  });
  return state;
}

describe("topic labels", () => {
  it("builds the label text from title, aliases and description", () => {
    const state = named();
    expect(topicLabelText(getTopic(state, topicId))).toBe(
      "Astronomia · Astronomy · Céu · Estrelas e planetas."
    );
    expect(topicLabelText(topicRecord(topicId, rootId))).toBeNull();
    expect(topicLabelText(topicRecord(topicId, rootId, { title: "Só", nameState: "named" }))).toBe(
      "Só"
    );
  });

  it("mixes the label cosine into the score only with a label and a weight", () => {
    expect(mixLabelScore(0.6, null, 0.5)).toBe(0.6);
    expect(mixLabelScore(0.6, 0.9, 0)).toBe(0.6);
    expect(mixLabelScore(0.6, 0.9, 0.5)).toBeCloseTo(0.75, 12);
  });

  it("attaches unit labels, refuses others, and drops stale ones", () => {
    const state = named();
    const vector = unit(Float32Array.from([1, 2, 2]));
    const hash = (text: string): string => `h:${text.length}`;
    const node = getTopic(state, topicId);
    setTopicLabel(state, topicId, { vector, textHash: hash(topicLabelText(node) as string) });
    expect(labelCosine(node, unit(Float32Array.from([1, 2, 2])))).toBeCloseTo(1, 6);
    expect(labelCosine(getTopic(state, rootId), vector)).toBeNull();
    expect(() =>
      setTopicLabel(state, topicId, { vector: Float32Array.from([1, 1, 1]), textHash: "x" })
    ).toThrow(/unit/);
    expect(() =>
      setTopicLabel(state, topicId, { vector: Float32Array.from([1, 0]), textHash: "x" })
    ).toThrow(/dimensions/);
    expect(dropStaleLabels(state, hash)).toEqual([]);
    createTopicTreeEditor(state).renameTopic(topicId, { title: "Astronomia e astrofísica" });
    expect(dropStaleLabels(state, hash)).toEqual([topicId]);
    expect(getTopic(state, topicId).label).toBeNull();
    setTopicLabel(state, topicId, { vector, textHash: "x" });
    setTopicLabel(state, topicId, null);
    expect(getTopic(state, topicId).label).toBeNull();
  });
});

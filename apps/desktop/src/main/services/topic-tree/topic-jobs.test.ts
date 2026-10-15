import { describe, expect, it } from "vitest";

import { lightWorkerTypes } from "../job-lanes.js";
import {
  TopicScopedPayloadSchema,
  TopicSweepPayloadSchema,
  createTopicJobRegistry,
  scopeOfPayload,
  scopePayload,
  topicDedupeKey,
  topicJobTypes
} from "./topic-jobs.js";

const tree = "00000000-0000-4000-8000-000000000001";
const root = "00000000-0000-4000-8000-000000000002";
const note = "00000000-0000-4000-8000-000000000003";
const execute = async () => ({});

describe("topic job keys and payloads", () => {
  it("names one place or gate job per root source, or per note without one", () => {
    expect(topicDedupeKey(topicJobTypes.place, tree, { rootSourceId: root })).toBe(
      `topic-place:${tree}:${root}`
    );
    expect(topicDedupeKey(topicJobTypes.place, tree, { noteId: note })).toBe(
      `topic-place:${tree}:note:${note}`
    );
    expect(topicDedupeKey(topicJobTypes.gate, tree, { rootSourceId: root })).toBe(
      `topic-gate:${tree}:${root}`
    );
    expect(() => topicDedupeKey(topicJobTypes.place, tree)).toThrow(/scope_required/);
  });

  it("names tree-wide jobs by tree, and a sweep before any tree by none", () => {
    expect(topicDedupeKey(topicJobTypes.sweep, tree)).toBe(`topic-sweep:${tree}`);
    expect(topicDedupeKey(topicJobTypes.sweep, null)).toBe("topic-sweep:none");
    expect(topicDedupeKey(topicJobTypes.labelEmbed, tree)).toBe(`topic-label:${tree}`);
    expect(topicDedupeKey(topicJobTypes.build, tree)).toBe(`topic-build:${tree}`);
    expect(() => topicDedupeKey(topicJobTypes.build, null)).toThrow(/tree_required/);
    // Every key fits the jobs_dedupe_key bound.
    expect(topicDedupeKey(topicJobTypes.place, tree, { noteId: note }).length).toBeLessThan(200);
  });

  it("carries the root as sourceItemId, so cancelling a source cancels its topic jobs", () => {
    const payload = scopePayload(tree, { rootSourceId: root });
    expect(payload).toEqual({ treeId: tree, rootSourceId: root, sourceItemId: root });
    expect(scopeOfPayload(TopicScopedPayloadSchema.parse(payload))).toEqual({ rootSourceId: root });
    expect(
      scopeOfPayload(TopicScopedPayloadSchema.parse(scopePayload(tree, { noteId: note })))
    ).toEqual({
      noteId: note
    });
  });

  it("refuses a payload with both scopes, neither, a foreign sourceItemId or unknown keys", () => {
    for (const payload of [
      { treeId: tree },
      { treeId: tree, rootSourceId: root, sourceItemId: root, noteId: note },
      { treeId: tree, rootSourceId: root, sourceItemId: note },
      { treeId: tree, noteId: note, extra: true }
    ]) {
      expect(TopicScopedPayloadSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(
        false
      );
    }
    expect(TopicSweepPayloadSchema.parse({ treeId: null, reason: "startup" })).toEqual({
      treeId: null,
      reason: "startup"
    });
    expect(TopicSweepPayloadSchema.safeParse({ treeId: tree, reason: "whenever" }).success).toBe(
      false
    );
  });
});

describe("the topic job registry", () => {
  it("puts PLACE and the sweep on compute and model calls on the model worker (D33)", () => {
    const registry = createTopicJobRegistry(
      {
        [topicJobTypes.place]: { needsModel: false, execute },
        [topicJobTypes.sweep]: { needsModel: false, execute },
        [topicJobTypes.gate]: { needsModel: true, execute }
      },
      () => false
    );
    expect(lightWorkerTypes(registry)).toEqual({
      compute: ["topic-place", "topic-sweep"],
      model: ["topic-gate"]
    });
  });

  it("refuses an executor that declares the wrong worker", () => {
    expect(() =>
      createTopicJobRegistry({ [topicJobTypes.place]: { needsModel: true, execute } }, () => false)
    ).toThrow(/topic_job_worker_mismatch:topic-place/);
    expect(() =>
      createTopicJobRegistry({ [topicJobTypes.name]: { needsModel: false, execute } }, () => false)
    ).toThrow(/topic_job_worker_mismatch:topic-name/);
  });

  it("holds every type while the barrier is on", () => {
    let held = true;
    const registry = createTopicJobRegistry(
      { [topicJobTypes.place]: { needsModel: false, execute } },
      () => held
    );
    expect(registry[topicJobTypes.place]?.held?.()).toBe(true);
    held = false;
    expect(registry[topicJobTypes.place]?.held?.()).toBe(false);
  });
});

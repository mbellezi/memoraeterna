import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { topicsBlockedReasons } from "../topics.js";
import {
  blockerClearAt,
  canonicalFingerprintInput,
  compareBlockerClasses,
  gardenerBlockerClasses,
  gardenerBlockerReasons,
  GardenerBlockerSchema,
  gardenerFingerprint,
  gardenerJobKeys,
  gardenerJobPayload,
  gardenerResultOf,
  gardenerSkipReason,
  gardenerStateOf,
  gardenerTaskConfig,
  GardenerTaskConfigSchema,
  gardenerTaskKinds,
  inlineIngestionStageTypes,
  mostPressingBlocker,
  nextLocalDay,
  resultStatusStates,
  topicBlockedReasonBlockers
} from "./index.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const tree = "6f1e7f9c-4f7a-4d6b-9a52-0c3f7b2d1e11";
const root = "0b7d2c8e-1a3f-4e5d-8c9b-7a6f5e4d3c2b";

describe("Gardener kinds (spec 3.1)", () => {
  it("scopes topic jobs by tree part and subject", () => {
    expect(gardenerJobKeys("topic-place", { treeId: tree, rootSourceId: root })).toEqual({
      scopeKey: `tree:${tree}:structure`,
      subjectKey: `root:${root}`,
      rootOf: null
    });
    expect(gardenerJobKeys("topic-gate", { treeId: tree, noteId: root })).toMatchObject({
      scopeKey: `tree:${tree}:gate`,
      subjectKey: `note:${root}`
    });
    for (const type of ["topic-name", "topic-areas", "topic-label-embed"])
      expect(gardenerJobKeys(type, { treeId: tree })).toMatchObject({
        scopeKey: `tree:${tree}:names`,
        subjectKey: `tree:${tree}`
      });
    for (const type of ["topic-sweep", "topic-rebalance", "topic-build", "topic-audit"])
      expect(gardenerJobKeys(type, { treeId: tree })).toMatchObject({
        scopeKey: `tree:${tree}:structure`,
        subjectKey: `tree:${tree}`
      });
    // A sweep before any tree exists names none: no scope.
    expect(gardenerJobKeys("topic-sweep", { treeId: null, reason: "startup" })).toMatchObject({
      scopeKey: null
    });
  });

  it("scopes relation, singleton and new kinds, and leaves stages and cache-only work alone", () => {
    expect(gardenerJobKeys("relation-link", { rootId: root })).toMatchObject({
      scopeKey: `root:${root}`,
      subjectKey: `root:${root}`
    });
    expect(gardenerJobKeys("relation-match", { rootId: root, noteId: tree })).toMatchObject({
      scopeKey: `root:${root}`,
      subjectKey: `note:${tree}`
    });
    expect(gardenerJobKeys("relation-retype", {})).toMatchObject({
      scopeKey: null,
      subjectKey: "relation-retype"
    });
    expect(gardenerJobKeys("catalog-header", {})).toMatchObject({
      scopeKey: "catalog-header",
      subjectKey: "catalog-header"
    });
    expect(gardenerJobKeys("topic-overview", { topicId: tree })).toMatchObject({
      scopeKey: `topic:${tree}`,
      subjectKey: `topic:${tree}`
    });
    expect(gardenerJobKeys("relation-explain-backfill", { relationId: root })).toMatchObject({
      scopeKey: null,
      subjectKey: `relation:${root}`
    });
    expect(gardenerJobKeys("ingestion", { sourceItemId: root })).toEqual({
      scopeKey: null,
      subjectKey: null,
      rootOf: root
    });
    for (const type of [...inlineIngestionStageTypes, "note-embedding", "obsidian-wiki"])
      expect(gardenerJobKeys(type, { sourceItemId: root, treeId: tree })).toEqual({
        scopeKey: null,
        subjectKey: null,
        rootOf: null
      });
    expect(gardenerJobKeys("unknown-kind", { rootId: root })).toMatchObject({ scopeKey: null });
  });

  it("refuses key segments that are not short ids", () => {
    expect(gardenerJobKeys("relation-link", { rootId: "a:b" })).toMatchObject({ scopeKey: null });
    expect(gardenerJobKeys("relation-link", { rootId: "x".repeat(81) })).toMatchObject({
      scopeKey: null
    });
    expect(gardenerJobKeys("relation-link", { rootId: 42 })).toMatchObject({ scopeKey: null });
  });

  it("names a relation job's root as its sourceItemId", () => {
    expect(gardenerJobPayload("relation-promote", { rootId: root })).toEqual({
      rootId: root,
      sourceItemId: root
    });
    const kept = { rootId: root, sourceItemId: tree };
    expect(gardenerJobPayload("relation-link", kept)).toBe(kept);
    const topic = { treeId: tree, rootSourceId: root };
    expect(gardenerJobPayload("topic-place", topic)).toBe(topic);
  });

  it("lists the inline ingestion stages as unscoped user work", () => {
    expect(inlineIngestionStageTypes).toEqual([
      "markdown-conversion",
      "chunking",
      "embedding",
      "summarization",
      "atomic-note-generation",
      "atomic-note-matching",
      "knowledge-graph-generation",
      "obsidian-sync",
      "asset-storage"
    ]);
    for (const type of inlineIngestionStageTypes)
      expect(gardenerTaskKinds[type]).toMatchObject({ gardener: false, worker: "inline" });
    expect(gardenerTaskKinds.ingestion).toMatchObject({ gardener: false, budgetClass: "user" });
  });
});

describe("Gardener states and blockers (D5, D7)", () => {
  it("derives the state from the status and the Gardener columns", () => {
    const base = { outcome: null, blockedClass: null, quarantinedAt: null } as const;
    expect(gardenerStateOf({ ...base, status: "queued" })).toBe("queued");
    expect(gardenerStateOf({ ...base, status: "queued", blockedClass: "cap" })).toBe("blocked");
    expect(gardenerStateOf({ ...base, status: "running" })).toBe("running");
    expect(gardenerStateOf({ ...base, status: "succeeded", outcome: "no_change" })).toBe(
      "no_change"
    );
    expect(gardenerStateOf({ ...base, status: "succeeded", outcome: "skipped" })).toBe("skipped");
    expect(gardenerStateOf({ ...base, status: "succeeded" })).toBe("legacy");
    expect(gardenerStateOf({ ...base, status: "failed" })).toBe("failed");
    expect(gardenerStateOf({ ...base, status: "failed", quarantinedAt: new Date() })).toBe(
      "quarantined"
    );
    expect(gardenerStateOf({ ...base, status: "canceled" })).toBe("canceled");
  });

  it("orders blocker classes paused > no_model > cap > download > waiting > offline", () => {
    expect(gardenerBlockerClasses).toEqual([
      "paused",
      "no_model",
      "cap",
      "download",
      "waiting",
      "offline"
    ]);
    expect(compareBlockerClasses("paused", "offline")).toBeLessThan(0);
    expect(compareBlockerClasses("waiting", "cap")).toBeGreaterThan(0);
    expect(
      mostPressingBlocker([
        { class: "waiting" as const, id: 1 },
        { class: "cap" as const, id: 2 },
        { class: "download" as const, id: 3 }
      ])
    ).toEqual({ class: "cap", id: 2 });
    expect(mostPressingBlocker([])).toBeNull();
  });

  it("accepts only the reasons of a class", () => {
    expect(GardenerBlockerSchema.safeParse({ class: "cap", reason: "money_80" }).success).toBe(
      true
    );
    expect(GardenerBlockerSchema.safeParse({ class: "cap", reason: "user_pause" }).success).toBe(
      false
    );
    const reasons = Object.values(gardenerBlockerReasons).flat();
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("clears a daily cap at the next local day and anything else after the recheck delay", () => {
    const now = new Date(2026, 9, 23, 18, 30);
    expect(blockerClearAt({ class: "cap", reason: "feature_daily" }, now)).toEqual(
      new Date(2026, 9, 24, 0, 0)
    );
    expect(nextLocalDay(new Date(2026, 11, 31, 23, 59))).toEqual(new Date(2027, 0, 1));
    expect(blockerClearAt({ class: "no_model", reason: "no_route" }, now).getTime()).toBe(
      now.getTime() + gardenerTaskConfig.blockRecheckMs
    );
  });

  it("keeps its numbers in typed configuration", () => {
    expect(gardenerTaskConfig).toEqual({
      quarantineAfterFailedJobs: 2,
      jobRetentionDays: 30,
      blockRecheckMs: 600_000,
      releaseDueBlocksEveryMs: 30_000
    });
    expect(Object.isFrozen(gardenerTaskConfig)).toBe(true);
    expect(
      GardenerTaskConfigSchema.safeParse({ ...gardenerTaskConfig, quarantineAfterFailedJobs: 0 })
        .success
    ).toBe(false);
  });
});

describe("result.status mapping (3.1b)", () => {
  it("maps done, no change, blockers and failed attempts of a Gardener kind", () => {
    expect(gardenerResultOf("topic-place", { status: "applied" })).toMatchObject({
      state: "outcome",
      outcome: "done"
    });
    for (const status of ["pending_review", "pending"])
      expect(gardenerResultOf("topic-rebalance", { status })).toMatchObject({ outcome: "done" });
    for (const status of [
      "no_change",
      "deferred",
      "space_changed",
      "skipped",
      "review_pending",
      "dismissed"
    ])
      expect(gardenerResultOf("topic-build", { status })).toMatchObject({ outcome: "no_change" });
    expect(gardenerResultOf("topic-areas", { status: "no_route" })).toEqual({
      state: "blocked",
      blocker: { class: "no_model", reason: "no_route" },
      status: "no_route",
      routeClass: "write-fast"
    });
    expect(gardenerResultOf("topic-label-embed", { status: "no_route" })).toMatchObject({
      routeClass: "embed"
    });
    expect(gardenerResultOf("topic-name", { status: "cap_reached" })).toMatchObject({
      blocker: { class: "cap", reason: "feature_daily" }
    });
    expect(gardenerResultOf("topic-gate", { status: "no_decider" })).toMatchObject({
      blocker: { class: "no_model", reason: "no_decider" }
    });
    expect(gardenerResultOf("topic-areas", { status: "call_failed" })).toEqual({
      state: "failed",
      status: "call_failed",
      retry: true
    });
    // Still invalid after the producer's repair: final, only transient errors are retried.
    for (const status of ["invalid", "invalid_output"])
      expect(gardenerResultOf("topic-areas", { status })).toEqual({
        state: "failed",
        status,
        retry: false
      });
  });

  it("names the blocker of a `blocked` resolution by its reason", () => {
    for (const reason of topicsBlockedReasons)
      expect(gardenerResultOf("topic-sweep", { status: "blocked", reason })).toMatchObject({
        state: "blocked",
        blocker: topicBlockedReasonBlockers[reason]
      });
    expect(
      gardenerResultOf("topic-sweep", { status: "blocked", reason: "no_embedding_route" })
    ).toMatchObject({ routeClass: "embed" });
    expect(gardenerResultOf("topic-sweep", { status: "blocked", reason: "other" })).toMatchObject({
      blocker: { class: "waiting", reason: "queue" }
    });
  });

  it("ends any other job, a result without status and an unknown status done", () => {
    expect(gardenerResultOf("ingestion", { status: "invalid" })).toMatchObject({ outcome: "done" });
    expect(gardenerResultOf("topic-place", {})).toMatchObject({ outcome: "done", status: null });
    expect(gardenerResultOf("topic-place", null)).toMatchObject({ outcome: "done" });
    expect(gardenerResultOf("relation-link", { discovery: { status: "deferred" } })).toMatchObject({
      outcome: "done"
    });
  });

  it("only names known blockers", () => {
    for (const mapped of Object.values(resultStatusStates))
      if (mapped.state === "blocked" && mapped.blocker !== "by_reason")
        expect(GardenerBlockerSchema.safeParse(mapped.blocker).success).toBe(true);
    for (const blocker of Object.values(topicBlockedReasonBlockers))
      expect(GardenerBlockerSchema.safeParse(blocker).success).toBe(true);
  });
});

describe("content-only fingerprints (D9)", () => {
  it("digests sorted content and is stable under key order", () => {
    const a = gardenerFingerprint("topic-name", { members: ["x", "y"], generation: 3 }, sha256);
    const b = gardenerFingerprint("topic-name", { generation: 3, members: ["x", "y"] }, sha256);
    expect(a).toBe(b);
    expect(a).toMatch(/^gf1:[0-9a-f]{64}$/u);
    expect(
      gardenerFingerprint("topic-areas", { members: ["x", "y"], generation: 3 }, sha256)
    ).not.toBe(a);
    expect(
      gardenerFingerprint("topic-name", { members: ["y", "x"], generation: 3 }, sha256)
    ).not.toBe(a);
    expect(canonicalFingerprintInput("k", { b: [1, null, true], a: "é" })).toBe(
      'gf1\nk\n{"a":"é","b":[1,null,true]}'
    );
  });

  it("refuses provenance: a model, prompt or setting never fingerprints a task", () => {
    for (const field of ["model", "promptRevision", "settings", "contentLanguage"])
      expect(() => canonicalFingerprintInput("k", { notes: [{ [field]: "x" }] })).toThrow(
        `gardener_fingerprint_provenance:$.notes[0].${field}`
      );
    expect(() => canonicalFingerprintInput("k", { n: Number.NaN })).toThrow(
      "gardener_fingerprint_number"
    );
    expect(() => canonicalFingerprintInput("", {})).toThrow("gardener_fingerprint_kind");
  });

  it("skips an equal input and a quarantined one, and never an unknown one", () => {
    const cached = { lastFingerprint: "gf1:a", failedFingerprint: "gf1:b", quarantinedAt: null };
    expect(gardenerSkipReason("gf1:a", cached)).toBe("same_input");
    expect(gardenerSkipReason("gf1:b", cached)).toBeNull();
    expect(gardenerSkipReason("gf1:b", { ...cached, quarantinedAt: new Date() })).toBe(
      "quarantined"
    );
    // A quarantined change reverted to the input of the last success: nothing to do again.
    expect(gardenerSkipReason("gf1:a", { ...cached, quarantinedAt: new Date() })).toBe(
      "same_input"
    );
    expect(gardenerSkipReason("gf1:c", { ...cached, quarantinedAt: new Date() })).toBeNull();
    expect(gardenerSkipReason(null, cached)).toBeNull();
    expect(gardenerSkipReason("gf1:a", null)).toBeNull();
  });
});

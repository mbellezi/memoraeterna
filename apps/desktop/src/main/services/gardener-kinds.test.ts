import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { gardenerTaskKinds, resultStatusStates } from "@app/domain";
import { describe, expect, it } from "vitest";

import { topicJobTypes } from "./topic-tree/topic-jobs.js";

/**
 * Static checks of the Gardener's tables (F4 T74, spec 3.1 and 3.1b): every job type string the
 * product code queues has a kind row, and every `status` literal a Gardener executor returns has a
 * row in the `result.status` table. A new job type or status fails here until its row exists.
 */
const workspace = resolve(import.meta.dirname, "../../../../..");

/** Product sources: no tests, and no `verify-*` harnesses (their fixture jobs are never queued). */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name) && !name.startsWith("verify-")
      ? [path]
      : [];
  });
}

const productFiles = [
  ...sourceFiles(join(workspace, "apps/desktop/src/main")),
  ...sourceFiles(join(workspace, "packages/db/src/repositories"))
];

/** The job type strings product code names where it queues or runs a job. */
function queuedJobTypes(): Map<string, string> {
  const found = new Map<string, string>();
  const add = (type: string, file: string) => {
    if (!found.has(type)) found.set(type, relative(workspace, file));
  };
  for (const file of productFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/JobType\s*=\s*"([a-z0-9-]+)"/gu)) add(match[1]!, file);
    for (const match of text.matchAll(/runInlineStageJob\(\s*"([a-z0-9-]+)"/gu))
      add(match[1]!, file);
    for (const match of text.matchAll(/(?:create|enqueueDeduped)\(\{\s*type:\s*"([a-z0-9-]+)"/gu))
      add(match[1]!, file);
    for (const match of text.matchAll(/insert into jobs[^;`]*?values\s*\(\s*'([a-z0-9-]+)'/giu))
      add(match[1]!, file);
    const supported = /supportedJobTypes = new Set<string>\(\[([^\]]*)\]\)/u.exec(text);
    for (const match of supported?.[1]?.matchAll(/"([a-z0-9-]+)"/gu) ?? []) add(match[1]!, file);
  }
  for (const type of Object.values(topicJobTypes)) add(type, "topic-tree/topic-jobs.ts");
  return found;
}

/** The executors of Gardener kinds, whose `result.status` the supervisor maps (3.1b). */
const producers = [
  "apps/desktop/src/main/services/topic-tree/topic-build.ts",
  "apps/desktop/src/main/services/topic-tree/topic-gate.ts",
  "apps/desktop/src/main/services/topic-tree/topic-naming.ts",
  "apps/desktop/src/main/services/topic-tree/topic-areas.ts",
  "apps/desktop/src/main/services/topic-tree/topic-labels.ts",
  "apps/desktop/src/main/services/topic-tree/topic-place.ts",
  "apps/desktop/src/main/services/topic-tree/topic-tree-service.ts",
  "apps/desktop/src/main/services/relations/relation-link.ts",
  "apps/desktop/src/main/services/relations/relation-match.ts",
  "apps/desktop/src/main/services/relations/composite-backfill.ts",
  "apps/desktop/src/main/services/catalog-header-refresh.ts"
];

/**
 * Status literals in those files that are not job results: the undo verdict `topic-tree-service.ts`
 * returns to IPC (`undoNow`). (`dismissed` is one too, but a build also returns it as a result.)
 */
const notJobResults = new Set(["undone"]);

/**
 * Statuses a producer builds from a value rather than a literal: `topic-build.ts` REBALANCE returns
 * the kind of `applyChangeSet`'s result (`pending`, `no_change`) and a build its skip decision.
 */
const computedStatuses = ["pending", "no_change"];

describe("the Gardener kind table", () => {
  it("has a row for every job type string the product code queues", () => {
    const types = queuedJobTypes();
    // The scan reaches every place that queues today's kinds.
    for (const type of [
      "ingestion",
      "summarization",
      "note-embedding",
      "relation-labels",
      "relation-link",
      "relation-promote",
      "catalog-header",
      "relation-composite",
      "obsidian-wiki",
      "local-model-download",
      "relation-rematch",
      "topic-place",
      "topic-label-embed"
    ])
      expect(types.has(type), type).toBe(true);
    const missing = [...types].filter(([type]) => !gardenerTaskKinds[type]);
    expect(missing).toEqual([]);
  });
});

describe("the result.status table (3.1b)", () => {
  it("maps every status literal a Gardener executor returns", () => {
    const literals = new Map<string, string>();
    for (const file of producers) {
      const text = readFileSync(join(workspace, file), "utf8");
      // `status: "x"`, and a build's skip decision (`{ skip: "x" }` becomes `{ status: "x" }`).
      for (const match of text.matchAll(/\b(?:status|skip):\s*"([a-z_]+)"/gu))
        if (!literals.has(match[1]!)) literals.set(match[1]!, file);
    }
    for (const status of computedStatuses)
      if (!literals.has(status)) literals.set(status, "topic-tree/topic-build.ts");
    expect(literals.size).toBeGreaterThan(20);
    expect(literals.get("dismissed")).toBeDefined();
    const unmapped = [...literals].filter(
      ([status]) => !(status in resultStatusStates) && !notJobResults.has(status)
    );
    expect(unmapped).toEqual([]);
  });

  it("maps the statuses of the supervisor's own skips, a quarantined input never done (T74 R8)", () => {
    const supervisor = readFileSync(
      join(workspace, "apps/desktop/src/main/services/job-supervisor.ts"),
      "utf8"
    );
    // The fingerprint skip's result: `status: skip === "quarantined" ? "quarantined" : "skipped"`.
    const skip = /status: skip === "([a-z_]+)" \? "([a-z_]+)" : "([a-z_]+)"/u.exec(supervisor);
    expect(skip, "the supervisor's skip result").not.toBeNull();
    for (const status of [skip![2]!, skip![3]!])
      expect(status in resultStatusStates, status).toBe(true);
    expect(resultStatusStates[skip![2]!]).toEqual({ state: "outcome", outcome: "skipped" });
  });
});

import { aiClassIds, budgetClasses } from "@app/domain";
import { describe, expect, it } from "vitest";

import {
  embedOperations,
  f3Operations,
  internalOperations,
  legacyOperations,
  rankerOperations
} from "./ai-route-mapping.js";
import {
  callSites,
  constantValues,
  operationStatements,
  productFiles,
  type CallSite
} from "./workload-class-sites.js";

/**
 * F3 D34: every caller of the AI service states its workload class and its priority, so the class
 * route chooses its model, the scheduler its lane order and the audit its class. Read from the
 * source: a call added without them fails here.
 */
const files = productFiles();
const constants = constantValues(files);
const sites = callSites(files, constants);

const priorities = ["P0", "P1", "P2", "P3"];
const place = (site: Pick<CallSite, "file" | "line">) => `${site.file}:${site.line}`;
/** What a caller states beside its input: the class, the lane priority and (F4 D14) the budget class. */
type Stated = "workloadClass" | "priority" | "budgetClass";

/**
 * Calls that cannot state what they do not know, each with the reason. `missing` names what the
 * site leaves to someone else; a wrapper's own callers state both.
 */
const exceptions: Array<{
  file: string;
  enclosing: string;
  method: CallSite["method"];
  missing: Array<Stated>;
  reason: string;
}> = [
  {
    file: "apps/desktop/src/main/services/knowledge-service.ts",
    enclosing: "tryRunDefaultTask",
    method: "runDefaultTask",
    missing: ["workloadClass", "priority", "budgetClass"],
    reason: "a pass-through wrapper: its callers state the context (embedAtomicNoteVector)"
  },
  {
    file: "apps/desktop/src/main/services/prompt-samples.ts",
    enclosing: "call",
    method: "runDefaultTask",
    missing: ["workloadClass"],
    reason:
      "a diagnostic run of the legacy task route of the sample's task: it states no class, so the class route never replaces the model the sample is meant to try"
  },
  {
    file: "apps/desktop/src/main/services/lane-probe.ts",
    enclosing: "call",
    method: "runDefaultTask",
    missing: ["workloadClass"],
    reason:
      "the DEV lane probe measures the backend of the reranking task route: class decide would send its prompt to the ranker of class:decide, and no op: route is seeded for it"
  },
  {
    file: "apps/desktop/src/main/services/schema-probe.ts",
    enclosing: "runSchemaProbe",
    method: "runDefaultTask",
    missing: ["workloadClass"],
    reason:
      "the DEV strict-schema probe (T55) tries the backend of the structured-output task route: a stated class would move it to that class route's model"
  },
  {
    file: "apps/desktop/src/main/services/golden-note-pairs.ts",
    enclosing: "judgeCall",
    method: "runDefaultTask",
    missing: ["workloadClass", "priority", "budgetClass"],
    reason:
      "the DEV note-pair knob sends the context noteCallRequest builds, which states the generative decider's class, priority and budget class; golden-note-pairs.test.ts compares it with the matcher's request"
  }
];

function missingOf(site: CallSite): Array<Stated> {
  const stated = site.context;
  const missing: Array<Stated> = [];
  // `rank` and `rankPairs` always run the `decide` class on the local ranker: only their priority
  // is stated, since the RemoteBudget never meters the local lane.
  const ranker = site.method === "rank" || site.method === "rankPairs";
  if (!ranker && !stated?.properties.has("workloadClass")) missing.push("workloadClass");
  if (!stated?.properties.has("priority")) missing.push("priority");
  if (!ranker && !stated?.properties.has("budgetClass")) missing.push("budgetClass");
  return missing;
}

describe("the readers find the calls", () => {
  it("reads the AI calls of the product code", () => {
    const methods = new Set(sites.map((site) => site.method));
    expect(methods).toEqual(
      new Set([
        "runDefaultTask",
        "tryRunDefaultTask",
        "runOrganizationTask",
        "rank",
        "rankPairs",
        "embedMany"
      ])
    );
    expect(sites.length).toBeGreaterThanOrEqual(25);
    // Calls that must be found, whatever else changes.
    for (const needle of [
      "knowledge-service.ts",
      "relation-explanation-service.ts",
      "consultation-service.ts",
      "topic-tree/topic-gate.ts",
      "topic-tree/topic-naming.ts",
      "topic-tree/topic-labels.ts",
      "job-embedding.ts"
    ])
      expect(
        sites.some((site) => site.file.endsWith(needle)),
        needle
      ).toBe(true);
  });
});

describe("every caller states its workload class, priority (D34) and budget class (F4 D14)", () => {
  it("leaves nothing unstated beyond the documented exceptions", () => {
    const problems: string[] = [];
    for (const site of sites) {
      const missing = missingOf(site);
      if (missing.length === 0) continue;
      const allowed = exceptions.find(
        (entry) =>
          entry.file === site.file &&
          entry.enclosing === site.enclosing &&
          entry.method === site.method
      );
      const unexplained = missing.filter((name) => !allowed?.missing.includes(name));
      if (unexplained.length > 0)
        problems.push(`${place(site)} ${site.method} does not state ${unexplained.join(", ")}`);
    }
    expect(problems).toEqual([]);
  });

  it("has no exception that no call needs", () => {
    for (const entry of exceptions) {
      const used = sites.some(
        (site) =>
          site.file === entry.file &&
          site.enclosing === entry.enclosing &&
          site.method === entry.method &&
          missingOf(site).length > 0
      );
      expect(used, `${entry.file} ${entry.enclosing}`).toBe(true);
    }
  });

  it("states a known class and one of the four lane priorities", () => {
    const problems: string[] = [];
    for (const site of sites) {
      for (const value of site.context?.values.get("workloadClass") ?? [])
        if (!aiClassIds.includes(value as (typeof aiClassIds)[number]))
          problems.push(`${place(site)} states the class ${value}`);
      for (const value of site.context?.values.get("priority") ?? [])
        if (!priorities.includes(value))
          problems.push(`${place(site)} states the priority ${value}, not P0 to P3`);
    }
    expect(problems).toEqual([]);
  });

  it("states a known budget class, background for maintenance and never for P0 (F4 D14)", () => {
    const problems: string[] = [];
    for (const site of sites) {
      const stated = site.context?.values.get("budgetClass") ?? [];
      for (const value of stated)
        if (!budgetClasses.includes(value as (typeof budgetClasses)[number]))
          problems.push(`${place(site)} states the budget class ${value}`);
      const priority = site.context?.values.get("priority") ?? [];
      // Maintenance (P3) is Gardener work, metered and refused at the caps.
      if (priority.length > 0 && priority.every((value) => value === "P3"))
        for (const value of stated)
          if (value !== "background") problems.push(`${place(site)} runs P3 as ${value}`);
      // P0 is never refused: a P0 call is the person's, never background.
      if (priority.length > 0 && priority.every((value) => value === "P0"))
        if (stated.includes("background")) problems.push(`${place(site)} runs P0 as background`);
    }
    expect(problems).toEqual([]);
  });

  it("states the class of the legacy operation it runs", () => {
    const table = new Map(legacyOperations.map((entry) => [entry.operation, entry]));
    const problems: string[] = [];
    for (const site of sites) {
      const statedClass = site.context?.values.get("workloadClass");
      const operations = site.context?.values.get("operation");
      if (!statedClass || !operations) continue;
      for (const operation of operations) {
        const entry = table.get(operation);
        if (entry && !statedClass.includes(entry.class))
          problems.push(
            `${place(site)} runs ${operation} as ${statedClass.join("/")}, the mapping expects ${entry.class}`
          );
        if (entry && site.task && site.task !== entry.task)
          problems.push(
            `${place(site)} runs ${operation} on ${site.task}, the mapping expects ${entry.task}`
          );
      }
    }
    expect(problems).toEqual([]);
  });

  it("gives the embedding calls the embed class and nothing else", () => {
    const problems = sites
      .filter((site) => site.task === "embedding")
      .filter(
        (site) => site.context && !site.context.values.get("workloadClass")?.includes("embed")
      )
      .filter((site) => !site.context?.unresolved || site.context.properties.has("workloadClass"))
      .map(place);
    expect(problems).toEqual([]);
  });
});

describe("every operation of the product code is known to the route mapping", () => {
  const known = new Set<string>([
    ...legacyOperations.map((entry) => entry.operation),
    ...embedOperations,
    ...rankerOperations,
    ...f3Operations,
    ...internalOperations
  ]);

  it("names each stated operation in the mapping's tables", () => {
    const problems: string[] = [];
    for (const statement of operationStatements(files, constants)) {
      for (const value of statement.values ?? []) {
        // A template such as `graph_${kind}` stands for every operation that fits it.
        const pattern = new RegExp(
          `^${value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replaceAll("\\*", ".+")}$`,
          "u"
        );
        if (![...known].some((name) => pattern.test(name)))
          problems.push(
            `${statement.file}:${statement.line} states the operation ${value}: add it to ai-route-mapping.ts`
          );
      }
    }
    expect(problems).toEqual([]);
  });
});

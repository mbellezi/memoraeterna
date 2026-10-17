import { operationRouteKey } from "@app/db";
import { aiPresetIds, generativeDecideOperations, planAiPreset } from "@app/domain";
import { describe, expect, it } from "vitest";

import { routeKeysOf } from "./ai-class-routes.js";
import {
  applyRouteMappingPlan,
  f3Operations,
  legacyOperations,
  planLegacyRouteMapping,
  unroutedGenerativeDecide,
  type RouteMappingFacts
} from "./ai-route-mapping.js";
import { callSites, constantValues, productFiles } from "./workload-class-sites.js";

/**
 * D16, R5: the generative decider, its repair, the source judge and the escalation state class
 * `decide` and must always find their `op:` route onto a generative writer; with no route they
 * would resolve `class:decide`, which holds validated rankers only. Every preset and the legacy
 * mapping write all four routes, and a generative-decide call that no table lists fails here.
 */
const files = productFiles();
const constants = constantValues(files);
const sites = callSites(files, constants);
const place = (site: { file: string; line: number }) => `${site.file}:${site.line}`;

describe("the generative-decide operations are routed (D16, R5)", () => {
  it("names the four operations the judge row and the presets write", () => {
    expect(routeKeysOf("judge")).toEqual(
      generativeDecideOperations.map((operation) => operationRouteKey(operation))
    );
    expect(unroutedGenerativeDecide(routeKeysOf("judge"))).toEqual([]);
  });

  it("knows each operation to the mapping tables", () => {
    const known = new Set([
      ...legacyOperations.filter((entry) => entry.class === "decide").map((e) => e.operation),
      ...f3Operations
    ]);
    for (const operation of generativeDecideOperations) expect(known.has(operation)).toBe(true);
  });

  it("finds a generative-decide operation that has no route", () => {
    const keys = routeKeysOf("judge").filter((key) => key !== "op:source_relation_matching");
    expect(unroutedGenerativeDecide(keys)).toEqual(["source_relation_matching"]);
    expect(unroutedGenerativeDecide([])).toEqual([...generativeDecideOperations]);
  });

  it("is written by every preset that has a generative writer to route", () => {
    for (const preset of aiPresetIds) {
      const planned = planAiPreset(preset, {
        platform: "darwin",
        arch: "arm64",
        totalMemoryBytes: 32 * 1024 ** 3
      });
      expect(planned.ok).toBe(true);
      if (!planned.ok) continue;
      // The preset's judge target is the same writer as its write classes, so one profile serves
      // the four routes and `AiClassRouteService.writePreset` points all of `routeKeysOf("judge")`.
      expect(planned.plan.generativeDecide).toEqual(planned.plan.classes["write-fast"]);
    }
  });

  it("is written by the legacy mapping whenever the reranking route holds a writer", () => {
    const facts: RouteMappingFacts = {
      profiles: [
        {
          id: "W",
          status: "active",
          isDefault: true,
          modelId: "writer",
          capabilities: ["text-generation", "structured-output"],
          providerConfigId: "provider",
          localModelId: null
        }
      ],
      routes: [{ task: "reranking", profileId: "W" }],
      profileTasks: [{ profileId: "W", task: "reranking", parameters: {} }]
    };
    const after = applyRouteMappingPlan(facts, planLegacyRouteMapping(facts));
    expect(unroutedGenerativeDecide(after.routes.map((route) => route.task))).toEqual([]);
    expect(unroutedGenerativeDecide(facts.routes.map((route) => route.task))).toEqual([
      ...generativeDecideOperations
    ]);
  });

  it("is the only operation family the product runs on the decide class with a prompt", () => {
    const problems: string[] = [];
    for (const site of sites) {
      const classes = site.context?.values.get("workloadClass") ?? [];
      if (site.method === "rank" || site.method === "rankPairs") continue;
      if (!classes.includes("decide")) {
        // A generative reranking prompt that states no decide class would reach the task route
        // as before F3: allowed only for the diagnostic run of a prompt sample.
        if (site.task === "reranking" && site.context?.properties.has("workloadClass"))
          problems.push(`${place(site)} runs reranking as ${classes.join("/")}`);
        continue;
      }
      if (site.task !== "reranking")
        problems.push(`${place(site)} states class decide for the task ${site.task}`);
      const operations = site.context?.values.get("operation");
      if (!operations) {
        problems.push(`${place(site)} states class decide without a known operation`);
        continue;
      }
      for (const operation of operations)
        if (!(generativeDecideOperations as readonly string[]).includes(operation))
          problems.push(
            `${place(site)} runs ${operation} on class decide: it has no seeded op: route`
          );
    }
    expect(problems).toEqual([]);
  });

  it("reads at least the note decider and the source judge", () => {
    const decide = sites.filter((site) =>
      site.context?.values.get("workloadClass")?.includes("decide")
    );
    const operations = decide.flatMap((site) => site.context?.values.get("operation") ?? []);
    expect(operations).toEqual(
      expect.arrayContaining([
        "note_matching_reranking",
        "note_matching_reranking_repair",
        "source_relation_matching"
      ])
    );
  });
});

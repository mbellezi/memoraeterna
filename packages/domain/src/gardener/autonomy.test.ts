import { describe, expect, it } from "vitest";

import {
  autonomyEffect,
  autonomyHoldsKind,
  autonomyMatrix,
  autonomyRefusesCall,
  autonomyRunsProvisionally,
  changeDisposition,
  gardenerKindPolicies,
  gardenerKindPolicy,
  gardenerWorks,
  type AutonomyEffect,
  type GardenerWork
} from "./autonomy.js";
import { gardenerAutonomyLevels, type GardenerAutonomy } from "./controls.js";

// Table 3.2 of the F4 spec, one row per work and one column per level.
const table: Record<GardenerWork, [AutonomyEffect, AutonomyEffect, AutonomyEffect]> = {
  place: ["runs", "runs", "runs"],
  gate: ["runs", "runs", "runs"],
  structure: ["runs", "runs", "runs"],
  lint: ["runs", "runs", "runs"],
  decide: ["runs", "runs", "runs"],
  rebalance_soft: ["proposes", "proposes", "applies"],
  naming: ["provisional", "proposes", "applies"],
  areas: ["none", "proposes", "applies"],
  refresh: ["none", "proposes", "applies"],
  backfill: ["none", "runs", "runs"],
  typing: ["waits", "runs", "runs"],
  derived: ["runs", "runs", "runs"],
  housekeeping: ["runs", "runs", "runs"]
};

describe("autonomy matrix (spec 3.2)", () => {
  it("matches the table for every work and level", () => {
    expect(Object.keys(autonomyMatrix).sort()).toEqual([...gardenerWorks].sort());
    for (const work of gardenerWorks)
      gardenerAutonomyLevels.forEach((level, index) =>
        expect(autonomyEffect(work, level), `${work} ${level}`).toBe(table[work][index])
      );
  });

  it("holds exactly the generative background kinds under Off, and nothing under Suggest or Auto", () => {
    const heldUnderOff = Object.keys(gardenerKindPolicies)
      .filter((type) => autonomyHoldsKind(type, "off"))
      .sort();
    expect(heldUnderOff).toEqual([
      "catalog-header",
      "relation-explain-backfill",
      "relation-retype",
      "topic-areas",
      "topic-overview"
    ]);
    for (const type of heldUnderOff) expect(gardenerKindPolicy(type)?.ai).toBe("generative");
    for (const level of ["suggest", "auto"] as const)
      for (const type of Object.keys(gardenerKindPolicies))
        expect(autonomyHoldsKind(type, level), `${type} ${level}`).toBe(false);
  });

  it("still places, gates, lints and decides locally under Off", () => {
    for (const type of [
      "topic-place",
      "topic-sweep",
      "topic-gate",
      "topic-rebalance",
      "topic-build",
      "topic-audit",
      "topic-label-embed",
      "relation-match",
      "relation-composite",
      "gardener-retention"
    ])
      expect(autonomyHoldsKind(type, "off"), type).toBe(false);
  });

  it("names provisionally under Off: naming runs, its model calls are refused (table 3.2)", () => {
    expect(autonomyHoldsKind("topic-name", "off")).toBe(false);
    expect(autonomyRunsProvisionally("topic-name")).toBe(true);
    expect(
      Object.keys(gardenerKindPolicies).filter((type) => autonomyRunsProvisionally(type))
    ).toEqual(["topic-name"]);
    expect(autonomyRunsProvisionally("ingestion")).toBe(false);
    expect(autonomyRefusesCall("off", { generative: true, remote: false })).toBe(true);
    expect(changeDisposition({ work: "naming", autonomy: "off", risk: "low" })).toBe("applied");
  });

  it("never holds a mixed kind at claim: an import's own link job is the user's", () => {
    expect(gardenerKindPolicy("relation-link")?.budget).toBe("mixed");
    expect(gardenerKindPolicy("relation-promote")?.budget).toBe("mixed");
    expect(autonomyHoldsKind("relation-link", "off")).toBe(false);
  });

  it("knows no policy for work that is not the Gardener's", () => {
    for (const type of [
      "ingestion",
      "embedding",
      "note-embedding",
      "obsidian-wiki",
      "relation-labels"
    ])
      expect(gardenerKindPolicy(type), type).toBeNull();
    expect(autonomyHoldsKind("ingestion", "off")).toBe(false);
    expect(gardenerKindPolicy("toString")).toBeNull();
  });

  it("refuses generative and remote background calls under Off only", () => {
    const calls = [
      { generative: false, remote: false },
      { generative: true, remote: false },
      { generative: false, remote: true },
      { generative: true, remote: true }
    ];
    expect(calls.map((call) => autonomyRefusesCall("off", call))).toEqual([
      false,
      true,
      true,
      true
    ]);
    for (const level of ["suggest", "auto"] as GardenerAutonomy[])
      for (const call of calls) expect(autonomyRefusesCall(level, call)).toBe(false);
  });

  it("reviews high risk in every mode and proposes what Suggest would apply", () => {
    for (const autonomy of gardenerAutonomyLevels)
      for (const work of gardenerWorks)
        expect(changeDisposition({ work, autonomy, risk: "high" })).toBe("pending_review");
    expect(changeDisposition({ work: "naming", autonomy: "auto", risk: "low" })).toBe("applied");
    expect(changeDisposition({ work: "naming", autonomy: "suggest", risk: "low" })).toBe(
      "pending_review"
    );
    expect(changeDisposition({ work: "rebalance_soft", autonomy: "off", risk: "medium" })).toBe(
      "pending_review"
    );
    expect(changeDisposition({ work: "place", autonomy: "off", risk: "low" })).toBe("applied");
    expect(changeDisposition({ work: "refresh", autonomy: "suggest", risk: "medium" })).toBe(
      "pending_review"
    );
  });
});

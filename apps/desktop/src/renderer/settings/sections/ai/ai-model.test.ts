import { describe, expect, it } from "vitest";
import { classifyHardware } from "@app/domain";
import { createTranslator } from "@app/i18n";

import { settingsRegistryV2 } from "../../../../shared/settings-registry";
import {
  decisionsFixture,
  hardwareFixture,
  ids,
  localModelsFixture,
  profilesFixture,
  providersFixture,
  routesEmptyFixture,
  routesFixture,
  tierIds
} from "./ai-fixtures";
import {
  decisionsLine,
  detectedLabel,
  errorKeyOf,
  etaText,
  filterModels,
  formatSize,
  formatUsd,
  macFacts,
  modelsSummary,
  profileOffered,
  profilesSummary,
  providerOfEntryId,
  providerView,
  purposeCapabilities,
  purposeOf,
  rankerNoteKey,
  routeEntryId,
  routeOfEntryId,
  routeOrder,
  routeView,
  routesAreEmpty,
  setupCards,
  setupNeedsWriterWarning,
  sortModels,
  testLine
} from "./ai-model";

const en = createTranslator("en");
const ptBR = createTranslator("pt-BR");

const profile = (id: string) => profilesFixture.find((candidate) => candidate.id === id)!;

describe("which profiles a job may be given", () => {
  it("offers search only to an embedder, comparison only to a local ranker, writing to a writer", () => {
    const embedder = profile(ids.profileEmbed);
    const ranker = profile(ids.profileRank);
    const writer = profile(ids.profileCodex);
    expect(routeOrder.filter((route) => profileOffered(embedder, route))).toEqual(["embed"]);
    expect(routeOrder.filter((route) => profileOffered(ranker, route))).toEqual(["decide"]);
    expect(routeOrder.filter((route) => profileOffered(writer, route))).toEqual([
      "write-fast",
      "write-quality",
      "answer",
      "judge"
    ]);
  });

  it("offers nothing from a profile that is not active or has no model", () => {
    expect(profileOffered({ ...profile(ids.profileCodex), status: "disabled" }, "answer")).toBe(
      false
    );
    expect(profileOffered({ ...profile(ids.profileCodex), modelId: null }, "answer")).toBe(false);
  });

  it("gives each route its profile, its options and its test", () => {
    const view = routeView(routesFixture, profilesFixture, "write-quality");
    expect(view.profileId).toBe(ids.profileCompat);
    expect(view.remote).toBe(true);
    expect(view.options.map((option) => option.id)).toEqual([ids.profileCodex, ids.profileCompat]);
    expect(view.test.state).toBe("passed");
    expect(routeView(routesFixture, profilesFixture, "judge").test.state).toBe("untested");
  });

  it("names the row of a route and finds the route of a row", () => {
    for (const route of routeOrder) expect(routeOfEntryId(routeEntryId(route))).toBe(route);
    expect(routeOfEntryId("ai.route.nothing")).toBeNull();
    expect(routeOfEntryId("ai.preset.v1")).toBeNull();
    for (const route of routeOrder)
      expect(settingsRegistryV2.some((entry) => entry.id === routeEntryId(route))).toBe(true);
  });

  it("says the routes are empty only before any setup and any model", () => {
    expect(routesAreEmpty(routesEmptyFixture)).toBe(true);
    expect(routesAreEmpty(routesFixture)).toBe(false);
    expect(routesAreEmpty({ ...routesEmptyFixture, preset: "custom" })).toBe(false);
  });
});

describe("how a test reads", () => {
  const test = (over: object) =>
    ({ state: "passed", model: "m", ms: 38, at: null, error: null, ...over }) as never;
  it("gives milliseconds under a second and seconds above, in the language", () => {
    expect(testLine(en, test({}), "embed")).toEqual({ kind: "ok", text: "Test passed in 38 ms" });
    expect(testLine(ptBR, test({ ms: 1400 }), "embed").text).toBe("Teste aprovado em 1,4 s");
    expect(testLine(en, test({ ms: null }), "embed").text).toBe("Test passed");
  });
  it("tells a failure with its reason and an untested route plainly", () => {
    expect(testLine(en, test({ state: "failed", error: "timeout" }), "answer")).toEqual({
      kind: "failed",
      text: "Test failed: timeout"
    });
    expect(testLine(en, test({ state: "failed", error: null }), "answer").text).toBe("Test failed");
    expect(testLine(en, test({ state: "untested" }), "answer")).toEqual({
      kind: "idle",
      text: "Not tested"
    });
    expect(testLine(en, test({ state: "none" }), "decide").text).toBe("No ranker");
  });
  it("takes the localized message of a stored error key", () => {
    const failed = testLine(
      en,
      test({ state: "failed", error: "errors.ai.noCompatibleModel" }),
      "embed"
    );
    expect(failed.text).toContain("No compatible model is configured.");
    expect(errorKeyOf(new Error("x errors.ai.connectionFailed y"))).toBe(
      "errors.ai.connectionFailed"
    );
    expect(errorKeyOf(new Error("plain"))).toBe("settingsAi.errors.write");
  });
});

describe("the four setup cards", () => {
  it("lists Local, Hybrid, Cloud and Custom, marks the current one and the recommended one", () => {
    const cards = setupCards(routesFixture, hardwareFixture("apple-32"));
    expect(cards.map((card) => card.id)).toEqual(["local", "hybrid", "cloud", "custom"]);
    expect(cards.filter((card) => card.current).map((card) => card.id)).toEqual(["hybrid"]);
    expect(cards.filter((card) => card.recommended).map((card) => card.id)).toEqual(["hybrid"]);
  });

  it("says Local has no validated writer yet, and shows an estimate for the cloud setups only", () => {
    const cards = setupCards(routesFixture, hardwareFixture("apple-32"));
    expect(cards[0]).toMatchObject({
      available: true,
      note: "settingsAi.preset.local.unverified",
      estimateUsd: null
    });
    expect(cards[1]?.estimateUsd).toBeGreaterThan(0);
    expect(cards[3]?.estimateUsd).toBeNull();
  });

  it("refuses Local with the reason this machine gives, and never refuses the others", () => {
    const small = setupCards(routesFixture, hardwareFixture("apple-8"));
    expect(small[0]).toMatchObject({
      available: false,
      note: "settingsAi.preset.local.unavailableMemory"
    });
    const intel = setupCards(routesFixture, hardwareFixture("mac-intel"));
    expect(intel[0]).toMatchObject({
      available: false,
      note: "settingsAi.preset.local.unavailableSilicon"
    });
    const windows = setupCards(routesFixture, hardwareFixture("windows-large"));
    expect(windows[0]).toMatchObject({
      available: false,
      note: "settingsAi.preset.local.unavailableSystem"
    });
    for (const cards of [small, intel, windows]) {
      expect(cards.slice(1).every((card) => card.available)).toBe(true);
    }
  });

  it("follows the routes when This Mac has not been read, and the main process's word on Local", () => {
    const blind = setupCards(routesFixture, null);
    expect(blind.every((card) => !card.recommended && card.estimateUsd === null)).toBe(true);
    const refused = setupCards(
      {
        ...routesFixture,
        presets: [
          { id: "local", available: false, reason: "local_requires_apple_silicon" },
          ...routesFixture.presets.slice(1)
        ]
      },
      null
    );
    expect(refused[0]).toMatchObject({ available: false });
  });

  it("warns about a Local writer that is not validated yet, only for Local", () => {
    const mac = hardwareFixture("apple-32");
    expect(setupNeedsWriterWarning("local", mac)).toBe(true);
    expect(setupNeedsWriterWarning("hybrid", mac)).toBe(false);
    expect(setupNeedsWriterWarning("local", null)).toBe(false);
  });
});

describe("This Mac", () => {
  it("fixes each tier of the tier table to the machine that fixture describes", () => {
    for (const tier of tierIds)
      expect(classifyHardware(hardwareFixture(tier).profile), tier).toBe(tier);
  });

  it.each(tierIds)(
    "lists the figures of %s: the memory, the disk and when it was detected",
    (tier) => {
      const result = hardwareFixture(tier);
      const facts = macFacts(en, result);
      expect(facts.chip).toBe(result.profile.cpu.brand);
      const labels = facts.facts.map((fact) => fact.label);
      expect(labels[0]).toMatch(/fact\.memory/u);
      expect(labels).toContain("settingsAi.thisMac.fact.disk");
      expect(labels.at(-1)).toBe("settingsAi.thisMac.fact.detected");
      expect(facts.kind).toBe(
        tier.startsWith("apple")
          ? "silicon"
          : tier === "mac-intel"
            ? "intel"
            : tier.startsWith("windows")
              ? "windows"
              : "other"
      );
      // Apple unified memory and a discrete GPU's memory are told apart; nobody else gets a GPU figure.
      expect(labels.includes("settingsAi.thisMac.fact.gpuMemory")).toBe(tier.startsWith("apple"));
      expect(labels.includes("settingsAi.thisMac.fact.graphicsMemory")).toBe(
        tier === "windows-standard" || tier === "windows-large"
      );
    }
  );

  it("writes sizes and the detection time in the language", () => {
    expect(formatSize("en", 32 * 1024 ** 3)).toBe("32 GB");
    expect(formatSize("pt-BR", 1.2 * 1024 ** 3)).toBe("1,2 GB");
    expect(formatSize("en", 512 * 1024 ** 2)).toBe("512 MB");
    const now = new Date("2026-11-12T20:00:00");
    expect(detectedLabel(en, "2026-11-12T08:40:00", now)).toMatch(/^today, /u);
    expect(detectedLabel(ptBR, "2026-11-12T08:40:00", now)).toMatch(/^hoje, /u);
    expect(detectedLabel(en, "2026-11-10T08:40:00", now)).not.toMatch(/today/u);
    expect(detectedLabel(en, "not a date", now)).toBe("");
  });

  it("writes dollars as the language does, keeping the digits of a price", () => {
    expect(formatUsd("pt-BR", 12)).toContain("12");
    expect(formatUsd("en", 0.15)).toBe("$0.15");
    expect(formatUsd("en", 0.075)).toBe("$0.075");
    expect(formatUsd("en", 12)).toBe("$12");
  });
});

describe("providers", () => {
  it("knows a connected sign-in, a saved key and a provider with nothing", () => {
    expect(providerView("openai-codex", providersFixture).state).toBe("connected");
    expect(providerView("openai-compatible", providersFixture).state).toBe("keySaved");
    expect(providerView("google", providersFixture).state).toBe("none");
    expect(providerView("openai-codex", []).state).toBe("notConnected");
    expect(providerOfEntryId("ai.provider.google")).toBe("google");
    expect(providerOfEntryId("ai.provider.other")).toBeNull();
  });

  it("gives a model its capabilities by purpose, without an API key for a ChatGPT sign-in", () => {
    expect(purposeCapabilities("generation", "google")).toContain("requires-api-key");
    expect(purposeCapabilities("generation", "openai-codex")).not.toContain("requires-api-key");
    expect(purposeCapabilities("embedding", "google")).toEqual([
      "embedding",
      "requires-network",
      "requires-api-key"
    ]);
    expect(purposeOf(["embedding", "requires-network"])).toBe("embedding");
    expect(purposeOf(["reranking"])).toBe("reranking");
    expect(purposeOf(["text-generation", "reranking"])).toBe("generation");
  });
});

describe("local models", () => {
  it("summarizes what is installed and sorts installed first, then installing", () => {
    expect(modelsSummary(en, localModelsFixture)).toBe("2 installed · 1.7 GB");
    expect(modelsSummary(ptBR, localModelsFixture)).toBe("2 instalados · 1,7 GB");
    expect(modelsSummary(en, [])).toBe("None installed");
    expect(modelsSummary(en, localModelsFixture.slice(0, 1))).toMatch(/^1 installed/u);
    expect(sortModels(localModelsFixture).map((model) => model.status)).toEqual([
      "ready",
      "ready",
      "downloading",
      "not_downloaded"
    ]);
  });

  it("filters by what a model is for and by what fits this Mac", () => {
    const names = (models: typeof localModelsFixture) => models.map((model) => model.displayName);
    expect(names(filterModels(localModelsFixture, "embedding", false))).toEqual([
      "Qwen3-Embedding-0.6B"
    ]);
    expect(names(filterModels(localModelsFixture, "ranking", false))).toEqual([
      "Qwen3-Reranker-0.6B"
    ]);
    expect(filterModels(localModelsFixture, "generation", false)).toHaveLength(2);
    const unfit = localModelsFixture.map((model) =>
      model.status === "not_downloaded" ? { ...model, compatible: false } : model
    );
    expect(filterModels(unfit, "all", true)).toHaveLength(3);
  });

  it("says what a ranker still needs and how long a download has", () => {
    expect(rankerNoteKey({ capabilities: ["reranking"], status: "ready" })).toBeNull();
    expect(rankerNoteKey({ capabilities: [], status: "ready" })).toBe(
      "settingsAi.models.ranker.pending"
    );
    expect(rankerNoteKey({ capabilities: [], status: "failed" })).toBe(
      "settingsAi.models.ranker.fallback"
    );
    expect(etaText(en, 162)).toBe("3 min left");
    expect(etaText(en, 40)).toBe("40 s left");
    expect(etaText(en, null)).toBeNull();
    expect(profilesSummary(en, 0)).toBe("No profiles");
    expect(profilesSummary(en, 1)).toBe("1 profile");
    expect(profilesSummary(en, 4)).toBe("4 profiles");
  });
});

describe("OpenAI Decisions", () => {
  it("says off, on, the reason the local ranker stepped in, and that the setup does not allow it", () => {
    expect(decisionsLine(en, decisionsFixture).tone).toBe("idle");
    expect(
      decisionsLine(en, { ...decisionsFixture, state: "unavailable_preset", presetAllowed: false })
        .tone
    ).toBe("blocked");
    const ready = { ...decisionsFixture, state: "ready", enabled: true } as const;
    expect(decisionsLine(en, ready)).toEqual({
      tone: "ok",
      text: "On: OpenAI Decisions decides the relations."
    });
    expect(
      decisionsLine(en, { ...ready, state: "fallback", fallbackReason: "no_key" }).text
    ).toContain("no OpenAI key is saved");
    expect(decisionsLine(en, { ...ready, fallbackReason: "network" }).tone).toBe("warn");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  catalogHeaderConfig,
  catalogHeaderPolicy,
  catalogHeaderRefreshEnabled,
  holdCatalogHeaderRefresh,
  readCatalogHeaderFacts
} from "./catalog-header-policy.js";
import { setExtractionPin } from "./extraction-pin.js";

// A measurement run pins its extraction and replays a recording that holds none of the refresh's
// calls: the refresh is off in it, whatever the product does (plan decisions 26 and 27, T53h).

afterEach(() => {
  holdCatalogHeaderRefresh(null);
  setExtractionPin(false);
});

describe("when the catalog-header refresh may run", () => {
  it("is on for the product: no knob set, no runner holding it", () => {
    expect(catalogHeaderPolicy({})).toEqual({ refresh: "on", reason: null });
    expect(catalogHeaderRefreshEnabled({})).toBe(true);
    // Settings and cassettes that are not measurement knobs change nothing.
    expect(catalogHeaderPolicy({ MEMORA_AI_CASSETTE: "record", MEMORA_GOLDEN_PIN: "off" })).toEqual(
      {
        refresh: "on",
        reason: null
      }
    );
  });

  it.each([
    [{ MEMORA_CATALOG_HEADERS: "off" }, "switch"],
    [{ MEMORA_CATALOG_HEADERS: " OFF " }, "switch"],
    [{ MEMORA_RELATIONS_REMATCH: "arrival:20261031" }, "relations_rematch"],
    [{ MEMORA_GOLDEN_RUN: "docs/golden/manifest.json" }, "golden_run"],
    [{ MEMORA_GOLDEN_SOURCE_PAIRS: "pairs.json" }, "golden_run"],
    [{ MEMORA_GOLDEN_NOTE_PAIRS: "pairs.json" }, "golden_run"],
    [{ MEMORA_GOLDEN_SCHEMA_PROBE: "10" }, "golden_run"],
    [{ MEMORA_GOLDEN_PIN: "extraction" }, "extraction_pin"],
    [{ MEMORA_AI_CASSETTE: "replay" }, "cassette_replay"],
    [{ MEMORA_AI_CASSETTE: " Replay " }, "cassette_replay"]
  ] as const)("is off under %j (%s)", (env, reason) => {
    expect(catalogHeaderPolicy(env)).toEqual({ refresh: "off", reason });
    expect(catalogHeaderRefreshEnabled(env)).toBe(false);
  });

  it("ignores a knob that is set to nothing", () => {
    expect(catalogHeaderPolicy({ MEMORA_RELATIONS_REMATCH: " ", MEMORA_GOLDEN_RUN: "" })).toEqual({
      refresh: "on",
      reason: null
    });
  });

  it("lets a live proof force it on over a measurement knob", () => {
    expect(
      catalogHeaderPolicy({ MEMORA_CATALOG_HEADERS: "on", MEMORA_RELATIONS_REMATCH: "burst" })
    ).toEqual({ refresh: "on", reason: null });
    expect(
      catalogHeaderPolicy({ MEMORA_CATALOG_HEADERS: "off", MEMORA_AI_CASSETTE: "record" })
    ).toEqual({
      refresh: "off",
      reason: "switch"
    });
  });

  it("is off while a runner of this process holds it, and on again once it lets go", () => {
    holdCatalogHeaderRefresh("topics_e2e");
    expect(catalogHeaderPolicy({})).toEqual({ refresh: "off", reason: "topics_e2e" });
    holdCatalogHeaderRefresh(null);
    expect(catalogHeaderPolicy({})).toEqual({ refresh: "on", reason: null });
  });

  it("is off while the extraction is pinned in this process (the golden and E6 runners pin it)", () => {
    setExtractionPin(true);
    expect(catalogHeaderPolicy({})).toEqual({ refresh: "off", reason: "extraction_pin" });
    setExtractionPin(false);
    expect(catalogHeaderRefreshEnabled({})).toBe(true);
  });
});

describe("the refresh's daily cap", () => {
  it("is a small typed number of roots per day with a counter of its own", () => {
    expect(catalogHeaderConfig.dailyRemoteRoots).toBe(50);
    expect(catalogHeaderConfig.dailyRootsSettingKey).toBe("catalogHeader.dailyRoots");
    expect(catalogHeaderConfig.dailyRootsSettingKey).not.toBe("relations.ai.dailyCalls");
  });
});

describe("what a measurement run records", () => {
  it("is the policy it ran under and the refresh jobs the app run queued", async () => {
    const query = vi.fn(async () => ({ rows: [{ jobs: 0 }] }));
    const since = new Date("2026-10-18T10:00:00.000Z");
    await expect(
      readCatalogHeaderFacts({ query } as never, {
        env: { MEMORA_RELATIONS_REMATCH: "burst" },
        since
      })
    ).resolves.toEqual({ refresh: "off", reason: "relations_rematch", jobs: 0 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("type = 'catalog-header'"), [since]);
    query.mockResolvedValue({ rows: [{ jobs: 2 }] });
    await expect(readCatalogHeaderFacts({ query } as never, { env: {}, since })).resolves.toEqual({
      refresh: "on",
      reason: null,
      jobs: 2
    });
  });
});

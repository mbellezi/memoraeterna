import { describe, expect, it } from "vitest";

import {
  defaultAiLaneRuntimeConfig,
  defaultMlxRuntimeConfig,
  localDeadlineMs,
  mlxHelperEnvironment,
  resolveAiLaneRuntimeConfig,
  resolveMlxRuntimeConfig
} from "./runtime-config.js";

describe("resolveAiLaneRuntimeConfig", () => {
  it("starts API-key lanes at 4, Codex lanes at 2, ages P3 after 60 s and P2 after 120 s", () => {
    const config = resolveAiLaneRuntimeConfig({}, { environment: {} });
    expect(config).toEqual(defaultAiLaneRuntimeConfig);
    expect(config.mode).toBe("product");
    expect(config.lanes).toMatchObject({ apiKeyMax: 4, codexMax: 2, minimum: 1 });
    expect(config.aging).toEqual({ p3ToP2Ms: 60_000, p2ToP1Ms: 120_000 });
    expect(config.localDeadlines.totalMs).toEqual({
      embed: 30_000,
      decide: 10_000,
      "write-fast": 180_000,
      "write-quality": 900_000,
      answer: 300_000
    });
    expect(localDeadlineMs(config.localDeadlines, "decide")).toBe(10_000);
  });

  it("runs serial lanes for golden runs and on MEMORA_AI_LANES=serial, never in packaged builds", () => {
    const serial = { environment: { MEMORA_AI_LANES: " serial " } };
    expect(resolveAiLaneRuntimeConfig({}, serial).mode).toBe("serial");
    expect(
      resolveAiLaneRuntimeConfig({}, { environment: { MEMORA_GOLDEN_RUN: "m.json" } }).mode
    ).toBe("serial");
    expect(
      resolveAiLaneRuntimeConfig(
        {},
        { environment: { MEMORA_GOLDEN_RUN: "m.json", MEMORA_AI_LANES: "product" } }
      ).mode
    ).toBe("product");
    expect(resolveAiLaneRuntimeConfig({}, { ...serial, packaged: true }).mode).toBe("product");
    expect(resolveAiLaneRuntimeConfig({}, { environment: { MEMORA_AI_LANES: "fast" } }).mode).toBe(
      "product"
    );
    expect(resolveAiLaneRuntimeConfig({ mode: "product" }, serial).mode).toBe("product");
  });

  it("merges partial input and refuses values outside the schema", () => {
    const config = resolveAiLaneRuntimeConfig(
      { lanes: { codexMax: 3 }, localDeadlines: { totalMs: { decide: 5_000 } } },
      { environment: {} }
    );
    expect(config.lanes).toMatchObject({ codexMax: 3, apiKeyMax: 4 });
    expect(config.localDeadlines.totalMs).toMatchObject({ decide: 5_000, embed: 30_000 });
    expect(() =>
      resolveAiLaneRuntimeConfig({ lanes: { codexMax: 0 } }, { environment: {} })
    ).toThrow();
    expect(() =>
      resolveAiLaneRuntimeConfig({ lanes: { decreaseFactor: 1 } }, { environment: {} })
    ).toThrow();
  });
});

describe("resolveMlxRuntimeConfig", () => {
  it("bounds the buffer cache by default and leaves the overall limit to MLX", () => {
    const config = resolveMlxRuntimeConfig({}, {});

    expect(config).toEqual(defaultMlxRuntimeConfig);
    expect(config.cacheLimitMb).toBe(1_024);
    expect(config.memoryLimitMb).toBeUndefined();
    expect(config.requestTimeoutMs).toBe(600_000);
  });

  it("lets the operator variables override defaults and explicit input override both", () => {
    const environment = {
      MEMORA_MLX_CACHE_LIMIT_MB: "2048",
      MEMORA_MLX_MEMORY_LIMIT_MB: " 16384 "
    };

    expect(resolveMlxRuntimeConfig({}, environment)).toMatchObject({
      cacheLimitMb: 2_048,
      memoryLimitMb: 16_384
    });
    expect(
      resolveMlxRuntimeConfig({ cacheLimitMb: 0, requestTimeoutMs: 5_000 }, environment)
    ).toMatchObject({
      cacheLimitMb: 0,
      memoryLimitMb: 16_384,
      requestTimeoutMs: 5_000
    });
  });

  it("ignores operator values that are not whole numbers inside the allowed range", () => {
    for (const value of ["", "abc", "-5", "1.5", "1e3", "999999999999"]) {
      expect(
        resolveMlxRuntimeConfig(
          {},
          {
            MEMORA_MLX_CACHE_LIMIT_MB: value,
            MEMORA_MLX_MEMORY_LIMIT_MB: value
          }
        )
      ).toEqual(defaultMlxRuntimeConfig);
    }
    // Above the cache ceiling is ignored; zero is a valid cache; ten is below the overall floor.
    expect(resolveMlxRuntimeConfig({}, { MEMORA_MLX_CACHE_LIMIT_MB: "100000" }).cacheLimitMb).toBe(
      1_024
    );
    expect(
      resolveMlxRuntimeConfig(
        {},
        { MEMORA_MLX_CACHE_LIMIT_MB: "0", MEMORA_MLX_MEMORY_LIMIT_MB: "10" }
      )
    ).toMatchObject({ cacheLimitMb: 0 });
    expect(
      resolveMlxRuntimeConfig({}, { MEMORA_MLX_MEMORY_LIMIT_MB: "10" }).memoryLimitMb
    ).toBeUndefined();
  });

  it("rejects explicit configuration outside the typed bounds", () => {
    expect(() => resolveMlxRuntimeConfig({ cacheLimitMb: -1 }, {})).toThrow();
    expect(() => resolveMlxRuntimeConfig({ memoryLimitMb: 1 }, {})).toThrow();
    expect(() => resolveMlxRuntimeConfig({ requestTimeoutMs: 0 }, {})).toThrow();
    expect(() =>
      resolveMlxRuntimeConfig({ unknown: 1 } as unknown as Record<string, number>, {})
    ).toThrow();
  });
});

describe("mlxHelperEnvironment", () => {
  it("forwards only the minimal host variables and the memory bounds", () => {
    const config = resolveMlxRuntimeConfig({ memoryLimitMb: 4_096 }, {});

    expect(
      mlxHelperEnvironment(config, {
        PATH: "/usr/bin",
        HOME: "/home/test",
        TMPDIR: "/tmp",
        LANG: "pt_BR.UTF-8",
        LC_ALL: "pt_BR.UTF-8",
        OPENAI_API_KEY: "secret",
        MEMORA_MLX_CACHE_LIMIT_MB: "7"
      })
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      TMPDIR: "/tmp",
      LC_ALL: "pt_BR.UTF-8",
      LANG: "pt_BR.UTF-8",
      MEMORA_MLX_CACHE_LIMIT_MB: "1024",
      MEMORA_MLX_MEMORY_LIMIT_MB: "4096"
    });
  });

  it("defaults the language and omits an unset overall limit", () => {
    expect(mlxHelperEnvironment(resolveMlxRuntimeConfig({}, {}), {})).toEqual({
      LANG: "en_US.UTF-8",
      MEMORA_MLX_CACHE_LIMIT_MB: "1024"
    });
  });
});

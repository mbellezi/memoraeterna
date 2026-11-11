import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appSettingsSchema,
  appSettingsUpdateSchema,
  defaultAppSettings
} from "../../shared/ipc.js";
import { migrateMatchingSettingsV2 } from "@app/domain";
import { benchmarkConfiguration, runMatchingBenchmark } from "./matching-benchmark.js";

describe("benchmark scratch-profile mode", () => {
  it("refuses a non-scratch userData before any read or write", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "memora-benchmark-workspace-"));
    try {
      const sibling = join(workspace, ".cache", "other");
      await mkdir(sibling, { recursive: true });
      const untouched = {
        query: () => {
          throw new Error("the pool must not be used");
        }
      };
      for (const userDataPath of [sibling, "relative/path", join(workspace, "@app", "desktop")])
        await expect(
          runMatchingBenchmark({
            mode: "benchmark",
            isPackaged: false,
            userDataPath,
            workspaceRoot: workspace,
            pool: untouched as never,
            ingestion: {} as never,
            hierarchy: {} as never,
            settings: {} as never,
            jobs: {} as never,
            backup: {} as never,
            ai: {} as never
          })
        ).rejects.toThrow("matching.errors.notScratchProfile");
      expect(await readdir(sibling)).toEqual([]);
      expect(await readdir(workspace)).toEqual([".cache"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("larger matching benchmark", () => {
  it("compares bounded evidence presets without changing acceptance or identity safeguards", () => {
    const pilot = JSON.parse(readFileSync("docs/matching-pilot-settings.json", "utf8"));
    // The recorded settings predate matching settings v2 (T53b): they read through its migration.
    const reference = appSettingsSchema.parse(
      migrateMatchingSettingsV2({
        ...defaultAppSettings,
        ...pilot.settings,
        language: "pt-BR",
        updatedAt: new Date().toISOString()
      })
    );
    for (const variant of ["baseline", "economy", "coverage"] as const) {
      const settings = appSettingsUpdateSchema.parse(benchmarkConfiguration(reference, variant));
      expect(settings.sourceRelationSettings?.minImportance).toBe(0.8);
      expect(settings.atomicNoteMatchingSettings).toEqual(reference.atomicNoteMatchingSettings);
      expect(settings.entityIdentitySimilarityThreshold).toBe(
        reference.entityIdentitySimilarityThreshold
      );
    }
    expect(
      benchmarkConfiguration(reference, "economy").sourceRelationSettings!.evidenceChunksPerSource
    ).toBeLessThan(reference.sourceRelationSettings.evidenceChunksPerSource);
    expect(
      benchmarkConfiguration(reference, "coverage").sourceRelationSettings!.evidenceChunksPerSource
    ).toBeGreaterThan(reference.sourceRelationSettings.evidenceChunksPerSource);
  });
  it("keeps 20 unseen roots separate and all assessment labels outside ordinary document fields", () => {
    const corpus = JSON.parse(readFileSync("scripts/fixtures/matching-benchmark.json", "utf8"));
    expect(corpus.sources.filter((s: any) => s.partition === "tuning")).toHaveLength(40);
    expect(corpus.sources.filter((s: any) => s.partition === "holdout")).toHaveLength(20);
    const keys = new Set(corpus.sources.map((s: any) => s.key));
    expect(keys.size).toBe(60);
    const ids = corpus.sources.flatMap((s: any) => [
      s.key,
      ...(s.chapters ?? []).map((c: any) => c.key)
    ]);
    expect(new Set(ids).size).toBe(82);
    const pair = (p: string[]) => [...p].sort().join("/");
    const expected = new Set(corpus.expectedRootPairs.map((r: any) => pair(r.pair)));
    for (const row of [...corpus.expectedRootPairs, ...corpus.forbiddenRootPairs]) {
      expect(row.pair.every((key: string) => keys.has(key))).toBe(true);
      expect(row.pair[0]).not.toBe(row.pair[1]);
      const held = row.pair.some(
        (key: string) => corpus.sources.find((s: any) => s.key === key).partition === "holdout"
      );
      expect(row.partition).toBe(held ? "holdout" : "tuning");
    }
    expect(corpus.forbiddenRootPairs.some((r: any) => expected.has(pair(r.pair)))).toBe(false);
  });
});

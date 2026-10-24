import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MatchingConfigurationSchema,
  MatchingPresetsSchema,
  recommendedMatchingConfiguration,
  retiredRecommendedMatchingConfiguration
} from "./matching-presets.js";
import {
  migrateMatchingSettingsV2,
  retiredMatchingSettingKeys,
  retiredNoteMatchingSettingKeys,
  retiredSourceRelationSettingKeys
} from "./matching-settings-migration.js";

interface Configuration {
  atomicNoteMatchingSettings: Record<string, unknown>;
  sourceRelationSettings: Record<string, unknown>;
  [key: string]: unknown;
}
interface SettingsDocument extends Configuration {
  activeMatchingPresetId?: string;
  matchingPresets: Array<{ id: string; name: string | null; settings: Configuration }>;
  language: string;
  updatedAt: string;
}
const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
/** The app settings ENV-F, ENV-G, ENV-C and the DEV profile hold today (their matching shape is identical). */
const profiles = readJson<{ profiles: string[]; document: SettingsDocument }>(
  "./fixtures/app-settings-matching-before-v2.json"
);
const profileDocument = profiles.document;
const clone = <T>(value: T): T => structuredClone(value);

const presetId = "afbec711-07cd-43b1-8088-153df3dc5f73";
/** An old preset the person edited: dead fields at non-default values, live fields customized. */
const editedPreset = () => ({
  id: presetId,
  name: "My matching",
  settings: {
    atomicNoteRelationThreshold: 0.81,
    entityIdentitySimilarityThreshold: profileDocument.entityIdentitySimilarityThreshold,
    relationTypeSimilarityThreshold: profileDocument.relationTypeSimilarityThreshold,
    canonicalMatchingSettings: clone(profileDocument.canonicalMatchingSettings),
    atomicNoteMatchingSettings: {
      ...clone(profileDocument.atomicNoteMatchingSettings),
      rerankerWeight: 0.9,
      requireReranking: false,
      includeWeakTypes: true,
      fusedCandidateLimit: 40,
      maxRerankOutputTokens: 2048
    },
    sourceRelationSettings: {
      ...clone(profileDocument.sourceRelationSettings),
      includeWeakTypes: true,
      minImportance: 0.9
    }
  }
});

const retiredNames = [
  ...retiredMatchingSettingKeys,
  ...retiredNoteMatchingSettingKeys,
  ...retiredSourceRelationSettingKeys
];
const hasRetiredField = (configuration: Configuration): boolean =>
  retiredMatchingSettingKeys.some((key) => key in configuration) ||
  retiredNoteMatchingSettingKeys.some((key) => key in configuration.atomicNoteMatchingSettings) ||
  retiredSourceRelationSettingKeys.some((key) => key in configuration.sourceRelationSettings);

describe("matching settings v2 migration", () => {
  it("is built from the profiles' own shape: ENV-F, ENV-G, ENV-C and DEV hold the same document", () => {
    expect(profiles.profiles).toEqual(["env-f", "env-g", "env-c", "dev"]);
    expect(hasRetiredField(profileDocument)).toBe(true);
    expect(profileDocument.sourceRelationSettings.maxPairs).toBe(6);
  });

  it("drops the dead fields from the profiles' document and leaves the recommendation", () => {
    const before = clone(profileDocument);
    const migrated = migrateMatchingSettingsV2(profileDocument) as SettingsDocument;
    expect(profileDocument).toEqual(before);
    expect(hasRetiredField(migrated)).toBe(false);
    expect(Object.keys(migrated.atomicNoteMatchingSettings)).toEqual(["maxRerankOutputTokens"]);
    expect(MatchingConfigurationSchema.parse(migrated)).toEqual(recommendedMatchingConfiguration);
    // Everything that is not a dead field is exactly what the profile held.
    const edited = [
      "atomicNoteRelationThreshold",
      "atomicNoteMatchingSettings",
      "sourceRelationSettings"
    ];
    expect(migrated).toMatchObject(
      Object.fromEntries(Object.entries(before).filter(([key]) => !edited.includes(key)))
    );
    expect(migrated.atomicNoteMatchingSettings).toEqual({ maxRerankOutputTokens: 4096 });
    expect(migrated.sourceRelationSettings).toEqual(
      Object.fromEntries(
        Object.entries(before.sourceRelationSettings).filter(
          ([key]) => !(retiredSourceRelationSettingKeys as readonly string[]).includes(key)
        )
      )
    );
    expect(migrated.activeMatchingPresetId).toBe("recommended-v2");
    expect(migrated.matchingPresets).toEqual([]);
    expect(migrated.language).toBe(before.language);
    expect(migrated.updatedAt).toBe(before.updatedAt);
  });

  it("keeps every other setting, including the weak-type switch of source relations", () => {
    const customized = {
      ...clone(profileDocument),
      themeMode: "dark",
      somethingElse: { kept: true },
      entityIdentitySimilarityThreshold: 0.8,
      relationTypeSimilarityThreshold: 0.7,
      canonicalMatchingSettings: {
        ...profileDocument.canonicalMatchingSettings,
        entityCandidateLimit: 7
      },
      atomicNoteMatchingSettings: {
        ...profileDocument.atomicNoteMatchingSettings,
        includeWeakTypes: true,
        maxRerankOutputTokens: 1024
      },
      sourceRelationSettings: {
        ...profileDocument.sourceRelationSettings,
        includeWeakTypes: true,
        evidenceChunksPerSource: 5
      }
    };
    const migrated = migrateMatchingSettingsV2(customized) as SettingsDocument;
    expect(migrated.atomicNoteMatchingSettings).toEqual({ maxRerankOutputTokens: 1024 });
    expect(migrated.sourceRelationSettings).toEqual({
      evidenceChunksPerSource: 5,
      evidenceMaxCharacters: 800,
      summaryMaxCharacters: 1000,
      maxOutputTokens: 4096,
      maxRelationsPerPair: 4,
      maxInputTokens: 60000,
      minImportance: 0.75,
      minConfidence: 0.85,
      includeWeakTypes: true
    });
    expect(migrated).toMatchObject({
      themeMode: "dark",
      somethingElse: { kept: true },
      entityIdentitySimilarityThreshold: 0.8,
      relationTypeSimilarityThreshold: 0.7,
      canonicalMatchingSettings: { entityCandidateLimit: 7, confirmationBatchSize: 12 }
    });
  });

  it("migrates every saved preset and keeps their names, order and the active one", () => {
    const clean = {
      id: "11111111-1111-4111-8111-111111111111",
      name: null,
      settings: recommendedMatchingConfiguration
    };
    const document = {
      ...clone(profileDocument),
      activeMatchingPresetId: presetId,
      matchingPresets: [editedPreset(), clean]
    };
    const migrated = migrateMatchingSettingsV2(document) as SettingsDocument;
    expect(migrated.activeMatchingPresetId).toBe(presetId);
    expect(migrated.matchingPresets.map((preset) => [preset.id, preset.name])).toEqual([
      [presetId, "My matching"],
      [clean.id, null]
    ]);
    for (const preset of migrated.matchingPresets)
      expect(hasRetiredField(preset.settings)).toBe(false);
    const [edited] = MatchingPresetsSchema.parse(migrated.matchingPresets);
    expect(edited!.settings).toMatchObject({
      atomicNoteMatchingSettings: { maxRerankOutputTokens: 2048 },
      sourceRelationSettings: { includeWeakTypes: true, minImportance: 0.9 }
    });
    // The migrated preset that was untouched is the one the schema already held.
    expect(migrated.matchingPresets[1]).toBe(document.matchingPresets[1]);
  });

  it("is idempotent and returns the very same object when nothing is left to drop", () => {
    const once = migrateMatchingSettingsV2(profileDocument);
    expect(once).not.toBe(profileDocument);
    expect(migrateMatchingSettingsV2(once)).toBe(once);
    const withPreset = { ...clone(profileDocument), matchingPresets: [editedPreset()] };
    const first = migrateMatchingSettingsV2(withPreset);
    expect(migrateMatchingSettingsV2(first)).toBe(first);
    expect(migrateMatchingSettingsV2(clone(first))).toEqual(first);
    const clean = { language: "en", activeMatchingPresetId: "recommended-v2", matchingPresets: [] };
    expect(migrateMatchingSettingsV2(clean)).toBe(clean);
  });

  it("passes through what is not a settings document and tolerates malformed parts", () => {
    for (const value of [null, undefined, "text", 3, [], [profileDocument]]) {
      expect(migrateMatchingSettingsV2(value)).toBe(value);
    }
    const malformed = {
      atomicNoteMatchingSettings: "broken",
      sourceRelationSettings: null,
      matchingPresets: [null, "x", { id: presetId, settings: 4 }]
    };
    expect(migrateMatchingSettingsV2(malformed)).toBe(malformed);
  });

  it("reads the recorded settings of the earlier recommendations and drops the dead fields from them", () => {
    const benchmark = readJson<{ settings: unknown }>(
      "../../../docs/matching-benchmark-settings.json"
    );
    const migrated = migrateMatchingSettingsV2(benchmark.settings);
    expect(MatchingConfigurationSchema.parse(migrated)).toEqual(
      retiredRecommendedMatchingConfiguration
    );
    expect(retiredNames.some((key) => key in (migrated as object))).toBe(false);
    const pilot = readJson<{ settings: unknown }>("../../../docs/matching-pilot-settings.json");
    const piloted = migrateMatchingSettingsV2(pilot.settings) as Configuration;
    expect(hasRetiredField(piloted)).toBe(false);
    expect(MatchingConfigurationSchema.safeParse(piloted).success).toBe(true);
  });

  it("leaves no reader of the retired fields in product code", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        if (entry === "node_modules" || entry === "dist" || entry === "fixtures") continue;
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/u.test(entry) && !/\.test\.tsx?$/u.test(entry)) files.push(path);
      }
    };
    for (const group of ["apps", "packages"])
      for (const workspace of readdirSync(join(root, group)))
        if (statSync(join(root, group, workspace)).isDirectory())
          try {
            walk(join(root, group, workspace, "src"));
          } catch {
            /* A workspace without sources. */
          }
    // Three names also exist as unrelated code: the rank-fusion parameters of search and of the
    // candidate fusion, and the weak-type switch of source relations (a setting that stays).
    const allowed: Record<string, readonly string[]> = {
      reciprocalRankConstant: ["knowledge-processing.ts", "search-service.ts"],
      minimumGraphOnlyCandidates: ["knowledge-processing.ts"],
      includeWeakTypes: [
        "golden-source-pairs.ts",
        "source-relation-processing.ts",
        "source-relations.ts",
        "matching-presets.ts",
        // Settings › Knowledge › Advanced › Matching (T98): its control, registry row and calibration.
        "MatchingSettingsGroup.tsx",
        "settings-registry.ts",
        "matching-calibration.ts"
      ]
    };
    const found: string[] = [];
    for (const file of files) {
      const name = file.slice(file.lastIndexOf("/") + 1);
      if (name === "matching-settings-migration.ts") continue;
      const text = readFileSync(file, "utf8");
      for (const key of [...retiredMatchingSettingKeys, ...retiredNoteMatchingSettingKeys]) {
        if (allowed[key]?.includes(name)) continue;
        if (new RegExp(`\\b${key}\\b`, "u").test(text))
          found.push(`${relative(root, file)}: ${key}`);
      }
      for (const key of ["relationThreshold", "getRelationThreshold", "RelationThreshold"])
        if (text.includes(key)) found.push(`${relative(root, file)}: ${key}`);
    }
    expect(found).toEqual([]);
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsService, parseSavedAppSettings } from "./settings-service.js";
import { defaultAppSettings } from "../../shared/ipc";
import {
  MatchingConfigurationSchema,
  recommendedMatchingConfiguration,
  recommendedMatchingPresetId,
  retiredRecommendedMatchingConfiguration,
  retiredRecommendedMatchingPresetId
} from "@app/domain";
const paths: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("import dialog directory", () => {
  it("remembers selected file folders across restarts and ignores unavailable folders", async () => {
    vi.stubEnv("MEMORA_DATABASE_URL", "");
    const path = await mkdtemp(join(tmpdir(), "memora-import-dialog-"));
    paths.push(path);
    const folder = join(path, "Documentos com espaços");
    await mkdir(folder);
    const service = new SettingsService(path);
    expect(await service.getImportDirectory()).toBeUndefined();
    await service.rememberImportFile(join(folder, "example.pdf"));
    const restarted = new SettingsService(path);
    expect(await restarted.getImportDirectory()).toBe(folder);
    expect(await restarted.getApp()).not.toHaveProperty("directory");
    await rm(folder, { recursive: true });
    expect(await restarted.getImportDirectory()).toBeUndefined();
    await writeFile(
      join(path, "import-dialog.json"),
      JSON.stringify({ directory: "relative/folder" })
    );
    expect(await restarted.getImportDirectory()).toBeUndefined();
  });

  it("allows file selection when preferences cannot be read or saved", async () => {
    const service = new SettingsService(tmpdir(), { requireDatabase: true });
    expect(await service.getImportDirectory()).toBeUndefined();
    await expect(
      service.rememberImportFile(join(tmpdir(), "example.pdf"))
    ).resolves.toBeUndefined();
  });
});

describe("content language preference", () => {
  it.each([
    ["pt-PT", "pt-BR"],
    ["fr-CA", "fr"],
    ["de-DE", "en"]
  ])("initializes both languages from %s and persists them", async (locale, expected) => {
    vi.stubEnv("MEMORA_DATABASE_URL", "");
    const path = await mkdtemp(join(tmpdir(), "memora-settings-test-"));
    paths.push(path);
    const service = new SettingsService(path, { desktopLocale: locale });
    expect(await service.getApp()).toMatchObject({ language: expected, contentLanguage: expected });
    await service.updateApp({ language: "it" });
    expect(await new SettingsService(path, { desktopLocale: "es" }).getApp()).toMatchObject({
      language: "it",
      contentLanguage: expected
    });
    await service.updateApp({ contentLanguage: "es" });
    expect(await service.getApp()).toMatchObject({ language: "it", contentLanguage: "es" });
  });
  it("initializes legacy preferences from their saved interface language", () => {
    const { contentLanguage: _, ...legacy } = defaultAppSettings;
    expect(
      parseSavedAppSettings({ ...legacy, language: "pt-BR", updatedAt: new Date().toISOString() })
        .contentLanguage
    ).toBe("pt-BR");
  });
});

describe("advanced matching preferences", () => {
  it("loads defaults for legacy preferences and persists custom controls across restart", async () => {
    const {
      atomicNoteMatchingSettings: _notes,
      canonicalMatchingSettings: _canonical,
      ...legacy
    } = defaultAppSettings;
    expect(
      parseSavedAppSettings({ ...legacy, language: "en", updatedAt: new Date().toISOString() })
    ).toMatchObject({
      atomicNoteMatchingSettings: { requireReranking: true, textCandidateLimit: 20 },
      canonicalMatchingSettings: { entityCandidateLimit: 3 }
    });
    vi.stubEnv("MEMORA_DATABASE_URL", "");
    const path = await mkdtemp(join(tmpdir(), "memora-matching-settings-"));
    paths.push(path);
    const service = new SettingsService(path);
    const before = await service.getApp();
    await service.updateApp({
      atomicNoteMatchingSettings: {
        ...before.atomicNoteMatchingSettings,
        textCandidateLimit: 12,
        minRerankScore: 0.8
      },
      canonicalMatchingSettings: { ...before.canonicalMatchingSettings, entityCandidateLimit: 5 },
      sourceRelationSettings: { ...before.sourceRelationSettings, evidenceChunksPerSource: 2 }
    });
    const after = await new SettingsService(path).getApp();
    expect(after).toMatchObject({
      atomicNoteMatchingSettings: { textCandidateLimit: 12, minRerankScore: 0.8 },
      canonicalMatchingSettings: { entityCandidateLimit: 5 },
      sourceRelationSettings: { evidenceChunksPerSource: 2 },
      language: before.language
    });
    await expect(
      service.updateApp({
        atomicNoteMatchingSettings: {
          ...after.atomicNoteMatchingSettings,
          fusedCandidateLimit: 101
        }
      })
    ).rejects.toThrow();
    expect((await service.getApp()).atomicNoteMatchingSettings.fusedCandidateLimit).toBe(
      after.atomicNoteMatchingSettings.fusedCandidateLimit
    );
  });
});

describe("matching preset persistence", () => {
  async function service() {
    vi.stubEnv("MEMORA_DATABASE_URL", "");
    const path = await mkdtemp(join(tmpdir(), "memora-presets-"));
    paths.push(path);
    return { path, settings: new SettingsService(path) };
  }
  it("defaults to the recommendation and preserves duplicate edits and names across selection and restart", async () => {
    const { path, settings } = await service();
    const initial = await settings.getApp();
    expect(initial.activeMatchingPresetId).toBe(recommendedMatchingPresetId);
    expect(MatchingConfigurationSchema.parse(initial)).toEqual(recommendedMatchingConfiguration);
    const id = "afbec711-07cd-43b1-8088-153df3dc5f73";
    await settings.updateApp({
      matchingPresets: [{ id, name: "My matching", settings: recommendedMatchingConfiguration }],
      activeMatchingPresetId: id
    });
    await settings.updateApp({
      sourceRelationSettings: { ...initial.sourceRelationSettings, maxPairs: 9 },
      atomicNoteRelationThreshold: 0.67
    });
    const edited = await settings.getApp();
    expect(edited.matchingPresets[0]).toMatchObject({
      name: "My matching",
      settings: { atomicNoteRelationThreshold: 0.67, sourceRelationSettings: { maxPairs: 9 } }
    });
    await settings.updateApp({ activeMatchingPresetId: recommendedMatchingPresetId });
    expect(MatchingConfigurationSchema.parse(await settings.getApp())).toEqual(
      recommendedMatchingConfiguration
    );
    const restarted = new SettingsService(path);
    await restarted.updateApp({ activeMatchingPresetId: id });
    expect(await restarted.getApp()).toMatchObject({
      atomicNoteRelationThreshold: 0.67,
      sourceRelationSettings: { maxPairs: 9 }
    });
    await restarted.updateApp({
      matchingPresets: [{ ...edited.matchingPresets[0]!, name: "Renamed" }]
    });
    expect((await new SettingsService(path).getApp()).matchingPresets[0]?.name).toBe("Renamed");
    await restarted.updateApp({
      matchingPresets: [],
      activeMatchingPresetId: recommendedMatchingPresetId
    });
    expect(await new SettingsService(path).getApp()).toMatchObject({
      matchingPresets: [],
      activeMatchingPresetId: recommendedMatchingPresetId
    });
  });
  it("preserves legacy custom values and isolates direct edits from the built-in recommendation", async () => {
    const {
      matchingPresets: _presets,
      activeMatchingPresetId: _active,
      ...legacy
    } = defaultAppSettings;
    const saved = parseSavedAppSettings({
      ...legacy,
      atomicNoteRelationThreshold: 0.81,
      language: "en",
      updatedAt: new Date().toISOString()
    });
    expect(saved.activeMatchingPresetId).not.toBe(recommendedMatchingPresetId);
    expect(saved.matchingPresets[0]?.settings.atomicNoteRelationThreshold).toBe(0.81);
    expect(parseSavedAppSettings(saved)).toEqual(saved);
    const { settings } = await service();
    await settings.updateApp({ atomicNoteRelationThreshold: 0.81 });
    expect((await settings.getApp()).activeMatchingPresetId).not.toBe(recommendedMatchingPresetId);
    await settings.updateApp({ activeMatchingPresetId: recommendedMatchingPresetId });
    expect((await settings.getApp()).atomicNoteRelationThreshold).toBe(0.6);
  });
  it("refuses invalid activation without losing preferences and serializes concurrent updates", async () => {
    const { settings } = await service();
    const before = await settings.getApp();
    await expect(
      settings.updateApp({ activeMatchingPresetId: "afbec711-07cd-43b1-8088-153df3dc5f73" })
    ).rejects.toThrow();
    await expect(
      settings.updateApp({
        activeMatchingPresetId: recommendedMatchingPresetId,
        atomicNoteRelationThreshold: 0.99
      })
    ).rejects.toThrow();
    expect(await settings.getApp()).toEqual(before);
    await Promise.all([
      settings.updateApp({ atomicNoteRelationThreshold: 0.77 }),
      settings.updateApp({ language: "fr" })
    ]);
    expect(await settings.getApp()).toMatchObject({
      language: "fr",
      atomicNoteRelationThreshold: 0.77,
      matchingPresets: [{ settings: { atomicNoteRelationThreshold: 0.77 } }]
    });
  });
});

describe("recommended matching preset upgrade", () => {
  const customId = "afbec711-07cd-43b1-8088-153df3dc5f73";
  const preservedId = "00000000-0000-4000-8000-000000000001";
  const unversioned = Object.fromEntries(
    Object.entries(defaultAppSettings).filter(
      ([key]) => key !== "matchingPresets" && key !== "activeMatchingPresetId"
    )
  );
  const stored = (overrides: Record<string, unknown>) => ({
    ...unversioned,
    language: "en",
    updatedAt: new Date().toISOString(),
    ...overrides
  });
  const retired = retiredRecommendedMatchingConfiguration;

  it("starts a new install on recommended-v2", async () => {
    expect(recommendedMatchingPresetId).toBe("recommended-v2");
    expect(defaultAppSettings.activeMatchingPresetId).toBe("recommended-v2");
    vi.stubEnv("MEMORA_DATABASE_URL", "");
    const path = await mkdtemp(join(tmpdir(), "memora-recommended-new-"));
    paths.push(path);
    const initial = await new SettingsService(path).getApp();
    expect(initial.activeMatchingPresetId).toBe("recommended-v2");
    expect(initial.sourceRelationSettings).toMatchObject({
      minImportance: 0.75,
      minConfidence: 0.85
    });
    expect(initial.matchingPresets).toEqual([]);
  });

  it("upgrades an active recommended-v1 whose values are untouched", () => {
    const upgraded = parseSavedAppSettings(
      stored({
        ...retired,
        matchingPresets: [],
        activeMatchingPresetId: retiredRecommendedMatchingPresetId
      })
    );
    expect(upgraded.activeMatchingPresetId).toBe(recommendedMatchingPresetId);
    expect(upgraded.matchingPresets).toEqual([]);
    expect(MatchingConfigurationSchema.parse(upgraded)).toEqual(recommendedMatchingConfiguration);
    expect(parseSavedAppSettings(upgraded)).toEqual(upgraded);
  });

  it("upgrades values equal to recommended-v1 that name no custom preset", () => {
    for (const activeMatchingPresetId of [undefined, customId]) {
      const upgraded = parseSavedAppSettings(
        stored({ ...retired, matchingPresets: [], activeMatchingPresetId })
      );
      expect(upgraded.activeMatchingPresetId).toBe(recommendedMatchingPresetId);
      expect(upgraded.matchingPresets).toEqual([]);
      expect(MatchingConfigurationSchema.parse(upgraded)).toEqual(recommendedMatchingConfiguration);
    }
  });

  it("never changes a custom preset, even one that equals recommended-v1", () => {
    const custom = { id: customId, name: "My matching", settings: retired };
    const unchanged = parseSavedAppSettings(
      stored({ ...retired, matchingPresets: [custom], activeMatchingPresetId: customId })
    );
    expect(unchanged.activeMatchingPresetId).toBe(customId);
    expect(unchanged.matchingPresets).toEqual([custom]);
    expect(MatchingConfigurationSchema.parse(unchanged)).toEqual(retired);
    // An inactive custom preset survives the upgrade of the recommendation next to it.
    const beside = parseSavedAppSettings(
      stored({
        ...retired,
        matchingPresets: [custom],
        activeMatchingPresetId: retiredRecommendedMatchingPresetId
      })
    );
    expect(beside.activeMatchingPresetId).toBe(recommendedMatchingPresetId);
    expect(beside.matchingPresets).toEqual([custom]);
  });

  it("preserves customized v1 values as a custom preset instead of upgrading them", () => {
    const customized = {
      ...retired,
      sourceRelationSettings: { ...retired.sourceRelationSettings, minImportance: 0.9 }
    };
    for (const activeMatchingPresetId of [retiredRecommendedMatchingPresetId, undefined]) {
      const saved = parseSavedAppSettings(
        stored({ ...customized, matchingPresets: [], activeMatchingPresetId })
      );
      expect(saved.activeMatchingPresetId).toBe(preservedId);
      expect(saved.matchingPresets).toEqual([
        { id: preservedId, name: null, settings: customized }
      ]);
      expect(saved.sourceRelationSettings).toMatchObject({
        minImportance: 0.9,
        minConfidence: 0.8
      });
      expect(parseSavedAppSettings(saved)).toEqual(saved);
    }
  });

  it("keeps recommended-v2 as it is and persists the upgrade with the next update", async () => {
    const v2 = parseSavedAppSettings(
      stored({
        ...recommendedMatchingConfiguration,
        matchingPresets: [],
        activeMatchingPresetId: recommendedMatchingPresetId
      })
    );
    expect(v2.activeMatchingPresetId).toBe(recommendedMatchingPresetId);
    expect(v2.matchingPresets).toEqual([]);
    vi.stubEnv("MEMORA_DATABASE_URL", "");
    const path = await mkdtemp(join(tmpdir(), "memora-recommended-upgrade-"));
    paths.push(path);
    await writeFile(
      join(path, "app-settings.json"),
      JSON.stringify(
        stored({
          ...retired,
          matchingPresets: [],
          activeMatchingPresetId: retiredRecommendedMatchingPresetId
        })
      )
    );
    const service = new SettingsService(path);
    expect(await service.getApp()).toMatchObject({
      activeMatchingPresetId: recommendedMatchingPresetId,
      sourceRelationSettings: { minImportance: 0.75, minConfidence: 0.85 }
    });
    await service.updateApp({ themeMode: "light" });
    const restarted = await new SettingsService(path).getApp();
    expect(restarted).toMatchObject({ themeMode: "light", matchingPresets: [] });
    expect(restarted.activeMatchingPresetId).toBe(recommendedMatchingPresetId);
    await expect(
      service.updateApp({
        activeMatchingPresetId:
          retiredRecommendedMatchingPresetId as typeof recommendedMatchingPresetId
      })
    ).rejects.toThrow();
  });
});

describe("navigation layout preferences", () => {
  it("defaults legacy layouts and retains independent preferences across restart", async () => {
    const {
      navigationCollapsed: _collapsed,
      wikiTreeWidth: _width,
      ...legacy
    } = defaultAppSettings;
    expect(
      parseSavedAppSettings({ ...legacy, language: "en", updatedAt: new Date().toISOString() })
    ).toMatchObject({ navigationCollapsed: false, wikiTreeWidth: 320 });
    vi.stubEnv("MEMORA_DATABASE_URL", "");
    const path = await mkdtemp(join(tmpdir(), "memora-layout-settings-"));
    paths.push(path);
    const service = new SettingsService(path);
    await service.updateApp({ navigationCollapsed: true, wikiTreeWidth: 460 });
    await service.updateApp({ themeMode: "light" });
    expect(await new SettingsService(path).getApp()).toMatchObject({
      navigationCollapsed: true,
      wikiTreeWidth: 460,
      themeMode: "light"
    });
    await expect(service.updateApp({ wikiTreeWidth: 521 })).rejects.toThrow();
    await expect(service.updateApp({ wikiTreeWidth: 239 })).rejects.toThrow();
    expect((await service.getApp()).wikiTreeWidth).toBe(460);
  });
});

describe("theme preference", () => {
  const settingsDirectory = async (prefix: string) => {
    vi.stubEnv("MEMORA_DATABASE_URL", "");
    const path = await mkdtemp(join(tmpdir(), prefix));
    paths.push(path);
    return path;
  };

  it("follows the system appearance on a new install", async () => {
    expect(defaultAppSettings.themeMode).toBe("system");
    const service = new SettingsService(await settingsDirectory("memora-theme-new-"));
    expect((await service.getApp()).themeMode).toBe("system");
  });

  it.each(["dark", "light"] as const)(
    "keeps the %s theme an existing install already stored",
    async (themeMode) => {
      const path = await settingsDirectory("memora-theme-stored-");
      await writeFile(
        join(path, "app-settings.json"),
        JSON.stringify({
          ...defaultAppSettings,
          themeMode,
          language: "en",
          updatedAt: new Date().toISOString()
        })
      );
      expect((await new SettingsService(path).getApp()).themeMode).toBe(themeMode);
      // Saving something else does not reset it to the new default.
      const service = new SettingsService(path);
      await service.updateApp({ navigationCollapsed: true });
      expect((await new SettingsService(path).getApp()).themeMode).toBe(themeMode);
    }
  );

  it("remembers a return to the system appearance across restart", async () => {
    const path = await settingsDirectory("memora-theme-system-");
    const service = new SettingsService(path);
    await service.updateApp({ themeMode: "dark" });
    await service.updateApp({ themeMode: "system" });
    expect((await new SettingsService(path).getApp()).themeMode).toBe("system");
    await expect(service.updateApp({ themeMode: "auto" as never })).rejects.toThrow();
  });
});

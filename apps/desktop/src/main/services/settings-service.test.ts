import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsService, parseSavedAppSettings } from "./settings-service.js";
import { defaultAppSettings } from "../../shared/ipc";
import { MatchingConfigurationSchema, recommendedMatchingConfiguration, recommendedMatchingPresetId } from "@app/domain";
const paths: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("import dialog directory", () => {
  it("remembers selected file folders across restarts and ignores unavailable folders", async () => {
    vi.stubEnv("MEMORA_DATABASE_URL", "");
    const path = await mkdtemp(join(tmpdir(), "memora-import-dialog-")); paths.push(path);
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
    await writeFile(join(path, "import-dialog.json"), JSON.stringify({ directory: "relative/folder" }));
    expect(await restarted.getImportDirectory()).toBeUndefined();
  });

  it("allows file selection when preferences cannot be read or saved", async () => {
    const service = new SettingsService(tmpdir(), { requireDatabase: true });
    expect(await service.getImportDirectory()).toBeUndefined();
    await expect(service.rememberImportFile(join(tmpdir(), "example.pdf"))).resolves.toBeUndefined();
  });
});

describe("content language preference", () => {
  it.each([["pt-PT", "pt-BR"], ["fr-CA", "fr"], ["de-DE", "en"]])("initializes both languages from %s and persists them", async (locale, expected) => {
    vi.stubEnv("MEMORA_DATABASE_URL", "");
    const path = await mkdtemp(join(tmpdir(), "memora-settings-test-")); paths.push(path);
    const service = new SettingsService(path, { desktopLocale: locale });
    expect(await service.getApp()).toMatchObject({ language: expected, contentLanguage: expected });
    await service.updateApp({ language: "it" });
    expect(await new SettingsService(path, { desktopLocale: "es" }).getApp()).toMatchObject({ language: "it", contentLanguage: expected });
    await service.updateApp({ contentLanguage: "es" });
    expect(await service.getApp()).toMatchObject({ language: "it", contentLanguage: "es" });
  });
  it("initializes legacy preferences from their saved interface language", () => {
    const { contentLanguage: _, ...legacy } = defaultAppSettings;
    expect(parseSavedAppSettings({ ...legacy, language: "pt-BR", updatedAt: new Date().toISOString() }).contentLanguage).toBe("pt-BR");
  });
});

describe("advanced matching preferences", () => {
  it("loads defaults for legacy preferences and persists custom controls across restart", async () => {
    const { atomicNoteMatchingSettings: _notes, canonicalMatchingSettings: _canonical, ...legacy } = defaultAppSettings;
    expect(parseSavedAppSettings({ ...legacy, language: "en", updatedAt: new Date().toISOString() })).toMatchObject({
      atomicNoteMatchingSettings: { requireReranking: true, textCandidateLimit: 20 },
      canonicalMatchingSettings: { entityCandidateLimit: 3 }
    });
    vi.stubEnv("MEMORA_DATABASE_URL", "");
    const path = await mkdtemp(join(tmpdir(), "memora-matching-settings-")); paths.push(path);
    const service = new SettingsService(path);
    const before = await service.getApp();
    await service.updateApp({ atomicNoteMatchingSettings: { ...before.atomicNoteMatchingSettings, textCandidateLimit: 12, minRerankScore: 0.8 },
      canonicalMatchingSettings: { ...before.canonicalMatchingSettings, entityCandidateLimit: 5 },
      sourceRelationSettings: { ...before.sourceRelationSettings, evidenceChunksPerSource: 2 } });
    const after = await new SettingsService(path).getApp();
    expect(after).toMatchObject({ atomicNoteMatchingSettings: { textCandidateLimit: 12, minRerankScore: 0.8 },
      canonicalMatchingSettings: { entityCandidateLimit: 5 }, sourceRelationSettings: { evidenceChunksPerSource: 2 }, language: before.language });
    await expect(service.updateApp({ atomicNoteMatchingSettings: { ...after.atomicNoteMatchingSettings, fusedCandidateLimit: 101 } })).rejects.toThrow();
    expect((await service.getApp()).atomicNoteMatchingSettings.fusedCandidateLimit).toBe(after.atomicNoteMatchingSettings.fusedCandidateLimit);
  });
});

describe("matching preset persistence", () => {
  async function service() {
    vi.stubEnv("MEMORA_DATABASE_URL", "");
    const path = await mkdtemp(join(tmpdir(), "memora-presets-")); paths.push(path);
    return { path, settings: new SettingsService(path) };
  }
  it("defaults to the recommendation and preserves duplicate edits and names across selection and restart", async () => {
    const { path, settings } = await service();
    const initial = await settings.getApp();
    expect(initial.activeMatchingPresetId).toBe(recommendedMatchingPresetId);
    expect(MatchingConfigurationSchema.parse(initial)).toEqual(recommendedMatchingConfiguration);
    const id = "afbec711-07cd-43b1-8088-153df3dc5f73";
    await settings.updateApp({ matchingPresets: [{ id, name: "My matching", settings: recommendedMatchingConfiguration }], activeMatchingPresetId: id });
    await settings.updateApp({ sourceRelationSettings: { ...initial.sourceRelationSettings, maxPairs: 9 }, atomicNoteRelationThreshold: 0.67 });
    const edited = await settings.getApp();
    expect(edited.matchingPresets[0]).toMatchObject({ name: "My matching", settings: { atomicNoteRelationThreshold: 0.67, sourceRelationSettings: { maxPairs: 9 } } });
    await settings.updateApp({ activeMatchingPresetId: recommendedMatchingPresetId });
    expect(MatchingConfigurationSchema.parse(await settings.getApp())).toEqual(recommendedMatchingConfiguration);
    const restarted = new SettingsService(path);
    await restarted.updateApp({ activeMatchingPresetId: id });
    expect(await restarted.getApp()).toMatchObject({ atomicNoteRelationThreshold: 0.67, sourceRelationSettings: { maxPairs: 9 } });
    await restarted.updateApp({ matchingPresets: [{ ...edited.matchingPresets[0]!, name: "Renamed" }] });
    expect((await new SettingsService(path).getApp()).matchingPresets[0]?.name).toBe("Renamed");
    await restarted.updateApp({ matchingPresets: [], activeMatchingPresetId: recommendedMatchingPresetId });
    expect(await new SettingsService(path).getApp()).toMatchObject({ matchingPresets: [], activeMatchingPresetId: recommendedMatchingPresetId });
  });
  it("preserves legacy custom values and isolates direct edits from the built-in recommendation", async () => {
    const { matchingPresets: _presets, activeMatchingPresetId: _active, ...legacy } = defaultAppSettings;
    const saved = parseSavedAppSettings({ ...legacy, atomicNoteRelationThreshold: 0.81, language: "en", updatedAt: new Date().toISOString() });
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
    await expect(settings.updateApp({ activeMatchingPresetId: "afbec711-07cd-43b1-8088-153df3dc5f73" })).rejects.toThrow();
    await expect(settings.updateApp({ activeMatchingPresetId: recommendedMatchingPresetId, atomicNoteRelationThreshold: 0.99 })).rejects.toThrow();
    expect(await settings.getApp()).toEqual(before);
    await Promise.all([settings.updateApp({ atomicNoteRelationThreshold: 0.77 }), settings.updateApp({ language: "fr" })]);
    expect(await settings.getApp()).toMatchObject({ language: "fr", atomicNoteRelationThreshold: 0.77, matchingPresets: [{ settings: { atomicNoteRelationThreshold: 0.77 } }] });
  });
});

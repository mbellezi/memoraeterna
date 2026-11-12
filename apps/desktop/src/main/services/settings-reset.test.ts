import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultKnowledgeControls, recommendedMatchingPresetId } from "@app/domain";

import { AppEventSchema, type AppEvent } from "../../shared/app-events.js";
import {
  SettingsDescribeResultSchema,
  SettingsResetResultSchema
} from "../../shared/ipc-settings-describe.js";
import { resetAdapterIds, settingsRegistryV2 } from "../../shared/settings-registry.js";
import { appEventPort } from "./app-events.js";
import { SettingsReset, type SettingsResetPorts } from "./settings-reset.js";
import { SettingsService } from "./settings-service.js";

const folders: string[] = [];

afterEach(async () => {
  appEventPort.detach();
  vi.unstubAllEnvs();
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** The `settings` table as a map: the three statements the settings repository sends. */
function fakePool() {
  const rows = new Map<string, unknown>();
  return {
    rows,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const name = String(params[0]);
      if (sql.startsWith("select"))
        return { rows: rows.has(name) ? [{ key: name, value: rows.get(name) }] : [] };
      if (sql.startsWith("delete")) return { rowCount: rows.delete(name) ? 1 : 0, rows: [] };
      throw new Error(`unexpected statement: ${sql}`);
    })
  };
}

/** The writers outside the settings service, each a spy over a small state. */
function fakeWorld() {
  const state = {
    preset: null as string | null,
    routeProfile: "profile-1" as string | null,
    deciderMode: null as string | null,
    decisionsEnabled: false,
    decisionsKey: false,
    providers: [
      { id: "p-google", provider: "google", secretConfigured: false },
      { id: "p-compat", provider: "openai-compatible", secretConfigured: true }
    ] as { id: string; provider: string; secretConfigured: boolean }[],
    googleBooks: false,
    controls: { ...defaultKnowledgeControls },
    scope: { sourceIds: [] as string[], includeDescendants: true },
    layout: null as { version: 2; language: string; attachments: "omit" | "copy" } | null,
    blockedSetups: false
  };
  const ai = {
    classRoutes: vi.fn(async () => ({
      preset: state.preset,
      presets: [],
      classes: ["embed", "decide", "write-fast", "write-quality", "answer"].map((id) => ({
        id,
        profileId: state.routeProfile
      })),
      judge: { profileId: state.routeProfile, deciderMode: state.deciderMode }
    })),
    applyPreset: vi.fn(async (input: { preset: string }) => {
      if (state.blockedSetups) return { applied: false, blocked: [], view: null };
      state.preset = input.preset;
      state.routeProfile = "profile-from-setup";
      return { applied: true, blocked: [], view: null };
    }),
    setDeciderMode: vi.fn(async (mode: string | null) => {
      state.deciderMode = mode;
    }),
    decisionsStatus: vi.fn(async () => ({
      enabled: state.decisionsEnabled,
      keyStored: state.decisionsKey
    })),
    setDecisionsEnabled: vi.fn(async (enabled: boolean) => {
      state.decisionsEnabled = enabled;
    }),
    removeDecisionsKey: vi.fn(async () => {
      state.decisionsKey = false;
    }),
    listProviders: vi.fn(async () => state.providers),
    deleteProvider: vi.fn(async (id: string) => {
      state.providers = state.providers.filter((provider) => provider.id !== id);
      return true;
    })
  };
  const controls = {
    get: vi.fn(async () => ({ ...state.controls })),
    update: vi.fn(async (change: object) => {
      state.controls = { ...state.controls, ...change };
      return { ...state.controls };
    })
  };
  const wiki = {
    layout: vi.fn(async () => state.layout),
    scope: vi.fn(async () => ({ ...state.scope })),
    saveScope: vi.fn(async (scope: typeof state.scope) => {
      state.scope = scope;
      return scope;
    })
  };
  const layoutMigration = { preview: vi.fn(async () => ({})) };
  const googleBooks = {
    getGoogleBooksKeyStatus: vi.fn(async () => ({ configured: state.googleBooks })),
    updateGoogleBooksKey: vi.fn(async (key: string | null) => {
      state.googleBooks = key !== null;
      return { configured: state.googleBooks };
    })
  };
  return { state, ai, controls, wiki, layoutMigration, googleBooks };
}

async function setup(locale = "pt-BR") {
  vi.stubEnv("MEMORA_DATABASE_URL", "");
  const path = await mkdtemp(join(tmpdir(), "memora-settings-reset-"));
  folders.push(path);
  const events: AppEvent[] = [];
  appEventPort.attach({ publish: (event) => events.push(event) });
  const settings = new SettingsService(path, { desktopLocale: locale });
  const world = fakeWorld();
  const pool = fakePool();
  const credentials = { remove: vi.fn(async () => true) };
  const treeShapeChanged = vi.fn();
  const warn = vi.fn();
  const published: AppEvent[] = [];
  const ports: SettingsResetPorts = {
    settings,
    ai: () => world.ai as never,
    recommendedPreset: async () => "hybrid",
    knowledgeControls: () => world.controls,
    treeShapeChanged,
    obsidian: () => ({ wiki: world.wiki, layoutMigration: world.layoutMigration }) as never,
    googleBooks: () => world.googleBooks,
    pool: () => pool as never,
    credentials,
    publish: (event) => published.push(event),
    logger: { warn }
  };
  return {
    settings,
    world,
    pool,
    credentials,
    treeShapeChanged,
    warn,
    published,
    events,
    ports,
    reset: new SettingsReset(ports)
  };
}

const settingsEvents = (events: AppEvent[]) =>
  events.filter((event) => event.type === "settings.changed");

async function described(reset: SettingsReset, id: string) {
  const entry = (await reset.describe()).entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`${id} was not described`);
  return entry;
}

describe("settings.describe", () => {
  it("describes every entry that stores something, and none that stores nothing", async () => {
    const { reset } = await setup();
    const result = await reset.describe();
    expect(SettingsDescribeResultSchema.safeParse(result).success).toBe(true);
    const stored = settingsRegistryV2.filter((entry) => entry.store.kind !== "none");
    expect(result.entries.map((entry) => entry.id)).toEqual(stored.map((entry) => entry.id));
    expect(settingsRegistryV2.some((entry) => entry.store.kind === "none")).toBe(true);
  });

  it("finds every stored entry unchanged on a library nobody touched", async () => {
    const { reset } = await setup();
    const changed = (await reset.describe()).entries.filter((entry) => entry.changed);
    // Only what a fixture gives a value: the second Google provider key and the Compatible one.
    expect(changed.map((entry) => entry.id)).toEqual(["ai.provider.openai-compatible"]);
  });

  it("marks a value away from its default and names the default", async () => {
    const { reset, settings } = await setup();
    await settings.updateApp({ themeMode: "dark", summaryMinimumWordCount: 120 });
    expect(await described(reset, "themeMode")).toEqual({
      id: "themeMode",
      value: "dark",
      default: "system",
      changed: true
    });
    expect(await described(reset, "summaryMinimumWordCount")).toMatchObject({
      value: 120,
      default: 40,
      changed: true
    });
    expect(await described(reset, "debugMode")).toMatchObject({ value: false, changed: false });
  });

  it("compares the language settings with the macOS language", async () => {
    const { reset, settings } = await setup("pt-BR");
    expect(await described(reset, "language")).toEqual({
      id: "language",
      value: "pt-BR",
      default: "pt-BR",
      changed: false
    });
    await settings.updateApp({ contentLanguage: "fr" });
    expect(await described(reset, "contentLanguage")).toMatchObject({
      value: "fr",
      default: "pt-BR",
      changed: true
    });
  });

  it("reads the merged controls as one value", async () => {
    const { reset, settings } = await setup();
    await settings.updateApp({ metadataEnrichmentEnabled: false });
    expect(await described(reset, "bookLookup")).toMatchObject({ value: "off", changed: true });
    await settings.updateApp({
      metadataEnrichmentEnabled: true,
      bookMetadataProvider: "google-books"
    });
    expect(await described(reset, "bookLookup")).toMatchObject({
      value: "google-books",
      default: "auto",
      changed: true
    });
    await settings.update({ obsidianVaultPath: "/Users/me/Vault", obsidianSyncEnabled: true });
    expect(await described(reset, "obsidianSync")).toMatchObject({ value: "on", changed: true });
    await settings.update({ obsidianSyncPaused: true });
    expect(await described(reset, "obsidianSync")).toMatchObject({ value: "paused" });
    await settings.update({
      uploadCopiesEnabled: true,
      uploadCopiesFolderPath: "/Users/me/Copies"
    });
    expect(await described(reset, "uploadCopies")).toMatchObject({ value: true, changed: true });
  });

  it("never carries a filesystem path or a secret", async () => {
    const { reset, settings, world } = await setup();
    await settings.update({
      obsidianVaultPath: "/Users/me/Vault",
      uploadCopiesEnabled: true,
      uploadCopiesFolderPath: "/Users/me/Copies"
    });
    world.state.decisionsKey = true;
    world.state.googleBooks = true;
    const text = JSON.stringify(await reset.describe());
    expect(text).not.toContain("/Users/me");
    expect(await described(reset, "obsidianVaultPath")).toEqual({
      id: "obsidianVaultPath",
      value: true,
      default: null,
      changed: true
    });
    expect(await described(reset, "ai:decisions-openai-platform")).toMatchObject({
      value: true,
      changed: true
    });
    expect(await described(reset, "metadata:google-books")).toMatchObject({ value: true });
  });

  it("describes the Knowledge controls, the setup and the Obsidian entries", async () => {
    const { reset, world } = await setup();
    world.state.controls = { ...world.state.controls, autonomy: "full" } as never;
    world.state.preset = "local";
    world.state.scope = { sourceIds: ["a", "b"], includeDescendants: false };
    world.state.layout = { version: 2, language: "fr", attachments: "copy" };
    expect(await described(reset, "knowledge.controls.v1.autonomy")).toMatchObject({
      value: "full",
      changed: true
    });
    expect(await described(reset, "ai.preset.v1")).toEqual({
      id: "ai.preset.v1",
      value: "local",
      default: "hybrid",
      changed: true
    });
    expect(await described(reset, "obsidian.wiki.scope")).toMatchObject({
      value: 2,
      changed: true
    });
    expect(await described(reset, "obsidian.wiki.includeDescendants")).toMatchObject({
      value: false,
      default: true,
      changed: true
    });
    expect(await described(reset, "obsidian.layout.attachments")).toMatchObject({
      value: "copy",
      default: "omit",
      changed: true
    });
    expect(await described(reset, "obsidian.layout.language")).toMatchObject({
      value: "fr",
      default: "pt-BR",
      changed: true
    });
  });

  it("marks the class routes by what the setup says, and names no default for them", async () => {
    const { reset, world } = await setup();
    expect(await described(reset, "ai.route.embed")).toEqual({
      id: "ai.route.embed",
      value: "profile-1",
      default: null,
      changed: false
    });
    world.state.preset = "custom";
    expect(await described(reset, "ai.route.judge")).toMatchObject({ changed: true });
  });

  it("leaves out the entries of a store that cannot be read, and says so once", async () => {
    const { reset, ports, warn } = await setup();
    const closed = new SettingsReset({ ...ports, ai: () => null, obsidian: () => null });
    const result = await closed.describe();
    const ids = result.entries.map((entry) => entry.id);
    expect(ids).toContain("themeMode");
    expect(ids).not.toContain("ai.preset.v1");
    expect(ids).not.toContain("obsidian.wiki.scope");
    expect(warn).toHaveBeenCalledTimes(7);
    expect((await reset.describe()).entries.length).toBeGreaterThan(ids.length);
  });
});

describe("settings.reset", () => {
  it("has an adapter for every reset id the registry uses", async () => {
    const { reset } = await setup();
    const used = new Set(
      settingsRegistryV2.filter((entry) => entry.store.kind !== "none").map((entry) => entry.reset)
    );
    expect(used.has("none")).toBe(false);
    for (const id of resetAdapterIds.filter((candidate) => candidate !== "none"))
      expect(used.has(id), id).toBe(true);
    // Every stored entry resets without error when it holds its default (a no-op) ...
    for (const entry of settingsRegistryV2.filter((candidate) => candidate.store.kind !== "none")) {
      if (entry.id === "ai.provider.openai-compatible") continue;
      await expect(reset.reset({ id: entry.id }), entry.id).resolves.toMatchObject({
        id: entry.id
      });
    }
  });

  it("refuses an unknown id and an entry that stores nothing", async () => {
    const { reset } = await setup();
    await expect(reset.reset({ id: "nope" })).rejects.toThrow("errors.common.notFound");
    await expect(reset.reset({ id: "ai.models" })).rejects.toThrow(
      "errors.common.validationFailed"
    );
  });

  it("writes nothing and announces nothing for a setting that holds its default", async () => {
    const { reset, published, events, world } = await setup();
    const before = await reset.describe();
    expect(await reset.reset({ id: "themeMode" })).toEqual({ id: "themeMode", value: "system" });
    expect(await reset.reset({ id: "ai.preset.v1" })).toEqual({ id: "ai.preset.v1", value: null });
    expect(published).toEqual([]);
    expect(settingsEvents(events)).toEqual([]);
    expect(world.ai.applyPreset).not.toHaveBeenCalled();
    expect(await reset.describe()).toEqual(before);
  });

  it("app-preference: puts a preference back through updateApp, and the settings service announces it", async () => {
    const { reset, settings, events, published } = await setup();
    await settings.updateApp({ themeMode: "dark", contentLanguage: "es" });
    events.length = 0;
    expect(await reset.reset({ id: "themeMode" })).toEqual({ id: "themeMode", value: "system" });
    expect(await reset.reset({ id: "contentLanguage" })).toEqual({
      id: "contentLanguage",
      value: "pt-BR"
    });
    expect((await settings.getApp()).themeMode).toBe("system");
    expect(settingsEvents(events)).toEqual([
      { type: "settings.changed", stores: ["app"], keys: ["themeMode"] },
      { type: "settings.changed", stores: ["app"], keys: ["contentLanguage"] }
    ]);
    // The settings service already announced it: the reset does not announce a second time.
    expect(published).toEqual([]);
  });

  it("app-preference: an unset list goes back to empty", async () => {
    const { reset, settings } = await setup();
    await settings.updateApp({
      processingPresets: [
        { id: "00000000-0000-4000-8000-0000000000a1", name: "Mine", requestedStages: [] }
      ]
    });
    expect(await described(reset, "processingPresets")).toMatchObject({
      value: true,
      changed: true
    });
    expect(await reset.reset({ id: "processingPresets" })).toEqual({
      id: "processingPresets",
      value: null
    });
    expect((await settings.getApp()).processingPresets).toEqual([]);
  });

  it("matching-value: restores one value of a group and keeps its neighbours", async () => {
    const { reset, settings } = await setup();
    await settings.updateApp({
      sourceRelationSettings: {
        ...(await settings.getApp()).sourceRelationSettings,
        minImportance: 0.9,
        maxRelationsPerPair: 2
      },
      relationTypeSimilarityThreshold: 0.5
    });
    const calibrated = (await described(reset, "sourceRelationSettings.minImportance")).default;
    expect(await reset.reset({ id: "sourceRelationSettings.minImportance" })).toEqual({
      id: "sourceRelationSettings.minImportance",
      value: calibrated
    });
    const app = await settings.getApp();
    expect(app.sourceRelationSettings.minImportance).toBe(calibrated);
    expect(app.sourceRelationSettings.maxRelationsPerPair).toBe(2);
    await reset.reset({ id: "relationTypeSimilarityThreshold" });
    expect((await settings.getApp()).relationTypeSimilarityThreshold).toBe(0.92);
  });

  it("matching-preset: selects the Recommended preset and keeps the saved ones", async () => {
    const { reset, settings } = await setup();
    // A value away from the calibration makes the library select a custom preset of its own.
    await settings.updateApp({ relationTypeSimilarityThreshold: 0.5 });
    const selected = (await settings.getApp()).activeMatchingPresetId;
    expect(selected).not.toBe(recommendedMatchingPresetId);
    expect(await described(reset, "activeMatchingPresetId")).toMatchObject({
      value: selected,
      default: recommendedMatchingPresetId,
      changed: true
    });
    expect(await reset.reset({ id: "activeMatchingPresetId" })).toEqual({
      id: "activeMatchingPresetId",
      value: recommendedMatchingPresetId
    });
    const app = await settings.getApp();
    expect(app.relationTypeSimilarityThreshold).toBe(0.92);
    expect(app.matchingPresets.length).toBeGreaterThan(0);
  });

  it("storage-setting: puts the managed folder back, and the settings service announces it", async () => {
    const { reset, settings, events } = await setup();
    await settings.update({ managedRoot: "Notes" });
    events.length = 0;
    expect(await reset.reset({ id: "managedRoot" })).toEqual({
      id: "managedRoot",
      value: "Memora"
    });
    expect((await settings.get()).managedRoot).toBe("Memora");
    expect(settingsEvents(events)).toEqual([
      { type: "settings.changed", stores: ["storage"], keys: ["managedRoot"] }
    ]);
  });

  it("storage-setting: forgets the vault only where the writer's own validation allows it", async () => {
    const { reset, settings } = await setup();
    await settings.update({ obsidianVaultPath: "/Users/me/Vault", obsidianSyncEnabled: true });
    // Sync is on: the writer refuses a vault-less library, and so does the reset.
    await expect(reset.reset({ id: "obsidianVaultPath" })).rejects.toThrow(
      "errors.common.validationFailed"
    );
    expect((await settings.get()).obsidianVaultPath).toBe("/Users/me/Vault");
    await reset.reset({ id: "obsidianSync" });
    expect(await reset.reset({ id: "obsidianVaultPath" })).toEqual({
      id: "obsidianVaultPath",
      value: null
    });
    expect((await settings.get()).obsidianVaultPath).toBeNull();
  });

  it("obsidian-sync and upload-copies: switch the merged controls off together", async () => {
    const { reset, settings } = await setup();
    await settings.update({
      obsidianVaultPath: "/Users/me/Vault",
      obsidianSyncEnabled: true,
      obsidianSyncPaused: true,
      uploadCopiesEnabled: true,
      uploadCopiesFolderPath: "/Users/me/Copies"
    });
    expect(await reset.reset({ id: "obsidianSync" })).toEqual({ id: "obsidianSync", value: "off" });
    expect(await reset.reset({ id: "uploadCopies" })).toEqual({ id: "uploadCopies", value: false });
    const storage = await settings.get();
    expect(storage).toMatchObject({
      obsidianSyncEnabled: false,
      obsidianSyncPaused: false,
      uploadCopiesEnabled: false,
      uploadCopiesFolderPath: null
    });
  });

  it("book-lookup: turns the lookup on with the automatic provider", async () => {
    const { reset, settings } = await setup();
    await settings.updateApp({
      metadataEnrichmentEnabled: false,
      bookMetadataProvider: "google-books"
    });
    expect(await reset.reset({ id: "bookLookup" })).toEqual({ id: "bookLookup", value: "auto" });
    expect(await settings.getApp()).toMatchObject({
      metadataEnrichmentEnabled: true,
      bookMetadataProvider: "auto"
    });
  });

  it("knowledge-control: writes through the controls service and announces the store", async () => {
    const { reset, world, published, treeShapeChanged } = await setup();
    world.state.controls = { ...world.state.controls, paused: true, treeShape: "fine" } as never;
    expect(await reset.reset({ id: "knowledge.controls.v1.paused" })).toEqual({
      id: "knowledge.controls.v1.paused",
      value: defaultKnowledgeControls.paused
    });
    expect(world.controls.update).toHaveBeenCalledWith({ paused: defaultKnowledgeControls.paused });
    expect(published).toEqual([
      {
        type: "settings.changed",
        stores: ["knowledge.controls"],
        keys: ["knowledge.controls.v1.paused"]
      }
    ]);
    expect(AppEventSchema.safeParse(published[0]).success).toBe(true);
    expect(treeShapeChanged).not.toHaveBeenCalled();
    await reset.reset({ id: "knowledge.controls.v1.treeShape" });
    expect(treeShapeChanged).toHaveBeenCalledTimes(1);
  });

  it("ai-preset: applies the recommended setup without testing it, and announces the AI store", async () => {
    const { reset, world, published } = await setup();
    world.state.preset = "local";
    const result = await reset.reset({ id: "ai.preset.v1" });
    expect(SettingsResetResultSchema.safeParse(result).success).toBe(true);
    expect(result).toEqual({ id: "ai.preset.v1", value: "hybrid" });
    expect(world.ai.applyPreset).toHaveBeenCalledWith({ preset: "hybrid", test: false });
    expect(published).toEqual([
      { type: "settings.changed", stores: ["ai"], keys: ["ai.preset.v1"] }
    ]);
  });

  it("ai-preset: writes nothing when the setup is blocked, and says why", async () => {
    const { reset, world, published } = await setup();
    world.state.preset = "local";
    world.state.blockedSetups = true;
    await expect(reset.reset({ id: "ai.preset.v1" })).rejects.toThrow(
      "errors.ai.noCompatibleModel"
    );
    expect(world.state.preset).toBe("local");
    expect(published).toEqual([]);
  });

  it("ai-route: applies the setup again, the one the person chose or else the recommended one", async () => {
    const { reset, world } = await setup();
    world.state.preset = "custom";
    expect(await reset.reset({ id: "ai.route.write-quality" })).toEqual({
      id: "ai.route.write-quality",
      value: "profile-from-setup"
    });
    expect(world.ai.applyPreset).toHaveBeenLastCalledWith({ preset: "hybrid", test: false });
    expect(world.state.preset).toBe("hybrid");
    expect(await described(reset, "ai.route.judge")).toMatchObject({ changed: false });
  });

  it("decider-mode and decisions-opt-in: clear the mode and turn the opt-in off", async () => {
    const { reset, world } = await setup();
    world.state.deciderMode = "generative";
    world.state.decisionsEnabled = true;
    expect(await reset.reset({ id: "relations.deciderMode" })).toEqual({
      id: "relations.deciderMode",
      value: null
    });
    expect(world.ai.setDeciderMode).toHaveBeenCalledWith(null);
    expect(await reset.reset({ id: "relations.decisions" })).toEqual({
      id: "relations.decisions",
      value: false
    });
    expect(world.ai.setDecisionsEnabled).toHaveBeenCalledWith(false);
  });

  it("credential: removes a key through its own writer and never reads it", async () => {
    const { reset, world, pool, credentials } = await setup();
    world.state.decisionsKey = true;
    world.state.googleBooks = true;
    pool.rows.set("local-models.repository-token-ref", "ai:token-ref");
    expect(await reset.reset({ id: "ai:decisions-openai-platform" })).toEqual({
      id: "ai:decisions-openai-platform",
      value: null
    });
    expect(world.ai.removeDecisionsKey).toHaveBeenCalledTimes(1);
    expect(await reset.reset({ id: "metadata:google-books" })).toMatchObject({ value: null });
    expect(world.googleBooks.updateGoogleBooksKey).toHaveBeenCalledWith(null);
    expect(await reset.reset({ id: "local-models.repository-token-ref" })).toMatchObject({
      value: null
    });
    expect(credentials.remove).toHaveBeenCalledWith("ai:token-ref");
    expect(pool.rows.has("local-models.repository-token-ref")).toBe(false);
  });

  it("credential: a provider's key leaves with the providers of its kind", async () => {
    const { reset, world } = await setup();
    expect(await reset.reset({ id: "ai.provider.openai-compatible" })).toMatchObject({
      value: null
    });
    expect(world.ai.deleteProvider).toHaveBeenCalledTimes(1);
    expect(world.ai.deleteProvider).toHaveBeenCalledWith("p-compat");
    expect(world.state.providers.map((provider) => provider.id)).toEqual(["p-google"]);
  });

  it("obsidian-wiki-scope: empties the sources or restores the descendants, each alone", async () => {
    const { reset, world, published } = await setup();
    world.state.scope = { sourceIds: ["a", "b"], includeDescendants: false };
    expect(await reset.reset({ id: "obsidian.wiki.includeDescendants" })).toEqual({
      id: "obsidian.wiki.includeDescendants",
      value: true
    });
    expect(world.state.scope).toEqual({ sourceIds: ["a", "b"], includeDescendants: true });
    expect(await reset.reset({ id: "obsidian.wiki.scope" })).toEqual({
      id: "obsidian.wiki.scope",
      value: null
    });
    expect(world.state.scope).toEqual({ sourceIds: [], includeDescendants: true });
    expect(published.map((event) => event)).toEqual([
      {
        type: "settings.changed",
        stores: ["obsidian"],
        keys: ["obsidian.wiki.includeDescendants"]
      },
      { type: "settings.changed", stores: ["obsidian"], keys: ["obsidian.wiki.scope"] }
    ]);
  });

  it("obsidian-layout: prepares the journaled migration and leaves the vault as it is", async () => {
    const { reset, world, published } = await setup();
    world.state.layout = { version: 2, language: "fr", attachments: "copy" };
    expect(await reset.reset({ id: "obsidian.layout.attachments" })).toEqual({
      id: "obsidian.layout.attachments",
      value: "copy",
      pending: true
    });
    expect(world.layoutMigration.preview).toHaveBeenLastCalledWith({
      version: 2,
      language: "fr",
      attachments: "omit"
    });
    expect(await reset.reset({ id: "obsidian.layout.language" })).toMatchObject({
      value: "fr",
      pending: true
    });
    expect(world.layoutMigration.preview).toHaveBeenLastCalledWith({
      version: 2,
      language: "pt-BR",
      attachments: "copy"
    });
    expect(published.map((event) => event.type)).toEqual(["settings.changed", "settings.changed"]);
  });

  it("stops with a missing configuration when the service a setting needs is not there", async () => {
    const { ports } = await setup();
    const closed = new SettingsReset({ ...ports, knowledgeControls: () => null });
    await expect(closed.reset({ id: "knowledge.controls.v1.paused" })).rejects.toThrow(
      "errors.common.missingConfiguration"
    );
  });
});

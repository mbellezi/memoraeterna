import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsService, parseSavedAppSettings } from "./settings-service.js";
import { defaultAppSettings } from "../../shared/ipc";
const paths: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

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

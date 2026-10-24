import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  matchingValueControlIds,
  recommendedMatchingConfiguration,
  defaultKnowledgeControls
} from "@app/domain";
import { describe, expect, it } from "vitest";

import { appSettingsSchema, storageSettingsSchema } from "../shared/ipc";
import {
  knowledgeControlDomIds,
  matchingControlDomIds,
  settingsRegistry,
  settingsScopeIds,
  visibleAutomationSettings,
  type SettingEntry
} from "../shared/settings-registry";

// The settings cut (F4 T98, D33, E7), checked statically: the registry lists every persisted
// setting; the automation controls outside an Advanced disclosure are the six Knowledge controls;
// no stored key lacks a production reader; the settings T68 marked dead are gone.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const word = (needle: string) => new RegExp(`(?<![A-Za-z0-9_])${needle}(?![A-Za-z0-9_])`, "u");

/** Production sources under `apps/*` and `packages/*` (no tests, no scripts, no build output). */
function productionSources(): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(join(root, directory))) {
      const path = `${directory}/${name}`;
      if (name === "node_modules" || name === "dist" || name === "out" || name === "scripts")
        continue;
      if (statSync(join(root, path)).isDirectory()) visit(path);
      else if (
        /\.(ts|tsx)$/u.test(name) &&
        !/\.(test|spec|sidecar\.test)\.tsx?$/u.test(name) &&
        !name.startsWith("verify-")
      )
        found.push(path);
    }
  };
  for (const workspace of ["apps", "packages"])
    for (const name of readdirSync(join(root, workspace))) {
      const source = `${workspace}/${name}/src`;
      if (existsSync(join(root, source))) visit(source);
    }
  return found;
}

const idsOf = (entries: readonly SettingEntry[]) => entries.map((entry) => entry.id);

describe("E7: the settings that change what the app does by itself", () => {
  it("shows at most six outside an Advanced disclosure, and they are the Knowledge controls", () => {
    const visible = visibleAutomationSettings();
    expect(visible.length).toBeLessThanOrEqual(6);
    expect(idsOf(visible).sort()).toEqual(
      Object.keys(defaultKnowledgeControls)
        .map((field) => `knowledge.controls.v1.${field}`)
        .sort()
    );
    for (const entry of visible) {
      expect(entry.scope, entry.id).toBe("knowledge");
      expect(entry.placement, entry.id).toBe("knowledge");
    }
  });

  it("keeps every other automation setting inside Advanced", () => {
    const hidden = settingsRegistry.filter(
      (entry) => entry.category === "automation" && !visibleAutomationSettings().includes(entry)
    );
    // The 16 matching values, the preset selector and its saved list, the summary and graph limits,
    // keep-loaded and the decider mode.
    expect(hidden.length).toBe(16 + 2 + 3 + 2);
    for (const entry of hidden) expect(entry.placement, entry.id).toBe("advanced");
  });

  it("puts the 17 matching controls and the two preset keys in Advanced › Matching (Q4)", () => {
    const matching = settingsRegistry.filter(
      (entry) =>
        (matchingValueControlIds as readonly string[]).includes(entry.id) ||
        entry.id === "activeMatchingPresetId" ||
        entry.id === "matchingPresets"
    );
    expect(matching).toHaveLength(16 + 2);
    for (const entry of matching) {
      expect(entry.store, entry.id).toBe("app.preferences");
      expect(entry.category, entry.id).toBe("automation");
      expect(entry.placement, entry.id).toBe("advanced");
      expect(entry.scope, entry.id).toBe("knowledge");
    }
    expect(Object.keys(matchingControlDomIds).sort()).toEqual([...matchingValueControlIds].sort());
    expect(new Set(Object.values(matchingControlDomIds)).size).toBe(16);
  });

  it("gives every control one DOM id and every scope a name the screen has", () => {
    const scopes: readonly string[] = settingsScopeIds;
    for (const entry of settingsRegistry)
      if (entry.scope !== null) expect(scopes, entry.id).toContain(entry.scope);
    expect(Object.values(knowledgeControlDomIds)).toHaveLength(6);
    expect(scopes).not.toContain("matching");
    expect(scopes).toContain("knowledge");
    const registered = new Set(idsOf(settingsRegistry));
    expect(registered.size).toBe(settingsRegistry.length);
  });
});

describe("no stored setting lacks a reader", () => {
  it("lists every key of the stored app preferences and the storage settings", () => {
    const ids = new Set(idsOf(settingsRegistry));
    const covered = (key: string) =>
      ids.has(key) || [...ids].some((id) => id.startsWith(`${key}.`));
    for (const key of Object.keys(appSettingsSchema.shape)) expect(covered(key), key).toBe(true);
    for (const key of Object.keys(storageSettingsSchema.shape))
      expect(covered(key), key).toBe(true);
    // The nested matching objects: every member has its own row.
    for (const group of [
      "atomicNoteMatchingSettings",
      "canonicalMatchingSettings",
      "sourceRelationSettings"
    ] as const)
      for (const member of Object.keys(recommendedMatchingConfiguration[group]))
        expect(ids.has(`${group}.${member}`), `${group}.${member}`).toBe(true);
  });

  it("has a production reader for each row: the file exists and names the setting", () => {
    for (const entry of settingsRegistry) {
      expect(entry.reader, entry.id).not.toMatch(/\.(test|spec)\.tsx?$/u);
      expect(existsSync(join(root, entry.reader)), `${entry.id}: ${entry.reader}`).toBe(true);
      const reader = read(entry.reader);
      const defined = entry.defined ? read(entry.defined) : reader;
      if (entry.id.startsWith("knowledge.controls.v1.")) {
        expect(defined, entry.id).toContain("knowledge.controls.v1");
        expect(reader, entry.id).toMatch(word(entry.id.split(".").at(-1)!));
      } else if (entry.store === "settings" || entry.store === "credential") {
        // A key family (`obsidian.layout.presence.<client>`) is spelled by its prefix.
        expect(defined, entry.id).toContain(entry.id);
      } else {
        expect(reader, entry.id).toMatch(word(entry.id.split(".").at(-1)!));
      }
    }
  });

  it("registers every versioned settings key the production code spells", () => {
    const ids = idsOf(settingsRegistry);
    const known = {
      has: (key: string) => ids.some((id) => id === key || id.startsWith(`${key}.`))
    };
    const spelled = new Set<string>();
    for (const path of productionSources())
      // One segment or more before the version: `onboarding.v1` as well as `knowledge.controls.v1`.
      for (const match of read(path).matchAll(/"([a-z][A-Za-z-]*(?:\.[A-Za-z0-9-]+)*\.v\d)"/gu))
        spelled.add(match[1]!);
    const missing = [...spelled].filter((key) => !known.has(key)).sort();
    expect(missing).toEqual([]);
  });

  it("no longer carries the settings T68 found dead", () => {
    for (const dead of ["wikiTreeWidth", "deletionPolicy"]) {
      expect(Object.keys(appSettingsSchema.shape)).not.toContain(dead);
      expect(Object.keys(storageSettingsSchema.shape)).not.toContain(dead);
      expect(idsOf(settingsRegistry)).not.toContain(dead);
      const users = productionSources().filter((path) => word(dead).test(read(path)));
      expect(users, dead).toEqual([]);
    }
    // The copy of the removed control goes with it, in every locale.
    for (const locale of ["en", "pt-BR", "it", "fr", "es"]) {
      const copy = read(`packages/i18n/src/locales/${locale}.json`);
      expect(copy, locale).not.toContain("deletePolicies");
      expect(copy, locale).not.toContain("deletePolicyDescriptions");
      expect(copy, locale).not.toContain("obsidianDeletePolicy");
    }
  });
});

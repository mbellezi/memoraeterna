import { createTranslator, messages, supportedLanguageCodes, type MessageKey } from "@app/i18n";
import { describe, expect, it } from "vitest";

import { settingsRegistryV2, settingSlug } from "../../shared/settings-registry";
import { searchSettings } from "../../shared/settings-search";
import { settingsSectionIds as routeSections } from "../workspace/route";
import {
  addressIdOf,
  changedCounts,
  changedIn,
  defaultText,
  describeIndexOf,
  entryForAddress,
  groupHits,
  groupsOf,
  hitCounts,
  labelParts,
  sectionMeta,
  settingSelector,
  settingsSectionIds,
  settingsState,
  valueText
} from "./settings-model";

const en = createTranslator("en");
const pt = createTranslator("pt-BR");
const entry = (id: string) => settingsRegistryV2.find((candidate) => candidate.id === id)!;
const described = (id: string, value: unknown, def: unknown, changed: boolean) => ({
  id,
  value: value as never,
  default: def as never,
  changed
});

describe("the sections", () => {
  it("are the seven of the route, each with a name and a description in every locale", () => {
    expect([...settingsSectionIds]).toEqual([...routeSections]);
    expect(settingsSectionIds).toHaveLength(7);
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      for (const id of settingsSectionIds) {
        const meta = sectionMeta[id];
        expect(t(meta.name).trim(), `${locale} ${id}`).not.toBe("");
        expect(t(meta.description).trim(), `${locale} ${id}`).not.toBe("");
      }
    }
  });

  it("list each group of the registry once, in the order the registry names them", () => {
    for (const id of settingsSectionIds) {
      const groups = groupsOf(id);
      expect(groups.length, id).toBeGreaterThan(0);
      expect(new Set(groups.map((group) => group.group)).size).toBe(groups.length);
      expect(groups.flatMap((group) => group.entries)).toHaveLength(
        settingsRegistryV2.filter((candidate) => candidate.section === id).length
      );
    }
    expect(groupsOf("general").map((group) => group.group)).toEqual(["language", "appearance"]);
  });
});

describe("the changed counts", () => {
  const index = describeIndexOf([
    described("contentLanguage", "en", "pt-BR", true),
    described("themeMode", "system", "system", false),
    described("obsidianSync", "on", "off", true),
    described("obsidianVaultPath", true, null, true)
  ]);

  it("count per section only what differs, and list those entries in the registry's order", () => {
    expect(changedCounts(index)).toEqual({
      general: 1,
      ai: 0,
      knowledge: 0,
      library: 0,
      integrations: 2,
      privacy: 0,
      advanced: 0
    });
    expect(changedIn("integrations", index).map((e) => e.id)).toEqual([
      "obsidianVaultPath",
      "obsidianSync"
    ]);
  });
});

describe("the search results", () => {
  it("group by section, the best hit's section first, and count per section", () => {
    const hits = searchSettings("idioma", "pt-BR");
    const groups = groupHits(hits);
    expect(groups[0]?.hits[0]).toBe(hits[0]);
    expect(groups.flatMap((group) => group.hits)).toHaveLength(hits.length);
    expect(new Set(groups.map((group) => group.section)).size).toBe(groups.length);
    const counts = hitCounts(hits);
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(hits.length);
  });

  it("cut a label into the matched and the other parts and ignore a range that does not fit", () => {
    expect(labelParts("Idioma das notas", [[0, 6]])).toEqual([
      { text: "Idioma", hit: true },
      { text: " das notas", hit: false }
    ]);
    expect(
      labelParts("Limite mensal", [
        [0, 6],
        [7, 13]
      ])
    ).toEqual([
      { text: "Limite", hit: true },
      { text: " ", hit: false },
      { text: "mensal", hit: true }
    ]);
    expect(labelParts("Tema", [[2, 99]])).toEqual([{ text: "Tema", hit: false }]);
    expect(labelParts("Tema", [])).toEqual([{ text: "Tema", hit: false }]);
  });
});

describe("the state of the frame", () => {
  it("is what the search shows while one is typed, and what the read says otherwise", () => {
    expect(settingsState({ load: "loading", query: "", hits: 0 })).toBe("loading");
    expect(settingsState({ load: "error", query: "", hits: 0 })).toBe("error");
    expect(settingsState({ load: "ready", query: "  ", hits: 0 })).toBe("success");
    expect(settingsState({ load: "ready", query: "tema", hits: 2 })).toBe("success");
    expect(settingsState({ load: "ready", query: "zzz", hits: 0 })).toBe("empty");
    // A search over the registry does not wait for the values.
    expect(settingsState({ load: "loading", query: "tema", hits: 1 })).toBe("success");
    expect(settingsState({ load: "error", query: "zzz", hits: 0 })).toBe("empty");
  });
});

describe("the words of a value", () => {
  it("say on or off for a switch, set or not for a credential, a number as it is, and no code", () => {
    const sw = entry("debugMode");
    expect(valueText(en, sw, described("debugMode", true, false, true))).toBe("On");
    expect(valueText(en, sw, described("debugMode", false, false, false))).toBe("Off");
    const credential = entry("ai.provider.google");
    expect(valueText(en, credential, described(credential.id, true, null, true))).toBe("Set");
    expect(valueText(en, credential, described(credential.id, null, null, false))).toBe("Not set");
    const number = entry("knowledge.controls.v1.monthlyCapUsd");
    expect(valueText(en, number, described(number.id, 12, 5, true))).toBe("12");
    // The theme and a language are named; any other choice's code is not copy (its section says it).
    const theme = entry("themeMode");
    expect(valueText(en, theme, described("themeMode", "system", "system", false))).toBe("System");
    expect(defaultText(en, theme, described("themeMode", "dark", "system", true))).toBe("System");
    expect(valueText(en, theme, described("themeMode", "sepia", "system", true))).toBeNull();
    expect(valueText(en, theme, undefined)).toBeNull();
    const language = entry("contentLanguage");
    expect(valueText(en, language, described(language.id, "pt-BR", "en", true))).toBe(
      "Portuguese (Brazil)"
    );
    expect(defaultText(en, language, described(language.id, "pt-BR", "en", true))).toBe("English");
    expect(valueText(pt, language, described(language.id, "pt-BR", "en", true))).toBe(
      "Português (Brasil)"
    );
    expect(valueText(en, language, described(language.id, "not a code!", "en", true))).toBeNull();
    const choice = entry("activeMatchingPresetId");
    expect(valueText(en, choice, described(choice.id, "custom", "balanced", true))).toBeNull();
    expect(defaultText(en, sw, described("debugMode", true, false, true))).toBe("Off");
    expect(defaultText(en, sw, described("debugMode", true, null, true))).toBeNull();
  });
});

describe("the addresses of settings", () => {
  it("write the registry id when a fragment holds it and the flat name when it cannot", () => {
    expect(addressIdOf(entry("themeMode"))).toBe("themeMode");
    expect(addressIdOf(entry("ai:decisions-openai-platform"))).toBe("aiDecisionsOpenaiPlatform");
    expect(addressIdOf(entry("knowledge.controls.v1.paused"))).toBe("knowledge.controls.v1.paused");
  });

  it("are read back to the entry, by registry id or flat name, and an unknown one names none", () => {
    for (const candidate of settingsRegistryV2) {
      expect(entryForAddress(addressIdOf(candidate))?.id).toBe(candidate.id);
      expect(entryForAddress(settingSlug(candidate.id))?.id).toBe(candidate.id);
    }
    expect(entryForAddress("nothingLikeIt")).toBeNull();
    expect(settingSelector('a"b')).toBe('[data-setting-id="a\\"b"]');
  });
});

describe("the copy of every entry", () => {
  it("exists in each locale, so a row never shows a key", () => {
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      for (const candidate of settingsRegistryV2) {
        for (const key of [candidate.labelKey, candidate.helpKey] as MessageKey[])
          expect(t(key, { missingKeyBehavior: "throw" }).trim(), `${locale} ${key}`).not.toBe("");
      }
    }
    expect(Object.keys(messages)).toHaveLength(5);
  });

  it("has search words in every locale for every entry, and each example of the empty state finds something", () => {
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      for (const candidate of settingsRegistryV2)
        expect(
          t(`settingsShell.words.${settingSlug(candidate.id)}` as MessageKey, {
            missingKeyBehavior: "throw"
          }).trim(),
          `${locale} ${candidate.id}`
        ).not.toBe("");
      for (const key of [
        "settingsShell.search.exampleBudget",
        "settingsShell.search.exampleDark",
        "settingsShell.search.exampleObsidian",
        "settingsShell.search.examplePrivacy"
      ] as const)
        expect(searchSettings(t(key), locale).length, `${locale} ${key}`).toBeGreaterThan(0);
    }
  });
});

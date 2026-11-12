import { describe, expect, it } from "vitest";

import { foldText, searchSettings, type SettingsMessages } from "./settings-search";
import { settingsRegistryV2, type SettingEntryV2 } from "./settings-registry";

// The search over a synthetic registry and catalog: the ranking (label prefix, label word, keyword,
// help text), the folding of case and accents, English keywords in every language, and every word
// of a query having to match.
const entryOf = (
  id: string,
  section: SettingEntryV2["section"],
  keywords: string[] = []
): SettingEntryV2 => {
  const real = settingsRegistryV2[0]!;
  return {
    ...real,
    id,
    section,
    labelKey: `settingsRegistry.${id}.label`,
    helpKey: `settingsRegistry.${id}.help`,
    keywords
  };
};

const registry = [
  entryOf("language", "general", ["idioma", "locale"]),
  entryOf("theme", "general", ["dark", "night mode", "appearance"]),
  entryOf("themeNotes", "general"),
  entryOf("cap", "knowledge", ["budget", "spend", "money"]),
  entryOf("sync", "integrations", ["vault"]),
  entryOf("backup", "library")
];

const text = (label: string, help: string) => ({ label, help });
const messages = {
  en: {
    settingsRegistry: {
      language: text("App language", "Menus, buttons and messages."),
      theme: text("Theme", "Follows macOS, or pick light or dark."),
      themeNotes: text("Notes about the theme", "Where the theme is described."),
      cap: text("Monthly spending limit", "The gardener stops at this amount."),
      sync: text("Sync with Obsidian", "Writes the library into your folder."),
      backup: text("Backup", "Copies the database; the theme is not touched.")
    }
  },
  "pt-BR": {
    settingsRegistry: {
      language: text("Idioma do app", "Menus, botões e mensagens."),
      theme: text("Tema", "“Sistema” acompanha o macOS."),
      themeNotes: text("Notas sobre o tema", "Onde o tema é descrito."),
      cap: text("Limite mensal de gastos", "O Jardineiro para neste valor."),
      sync: text("Sincronizar com o Obsidian", "Escreve a biblioteca na sua pasta."),
      backup: text("Cópia de segurança", "Copia o banco de dados.")
    }
  },
  it: {},
  fr: {},
  es: {}
} as unknown as SettingsMessages;

const ids = (query: string, locale: "en" | "pt-BR" | "it" = "en") =>
  searchSettings(query, locale, registry, messages).map((hit) => hit.id);

describe("foldText", () => {
  it("folds case and accents and keeps every index of the original", () => {
    expect(foldText("Configuração Ação ÇÃO")).toBe("configuracao acao cao");
    expect(foldText("Idioma").length).toBe("Idioma".length);
    expect(foldText("São Paulo").length).toBe("São Paulo".length);
  });
});

describe("searchSettings", () => {
  it("ranks the label prefix, then a label word, then a keyword, then the help text", () => {
    // "theme": the label "Theme" starts with it; "Notes about the theme" has it as a word; the help
    // text of Backup names it last. Nothing has it as a keyword here.
    expect(ids("theme")).toEqual(["theme", "themeNotes", "backup"]);
    const hits = searchSettings("theme", "en", registry, messages);
    expect(hits.map((hit) => [hit.tier, hit.matchedIn])).toEqual([
      [0, "label"],
      [1, "label"],
      [3, "help"]
    ]);
    // A keyword ranks above the help text and below a label word.
    const withKeyword = [...registry, entryOf("spoken", "advanced", ["theme"])];
    const catalogWithSpoken = {
      ...messages,
      en: {
        settingsRegistry: {
          ...(messages.en as { settingsRegistry: object }).settingsRegistry,
          spoken: text("Spoken words", "Nothing here.")
        }
      }
    } as unknown as SettingsMessages;
    expect(
      searchSettings("theme", "en", withKeyword, catalogWithSpoken).map((hit) => hit.id)
    ).toEqual(["theme", "themeNotes", "spoken", "backup"]);
  });

  it('matches English keywords in any language: "dark" finds Tema in pt-BR', () => {
    expect(ids("dark", "pt-BR")).toEqual(["theme"]);
    const [hit] = searchSettings("night", "pt-BR", registry, messages);
    expect(hit).toMatchObject({ id: "theme", tier: 2, matchedIn: "keyword" });
  });

  it("folds case and accents of the query and of the label", () => {
    expect(ids("CÓPIA", "pt-BR")).toEqual(["backup"]);
    expect(ids("copia de seguranca", "pt-BR")).toEqual(["backup"]);
    expect(ids("gastos", "pt-BR")).toEqual(["cap"]);
    expect(ids("GASTOS", "pt-BR")).toEqual(["cap"]);
  });

  it("needs every word of the query, in the label, the keywords or the help text", () => {
    expect(ids("monthly limit")).toEqual(["cap"]);
    expect(ids("monthly vault")).toEqual([]);
    expect(ids("spending money")).toEqual(["cap"]);
  });

  it("returns the matched ranges of the label as written, merged", () => {
    const [hit] = searchSettings("limite mensal", "pt-BR", registry, messages);
    expect(hit).toMatchObject({
      id: "cap",
      tier: 0,
      labelRanges: [
        [0, 6],
        [7, 13]
      ]
    });
    const [accent] = searchSettings("copia", "pt-BR", registry, messages);
    expect(accent!.labelRanges).toEqual([[0, 5]]);
  });

  it("returns nothing for an empty query, punctuation or no match", () => {
    expect(ids("")).toEqual([]);
    expect(ids("   ")).toEqual([]);
    expect(ids("???")).toEqual([]);
    expect(ids("zebra")).toEqual([]);
  });

  it("falls back to English text, and to the keywords alone when the entry has no copy yet", () => {
    expect(ids("spending", "it")).toEqual(["cap"]);
    const noCopy = searchSettings("budget", "en", registry, {
      en: {},
      "pt-BR": {},
      it: {},
      fr: {},
      es: {}
    } as unknown as SettingsMessages);
    expect(noCopy.map((hit) => hit.id)).toEqual(["cap"]);
    expect(noCopy[0]).toMatchObject({ tier: 2, matchedIn: "keyword", labelRanges: [] });
  });

  it("keeps the registry's order among equal hits and groups nothing itself", () => {
    expect(ids("the").length).toBeGreaterThan(1);
    const hits = searchSettings("the", "en", registry, messages);
    expect(hits.map((hit) => hit.tier)).toEqual([...hits.map((hit) => hit.tier)].sort());
  });

  it("runs over the real registry and catalog without throwing", () => {
    expect(Array.isArray(searchSettings("tema", "pt-BR"))).toBe(true);
    expect(Array.isArray(searchSettings("budget", "en"))).toBe(true);
  });
});

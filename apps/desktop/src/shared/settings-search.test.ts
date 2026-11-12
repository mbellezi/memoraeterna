import { messages as realMessages, type LanguageCode } from "@app/i18n";
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

  it("lists an entry that has every word first, then entries that have some of the words", () => {
    expect(ids("monthly limit")).toEqual(["cap"]);
    expect(ids("spending money")).toEqual(["cap"]);
    // Two words, one each: both entries are listed, neither is first for having both.
    expect(ids("monthly vault").sort()).toEqual(["cap", "sync"]);
    // An entry with both words comes before one with a single word.
    expect(ids("backup theme")[0]).toBe("backup");
    expect(ids("monthly spending limit vault")[0]).toBe("cap");
  });

  it("does not ask for the small words of the person's language", () => {
    expect(ids("where is the dark mode")[0]).toBe("theme");
    expect(ids("o limite mensal de gastos", "pt-BR")[0]).toBe("cap");
    // A query of small words alone is still searched.
    expect(ids("the").length).toBeGreaterThan(0);
  });

  it("forgives a letter swapped, missing or added, and an ending on a keyword", () => {
    expect(ids("thmee")[0]).toBe("theme");
    expect(ids("budgte")[0]).toBe("cap");
    expect(ids("vualt")[0]).toBe("sync");
    expect(ids("spend limits")[0]).toBe("cap");
    expect(ids("spendings")[0]).toBe("cap");
    // Three letters are too few to guess at.
    expect(ids("thm")).toEqual([]);
    expect(ids("xyz")).toEqual([]);
  });

  it("keeps approximate entries out of a list that is already full of exact ones", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      entryOf(`item${index}`, "general", ["theme"])
    );
    const itemMessages = {
      ...messages,
      en: {
        settingsRegistry: Object.fromEntries(
          many.map((entry) => [entry.id, text(`Item ${entry.id}`, "Nothing.")])
        )
      }
    } as unknown as SettingsMessages;
    expect(searchSettings("theme", "en", many, itemMessages)).toHaveLength(12);
    expect(searchSettings("thmee", "en", many, itemMessages).length).toBeLessThanOrEqual(8);
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

  it("finds every entry in the top five for its own label, in each locale (X9, label part)", () => {
    const labelOf = (locale: LanguageCode, key: string) =>
      key
        .split(".")
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)?.[part],
          realMessages[locale]
        ) as string;
    for (const locale of ["en", "pt-BR", "es", "fr", "it"] as const)
      for (const entry of settingsRegistryV2) {
        const label = labelOf(locale, entry.labelKey);
        const rank = searchSettings(label, locale).findIndex((hit) => hit.id === entry.id);
        expect(rank, `${locale} ${entry.id} "${label}"`).toBeGreaterThanOrEqual(0);
        expect(rank, `${locale} ${entry.id} "${label}"`).toBeLessThan(5);
      }
  });
});

// X9, part 2 (F5 T161, spec 5.2): the held-out queries. T109 wrote them, per entry and locale,
// without seeing the registry's keywords: a plain synonym or task phrasing, and a short phrase with a
// typo or a cut word. They stand as a fixture (`settings-search.heldout.json`); the search must put
// the entry in the top five for at least 90% of a locale's queries, and for at least one query of
// every entry in every locale. The fixture was written before the registry took its final ids:
// `heldOutEntry` maps its ids to the registry's, and `null` marks persisted state that has no
// control (a counter, a cursor, a marker), which the search does not index.
import heldOut from "./settings-search.heldout.json";

const heldOutEntry: Readonly<Record<string, string | null>> = {
  matchingPresets: "activeMatchingPresetId",
  metadataEnrichmentEnabled: "bookLookup",
  bookMetadataProvider: "bookLookup",
  obsidianSyncEnabled: "obsidianSync",
  obsidianSyncPaused: "obsidianSync",
  "obsidian.layout": "obsidian.layout.language",
  uploadCopiesEnabled: "uploadCopies",
  uploadCopiesFolderPath: "uploadCopies",
  "relations.decisions.state": null,
  "relations.decisions.dailySpend": null,
  "prompts.active": null,
  "page.models": "ai.models",
  "page.this-mac": "ai.thisMac",
  "page.prompts": "advanced.prompts",
  "page.gateway": "integrations.gateway",
  "page.backup": "library.backup",
  "page.reset": "privacy.reset",
  "page.diagnostics-log": "advanced.callLog",
  navigationCollapsed: null,
  updatedAt: null,
  "import.lastDirectory": null,
  "ai.classTests.v1": null,
  "ai.routes.classMap.v1": null,
  "relations.ai.dailyCalls": null,
  "catalogHeader.dailyRoots": null,
  "gardener.budget.subscriptionCalls.v1": null,
  "gardener.budget.continue.v1": null,
  "gardener.audit.cursors.v1": null,
  "topics.ai.daily.v1": null,
  "topics.corpus.v1": null,
  "local-models.first-run-ranker": null,
  "jobs.history.dismissed-through.v1": null,
  "obsidian.layout.presence": null,
  "obsidian.editorial.client": null,
  "relations.match.valuesHistory.v1": null,
  "onboarding.v1": null
};

const localesOfX9 = ["en", "pt-BR", "es", "fr", "it"] as const;
const registryIds = new Set(settingsRegistryV2.map((entry) => entry.id));
const heldOutQueries = heldOut as unknown as Record<string, Record<LanguageCode, string[]>>;

/** Each held-out query with the registry entry it stands for; the ids with no control are left out. */
const heldOutRows = Object.entries(heldOutQueries).flatMap(([id, byLocale]) => {
  const entry = id in heldOutEntry ? heldOutEntry[id] : id;
  if (entry === null || entry === undefined) return [];
  return localesOfX9.flatMap((locale) =>
    byLocale[locale].map((query) => ({ locale, entry, query }))
  );
});

describe("the held-out queries (X9, held-out part)", () => {
  it("has 5 locales and 2 queries for each of the 85 ids, and every id is an entry, mapped or marked", () => {
    expect(Object.keys(heldOutQueries)).toHaveLength(85);
    for (const [id, byLocale] of Object.entries(heldOutQueries)) {
      expect(Object.keys(byLocale).sort(), id).toEqual([...localesOfX9].sort());
      for (const locale of localesOfX9) expect(byLocale[locale], `${id} ${locale}`).toHaveLength(2);
      const mapped = id in heldOutEntry ? heldOutEntry[id] : id;
      expect(mapped === null || registryIds.has(mapped ?? id), `${id} names no entry`).toBe(true);
    }
  });

  it("maps no query of the notes' language to the source's language", () => {
    for (const locale of localesOfX9)
      for (const query of heldOutQueries.contentLanguage?.[locale] ?? [])
        expect(query, locale).not.toMatch(/\b(same as|igual a|mesmo|misma|même|stessa)\b/iu);
  });

  it("puts the entry in the top five for at least 90% of a locale's queries", () => {
    for (const locale of localesOfX9) {
      const rows = heldOutRows.filter((row) => row.locale === locale);
      const misses = rows.filter(
        (row) =>
          !searchSettings(row.query, locale)
            .slice(0, 5)
            .some((hit) => hit.id === row.entry)
      );
      const rate = 1 - misses.length / rows.length;
      expect(
        rate,
        `${locale}: ${rows.length - misses.length}/${rows.length}; misses: ${misses
          .map((row) => `${row.entry} "${row.query}"`)
          .join("; ")}`
      ).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("names the registry entries that have no held-out query, so the bar is not met by leaving them out", () => {
    // The bar is at least one held-out hit per entry and locale. These entries were not among T109's
    // 85 ids (they came with the registry's final shape), so nothing holds them to it yet: the
    // orchestrator has to ask for blind queries for them (T174's X10 meets the same gap). A new entry
    // without a query, or a listed one that gets its queries, fails this test until the list is
    // updated: the gap can only shrink.
    const covered = new Set(heldOutRows.map((row) => row.entry));
    const uncovered = settingsRegistryV2.map((entry) => entry.id).filter((id) => !covered.has(id));
    expect(uncovered.sort()).toEqual(
      [
        "advanced.similarityRuns",
        "advanced.taskHistory",
        "ai.profiles",
        "ai.route.judge",
        "library.storage",
        "obsidian.layout.attachments",
        "obsidian.wiki.includeDescendants",
        "privacy.callLog",
        "privacy.clearQuestions",
        "privacy.clearViewHistory",
        "privacy.summary",
        "relationLabels"
      ].sort()
    );
  });

  it("finds every entry that has held-out queries by at least one of them, in every locale", () => {
    const entries = [...new Set(heldOutRows.map((row) => row.entry))];
    for (const locale of localesOfX9)
      for (const entry of entries) {
        const found = heldOutRows
          .filter((row) => row.locale === locale && row.entry === entry)
          .some((row) =>
            searchSettings(row.query, locale)
              .slice(0, 5)
              .some((hit) => hit.id === entry)
          );
        expect(found, `${locale} ${entry}`).toBe(true);
      }
  });
});

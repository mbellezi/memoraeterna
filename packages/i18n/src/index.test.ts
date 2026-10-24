import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createTranslator,
  defaultLanguageCode,
  getLanguageDisplayName,
  messages,
  supportedLanguageCodes,
  translate,
  type MessageKey
} from "./index.js";

describe("@app/i18n", () => {
  it("displays content language names in the interface locale", () => {
    expect(getLanguageDisplayName("pt-BR", "en")).toBe("inglês");
    expect(getLanguageDisplayName("en", "pt-BR")).toBe("Brazilian Portuguese");
    expect(getLanguageDisplayName("pt-BR", "nl")).toBe("holandês");
    for (const locale of supportedLanguageCodes) {
      for (const code of ["en", "pt-BR", "it", "fr", "es", "de", "ja", "zh", "ar"]) {
        expect(getLanguageDisplayName(locale, code)).not.toBe(code);
      }
      expect(getLanguageDisplayName(locale, "und")).toBe(
        messages[locale].import.unspecifiedLanguage
      );
    }
  });

  it("preserves unrecognized metadata language values without crashing", () => {
    expect(getLanguageDisplayName("en", "not_a_language")).toBe("not_a_language");
    expect(getLanguageDisplayName("en", "zz")).toBe("zz");
  });

  it("falls back to en for unsupported locales", () => {
    const translator = createTranslator("de");

    expect(translator.locale).toBe(defaultLanguageCode);
    expect(translator("app.title")).toBe(messages.en.app.title);
  });

  it("normalizes desktop locales with regions", () => {
    expect(createTranslator("fr-FR").locale).toBe("fr");
    expect(createTranslator("es_MX").locale).toBe("es");
    expect(createTranslator("pt-PT").locale).toBe("pt-BR");
    expect(createTranslator("en-US").locale).toBe("en");
  });

  it("interpolates simple values", () => {
    expect(
      translate("en", "jobs.progress.processingSource", {
        values: {
          title: "Example"
        }
      })
    ).toBe(messages.en.jobs.progress.processingSource.replace("{title}", "Example"));
  });

  it("returns an explicit marker for missing keys and can throw", () => {
    const missingKey = "app.missing" as MessageKey;

    expect(translate("en", missingKey)).toBe("[[missing:app.missing]]");
    expect(() => translate("en", missingKey, { missingKeyBehavior: "throw" })).toThrow(
      "app.missing"
    );
  });

  it("keeps the application menu and recents copy complete with the same placeholders", () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    for (const namespace of ["menu", "viewHistory"] as const) {
      const source = namespace === "menu" ? messages.en.app.menu : messages.en.viewHistory;
      const flat = (value: object, prefix = ""): Array<[string, string]> =>
        Object.entries(value).flatMap(([key, child]) =>
          typeof child === "string"
            ? [[`${prefix}${key}`, child] as [string, string]]
            : flat(child as object, `${prefix}${key}.`)
        );
      const expected = flat(source);
      for (const locale of supportedLanguageCodes) {
        const actual = new Map(
          flat(namespace === "menu" ? messages[locale].app.menu : messages[locale].viewHistory)
        );
        expect([...actual.keys()].sort()).toEqual(expected.map(([key]) => key).sort());
        for (const [key, text] of expected) {
          expect(actual.get(key), `${locale} ${namespace}.${key}`).toBeTruthy();
          expect(placeholders(actual.get(key)!).sort()).toEqual(placeholders(text).sort());
        }
      }
    }
  });

  it("keeps the matching settings copy complete in every locale, without the retired settings", () => {
    const flat = (value: object, prefix = ""): string[] =>
      Object.entries(value).flatMap(([key, child]) =>
        typeof child === "string" ? [`${prefix}${key}`] : flat(child as object, `${prefix}${key}.`)
      );
    const expected = flat(messages.en.settings.matching).sort();
    const retired = [
      "minimumScore",
      "moreRelations",
      "fewerRelations",
      ...[
        "textCandidateLimit",
        "vectorCandidateLimit",
        "graphCandidateLimit",
        "fusedCandidateLimit",
        "minimumGraphOnlyCandidates",
        "reciprocalRankConstant",
        "maxRelationsPerNote",
        "minRerankScore",
        "requireReranking",
        "includeWeakTypes",
        "withEmbeddingAndGraph",
        "withEmbedding",
        "withGraph",
        "textAndMetadata",
        "rerankerWeight",
        "resetNotes",
        "weights",
        "weightsHint",
        "invalidWeights",
        "validationHint"
      ].map((key) => `advanced.${key}`)
    ];
    for (const locale of supportedLanguageCodes) {
      const keys = flat(messages[locale].settings.matching).sort();
      expect(keys, locale).toEqual(expected);
      for (const key of retired) expect(keys, `${locale} ${key}`).not.toContain(key);
      expect(messages[locale].settings.dashboard.summary.knowledgeMatching, locale).toBeTruthy();
    }
    expect(messages.en.settings.matching.advanced.maxRerankOutputTokens).toBeTruthy();
  });

  it("keeps the onboarding copy complete in every locale with the same placeholders", () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    const flat = (value: object, prefix = ""): Array<[string, string]> =>
      Object.entries(value).flatMap(([key, child]) =>
        typeof child === "string"
          ? [[`${prefix}${key}`, child] as [string, string]]
          : flat(child as object, `${prefix}${key}.`)
      );
    const expected = flat(messages.en.onboarding);
    expect(expected.length).toBeGreaterThan(100);
    for (const locale of supportedLanguageCodes) {
      const actual = new Map(flat(messages[locale].onboarding));
      expect([...actual.keys()].sort(), locale).toEqual(expected.map(([key]) => key).sort());
      for (const [key, text] of expected) {
        expect(actual.get(key), `${locale} onboarding.${key}`).toBeTruthy();
        expect(placeholders(actual.get(key)!), `${locale} onboarding.${key}`).toEqual(
          placeholders(text)
        );
      }
    }
  });

  it("names the import presets as the plan's first run does, in every locale", () => {
    expect(messages.en.processing.presets).toMatchObject({
      import_only: { title: "Just store" },
      search_ready: { title: "Searchable + organized" },
      full_knowledge: { title: "Second brain" }
    });
    for (const locale of supportedLanguageCodes) {
      const presets = messages[locale].processing.presets;
      const titles = [
        presets.import_only.title,
        presets.search_ready.title,
        presets.summary.title,
        presets.full_knowledge.title
      ];
      expect(new Set(titles).size, locale).toBe(4);
      for (const title of titles) expect(title, locale).toBeTruthy();
    }
  });

  it("exports type-safe message keys and supported locales", () => {
    const key = "settings.storage.obsidianVaultPath" satisfies MessageKey;

    expectTypeOf(key).toMatchTypeOf<MessageKey>();
    expect(supportedLanguageCodes).toContain("pt-BR");

    // @ts-expect-error Unknown message keys must not be assignable.
    const invalidKey: MessageKey = "settings.storage.unknown";
    void invalidKey;
  });
});

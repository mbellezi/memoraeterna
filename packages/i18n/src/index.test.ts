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
      expect(getLanguageDisplayName(locale, "und")).toBe(messages[locale].import.unspecifiedLanguage);
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

  it("exports type-safe message keys and supported locales", () => {
    const key = "settings.storage.obsidianVaultPath" satisfies MessageKey;

    expectTypeOf(key).toMatchTypeOf<MessageKey>();
    expect(supportedLanguageCodes).toContain("pt-BR");

    // @ts-expect-error Unknown message keys must not be assignable.
    const invalidKey: MessageKey = "settings.storage.unknown";
    void invalidKey;
  });
});

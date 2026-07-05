import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createTranslator,
  defaultLanguageCode,
  messages,
  supportedLanguageCodes,
  translate,
  type MessageKey
} from "./index.js";

describe("@app/i18n", () => {
  it("falls back to en for unsupported locales", () => {
    const translator = createTranslator("de");

    expect(translator.locale).toBe(defaultLanguageCode);
    expect(translator("app.title")).toBe(messages.en.app.title);
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

import { afterEach, describe, expect, it } from "vitest";

import { screenLocale, screenTranslator } from "./screen-locale";

const set = (value: unknown) => {
  (globalThis as { __screenLocale?: unknown }).__screenLocale = value;
};

describe("the language of a screen module", () => {
  afterEach(() => set(undefined));

  it("is English until the screens tool sets another one", () => {
    expect(screenLocale()).toBe("en");
    expect(screenTranslator().locale).toBe("en");
  });

  it("hands the components the app's own translator in the requested language", () => {
    set("pt-BR");
    const t = screenTranslator();
    expect(t.locale).toBe("pt-BR");
    expect(t("workspace.rail.library")).not.toBe("Library");
    expect(t("workspace.rail.library")).toBe("Biblioteca");
    set("fr");
    expect(screenTranslator().locale).toBe("fr");
  });

  it("falls back to English for a value that is not a language the app ships", () => {
    set("tlh");
    expect(screenLocale()).toBe("en");
    set(42);
    expect(screenLocale()).toBe("en");
  });
});

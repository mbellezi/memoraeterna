import { appLanguageCodes } from "../../shared/ipc";
import { describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => [] as Array<{ run: () => void; deps: readonly unknown[] }>);

// Effects do not run without a DOM: capture them to run what the hook registers.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (run: () => void, deps: readonly unknown[]) => {
    effects.push({ run, deps });
  }
}));

import { applyDocumentLanguage, useDocumentLanguage } from "./document-language";

describe("applyDocumentLanguage", () => {
  it("marks the document with each interface language as a BCP 47 tag", () => {
    for (const language of appLanguageCodes) {
      const root = { lang: "en" };
      applyDocumentLanguage(root, language);
      expect(root.lang).toBe(language);
      expect(() => new Intl.Locale(root.lang)).not.toThrow();
    }
  });

  it("does not write a language the document already has", () => {
    let writes = 0;
    let value = "pt-BR";
    const root = {
      get lang() {
        return value;
      },
      set lang(next: string) {
        writes += 1;
        value = next;
      }
    };
    applyDocumentLanguage(root, "pt-BR");
    expect(writes).toBe(0);
    applyDocumentLanguage(root, "it");
    expect(writes).toBe(1);
  });
});

describe("useDocumentLanguage", () => {
  it("sets <html lang> from the interface language, and again whenever it changes", () => {
    const documentElement = { lang: "en" };
    vi.stubGlobal("document", { documentElement });
    try {
      effects.length = 0;
      useDocumentLanguage("pt-BR");
      useDocumentLanguage("fr");
      // One effect per render, each keyed on the language it was given.
      expect(effects.map((effect) => effect.deps)).toEqual([["pt-BR"], ["fr"]]);
      effects[0]!.run();
      expect(documentElement.lang).toBe("pt-BR");
      effects[1]!.run();
      expect(documentElement.lang).toBe("fr");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

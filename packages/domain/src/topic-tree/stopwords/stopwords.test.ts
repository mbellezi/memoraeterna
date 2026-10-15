import { describe, expect, it } from "vitest";

import {
  foldTerm,
  guessLanguage,
  sameContentLanguage,
  stopwordSet,
  tokenize,
  topicNamingLanguageOf,
  topicNamingLanguages
} from "./index.js";

describe("stopwords of the five content languages", () => {
  it("has a substantial folded list for every language", () => {
    for (const language of topicNamingLanguages) {
      expect(stopwordSet(language).size, language).toBeGreaterThan(150);
    }
    expect(stopwordSet("pt").has("nao")).toBe(true);
    expect(stopwordSet("pt").has("não")).toBe(false);
    expect(stopwordSet("en").has("the")).toBe(true);
    expect(stopwordSet("fr").has("etait")).toBe(true);
  });

  it("folds case and accents the way the I7 comparison does", () => {
    expect(foldTerm("Memória")).toBe("memoria");
    expect(foldTerm("ÉTÉ")).toBe("ete");
  });

  it("maps BCP 47 codes to a supported language and compares codes by language", () => {
    expect(topicNamingLanguageOf("pt-BR")).toBe("pt");
    expect(topicNamingLanguageOf("EN_us")).toBe("en");
    expect(topicNamingLanguageOf("und")).toBeNull();
    expect(topicNamingLanguageOf("de")).toBeNull();
    expect(topicNamingLanguageOf(null)).toBeNull();
    expect(sameContentLanguage("pt", "pt-BR")).toBe(true);
    expect(sameContentLanguage("pt-PT", "pt-br")).toBe(true);
    expect(sameContentLanguage("en", "pt-BR")).toBe(false);
    expect(sameContentLanguage("", "")).toBe(false);
  });

  it("tokenizes letters, digits and inner apostrophes", () => {
    expect(tokenize("L'homme, dell’arte e o co-autor 3D!")).toEqual([
      "l'homme",
      "dell’arte",
      "e",
      "o",
      "co-autor",
      "3d"
    ]);
  });
});

describe("the stopword language guess", () => {
  const samples: Array<[string, string]> = [
    [
      "en",
      "The practice of retrieving what you have learned improves memory more than rereading does, and it is used in many schools."
    ],
    [
      "pt",
      "A prática de recuperar o que foi aprendido melhora a memória mais do que reler, e ela é usada em muitas escolas também."
    ],
    [
      "es",
      "La práctica de recuperar lo que se ha aprendido mejora la memoria más que releer, y se usa en muchas escuelas también."
    ],
    [
      "fr",
      "La pratique de se rappeler ce que l'on a appris améliore la mémoire plus que la relecture, et elle est utilisée dans beaucoup d'écoles."
    ],
    [
      "it",
      "La pratica di richiamare ciò che si è imparato migliora la memoria più della rilettura, ed è usata in molte scuole anche."
    ]
  ];

  it.each(samples)("recognizes %s", (language, text) => {
    expect(guessLanguage(text).language).toBe(language);
  });

  it("guesses nothing from a text without enough distinctive words", () => {
    expect(guessLanguage("Machine learning").language).toBeNull();
    expect(guessLanguage("").language).toBeNull();
    expect(guessLanguage("a de la").language).toBeNull();
  });

  it("does not let words shared by several languages decide", () => {
    // "de", "que" and "la" belong to more than one list, so the Portuguese "não" decides.
    expect(guessLanguage("de que la não foi", 1, 1).language).toBe("pt");
  });
});

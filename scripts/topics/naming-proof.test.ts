import { topicNamingLanguageOf } from "@app/domain/topic-tree";
import { describe, expect, it } from "vitest";

import { languageGuessReport } from "./naming-proof.js";

const row = (lang: string, title: string, text: string) => ({ lang, title, text });

describe("the stopword guess against labelled notes", () => {
  it("counts agreement, no guess and a different guess per label", () => {
    const report = languageGuessReport(
      [
        row(
          "pt",
          "Memória",
          "A prática de recuperar o que foi aprendido melhora a memória de quem estuda."
        ),
        row("pt", "Mar", "Marés"),
        row(
          "pt",
          "Tides",
          "The tides are caused by the moon and the sun, and they follow the same cycle."
        ),
        row(
          "en",
          "Memory",
          "The practice of retrieving what has been learned improves memory more than rereading."
        ),
        row("en", "Tide", "Tides follow the moon")
      ],
      topicNamingLanguageOf
    );
    expect(report.notes).toBe(5);
    expect(report.byLabel.pt).toEqual({ notes: 3, agree: 1, noGuess: 1, other: { en: 1 } });
    expect(report.byLabel.en).toEqual({ notes: 2, agree: 1, noGuess: 1, other: {} });
    expect(report.agreement).toBe(0.4);
  });

  it("does not judge a label that is no supported language", () => {
    const report = languageGuessReport(
      [
        row(
          "xx",
          "Titel",
          "Die Praxis des Abrufs verbessert das Gedächtnis, und sie wird oft benutzt."
        )
      ],
      topicNamingLanguageOf
    );
    expect(report.byLabel.xx?.notes).toBe(1);
    expect(report.agreement).toBe(0);
  });
});

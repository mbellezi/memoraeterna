import { describe, expect, it } from "vitest";
import { AtomicNoteRelationTypeSchema } from "@app/domain";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { relationPairArrow, relationTypeView, stanceTextClass, stances } from "./relation-stance";

describe("relation pair arrow", () => {
  it("points from the subject of a directed pair and has none for an undirected one", () => {
    expect(relationPairArrow("lo_to_hi")).toBe("→");
    expect(relationPairArrow("hi_to_lo")).toBe("←");
    expect(relationPairArrow("symmetric")).toBe("↔");
    expect(relationPairArrow("unknown")).toBe("↔");
  });
});

describe("relation stance map", () => {
  it("maps every stored type and the future ones to a stance, a word, a verb and a direction", () => {
    const expected = {
      supports: ["supports", true],
      contrasts: ["contradicts", false],
      extends: ["extends", true],
      similar_to: ["related", false],
      depends_on: ["depends_on", true],
      clarifies: ["related", true],
      // Legacy `mentions` reads neutral, both ways (relations v2 vocabulary, D10).
      mentions: ["related", false],
      related: ["related", false],
      contradicts: ["contradicts", false],
      example_of: ["example_of", true],
      same_as: ["related", false]
    } as const;
    for (const type of AtomicNoteRelationTypeSchema.options) expect(expected).toHaveProperty(type);
    for (const [type, [stance, directed]] of Object.entries(expected)) {
      const view = relationTypeView(type);
      expect(view.stance, type).toBe(stance);
      expect(view.directed, type).toBe(directed);
      expect(view.wordKey).toBe(`notePage.stance.${type}`);
      expect(view.verbKey).toBe(`notePage.card.verbs.${type}`);
      expect(view.order).toBe(stances.indexOf(stance));
    }
  });

  it("reads a stored contrast as a contrast, never as a contradiction", () => {
    const t = createTranslator("pt-BR");
    expect(t(relationTypeView("contrasts").wordKey)).toBe("contrasta");
    expect(relationTypeView("contrasts").stance).toBe("contradicts");
  });

  it("maps an unknown value to related and never shows the raw value", () => {
    for (const type of ["refutes", "", "toString", "constructor"]) {
      const view = relationTypeView(type);
      expect(view.stance).toBe("related");
      expect(view.wordKey).toBe("notePage.stance.related");
      expect(view.directed).toBe(false);
    }
  });

  it("has a word and a verb in every locale and literal colour classes from tokens", () => {
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      for (const type of [
        ...AtomicNoteRelationTypeSchema.options,
        "contradicts",
        "example_of",
        "same_as"
      ]) {
        expect(t(relationTypeView(type).wordKey)).not.toContain("[[missing");
        expect(t(relationTypeView(type).verbKey)).not.toContain("[[missing");
      }
    }
    expect(stanceTextClass).toEqual({
      supports: "text-stance-supports",
      contradicts: "text-stance-contradicts",
      extends: "text-stance-extends",
      depends_on: "text-stance-depends-on",
      example_of: "text-stance-example-of",
      related: "text-stance-related"
    });
  });
});

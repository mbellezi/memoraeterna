import { describe, expect, it } from "vitest";

import { namingWorld } from "./fixtures/naming-world.js";
import type { WorldNote } from "./fixtures/naming-world.js";
import {
  fallbackScope,
  provisionalNames,
  provisionalTitleSeparator,
  topicLabelOf,
  topicOrderKey
} from "./naming-fallback.js";
import { getTopic } from "./state.js";

const ptOptions = { contentLanguage: "pt-BR", minItems: 2, maxTerms: 3 };

const pt = (text: string): WorldNote => ({ text, language: "pt-BR" });
const en = (text: string): WorldNote => ({ text, language: "en" });

/** Two sibling topics under the root: memory (Portuguese) and the sea (Portuguese and English). */
function seaAndMemory(idBase = 0) {
  return namingWorld(
    [
      { id: 1, parent: 0 },
      {
        id: 2,
        parent: 1,
        notes: [
          pt("Prática de recuperação melhora a memória de longo prazo"),
          pt("A recuperação espaçada fortalece a memória duradoura"),
          pt("Memória de trabalho e recuperação em estudantes")
        ]
      },
      {
        id: 3,
        parent: 1,
        notes: [
          pt("Correntes oceânicas transportam calor pelo oceano"),
          pt("Marés e correntes oceânicas na costa"),
          en("Ocean currents carry heat across the ocean basins"),
          en("Tides and ocean currents along the coast"),
          en("Ocean heat transport and the climate")
        ]
      }
    ],
    idBase
  );
}

describe("provisional TF-IDF names", () => {
  it("names a topic from content-language items only and never mixes languages", () => {
    const world = seaAndMemory();
    const { names, skipped } = provisionalNames(
      world.state,
      [world.topic(2), world.topic(3)],
      world.texts,
      ptOptions
    );
    expect(skipped.size).toBe(0);
    const memory = names.get(world.topic(2))!;
    const sea = names.get(world.topic(3))!;
    expect(memory.terms).toContain("memória");
    // The English notes outnumber the Portuguese ones in the sea topic and still contribute nothing.
    expect(sea.terms).toEqual(expect.arrayContaining(["correntes", "oceânicas"]));
    for (const term of sea.terms) {
      expect(term).not.toMatch(
        /^(the|ocean|tides|currents|heat|climate|basins|transport|carry|along|across|and)$/u
      );
    }
  });

  it("titles a child as Parent › terms when its parent has a label", () => {
    const world = seaAndMemory();
    getTopic(world.state, world.topic(1)).title = "Estudos";
    const { names } = provisionalNames(world.state, [world.topic(2)], world.texts, ptOptions);
    const name = names.get(world.topic(2))!;
    expect(name.title).toBe(`Estudos${provisionalTitleSeparator}${name.label}`);
    expect(name.title.startsWith("Estudos › ")).toBe(true);
  });

  it("keeps only the last segment of a provisional parent title", () => {
    const world = seaAndMemory();
    const parent = getTopic(world.state, world.topic(1));
    parent.title = "Raiz › estudos, memória";
    parent.nameSource = "tfidf";
    parent.nameState = "provisional";
    expect(topicLabelOf(parent)).toBe("estudos, memória");
    const { names } = provisionalNames(world.state, [world.topic(2)], world.texts, ptOptions);
    expect(names.get(world.topic(2))!.title.startsWith("estudos, memória › ")).toBe(true);
  });

  it("leaves a topic without enough content-language items unnamed", () => {
    const world = namingWorld([
      { id: 1, parent: 0 },
      {
        id: 2,
        parent: 1,
        notes: [
          en("Ocean currents carry heat across the ocean basins"),
          en("Tides and ocean currents along the coast"),
          pt("Marés e correntes oceânicas na costa")
        ]
      },
      { id: 3, parent: 1, notes: [pt("Recuperação e memória"), pt("Memória de longo prazo")] }
    ]);
    const { names, skipped } = provisionalNames(
      world.state,
      [world.topic(2)],
      world.texts,
      ptOptions
    );
    expect(names.size).toBe(0);
    expect(skipped.get(world.topic(2))).toBe("too_few_items");
  });

  it("reads a note whose row says und by its text", () => {
    const world = namingWorld([
      { id: 1, parent: 0 },
      {
        id: 2,
        parent: 1,
        notes: [
          { text: "A recuperação da memória é mais eficaz do que reler o texto", language: "und" },
          { text: "A prática de recuperação ajuda na memória de quem estuda", language: "und" },
          { text: "Retrieval practice improves memory more than rereading does", language: "und" }
        ]
      },
      { id: 3, parent: 1, notes: [pt("Marés"), pt("Oceanos")] }
    ]);
    const { names } = provisionalNames(world.state, [world.topic(2)], world.texts, ptOptions);
    expect(names.get(world.topic(2))?.terms).toEqual(expect.arrayContaining(["recuperação"]));
    expect(names.get(world.topic(2))?.terms.join(" ")).not.toMatch(/retrieval|improves/u);
  });

  it("names nothing in a content language it has no stopwords for", () => {
    const world = seaAndMemory();
    const { names, skipped } = provisionalNames(world.state, [world.topic(2)], world.texts, {
      ...ptOptions,
      contentLanguage: "de"
    });
    expect(names.size).toBe(0);
    expect(skipped.get(world.topic(2))).toBe("language_unsupported");
  });

  it("never repeats a sibling title, accent- and case-insensitively", () => {
    const world = namingWorld([
      { id: 1, parent: 0 },
      {
        id: 2,
        parent: 1,
        notes: [
          pt("Memória de longo prazo e recuperação espaçada com feedback"),
          pt("Memória de longo prazo e recuperação espaçada sem feedback"),
          pt("Recuperação espaçada fortalece a memória de longo prazo com feedback")
        ]
      },
      { id: 3, parent: 1, notes: [pt("Marés e correntes oceânicas"), pt("Correntes oceânicas")] }
    ]);
    const first = provisionalNames(world.state, [world.topic(2)], world.texts, ptOptions);
    const taken = first.names.get(world.topic(2))!;
    // A named sibling already uses the title this topic would get, in other case and accents.
    getTopic(world.state, world.topic(3)).title = taken.title.toUpperCase();
    const second = provisionalNames(world.state, [world.topic(2)], world.texts, ptOptions);
    const other = second.names.get(world.topic(2));
    expect(other).toBeDefined();
    expect(other!.title.toLowerCase()).not.toBe(taken.title.toLowerCase());
    expect(other!.terms.length).toBeGreaterThan(taken.terms.length);
    // With no terms left to widen the name, the topic stays unnamed.
    const narrow = seaAndMemory();
    const only = provisionalNames(narrow.state, [narrow.topic(2)], narrow.texts, ptOptions);
    getTopic(narrow.state, narrow.topic(3)).title = only.names.get(narrow.topic(2))!.title;
    const none = provisionalNames(narrow.state, [narrow.topic(2)], narrow.texts, ptOptions);
    expect(none.names.size).toBe(0);
    expect(none.skipped.get(narrow.topic(2))).toBe("duplicate_title");
  });

  it("gives two renamed siblings different titles", () => {
    const world = namingWorld([
      { id: 1, parent: 0 },
      {
        id: 2,
        parent: 1,
        notes: [
          pt("Memória de longo prazo"),
          pt("Memória e esquecimento"),
          pt("Memória operacional")
        ]
      },
      {
        id: 3,
        parent: 1,
        notes: [
          pt("Memória de longo prazo"),
          pt("Memória e esquecimento"),
          pt("Memória operacional")
        ]
      }
    ]);
    const { names } = provisionalNames(
      world.state,
      [world.topic(2), world.topic(3)],
      world.texts,
      ptOptions
    );
    const titles = [...names.values()].map((name) => name.title);
    expect(new Set(titles.map((title) => title.toLowerCase())).size).toBe(titles.length);
  });

  it("skips terms the ancestors' titles already use", () => {
    const world = seaAndMemory();
    getTopic(world.state, world.topic(1)).title = "Memória";
    const { names } = provisionalNames(world.state, [world.topic(2)], world.texts, ptOptions);
    expect(names.get(world.topic(2))?.terms).not.toContain("memória");
  });

  it("repeats an ancestor's word rather than leave a small topic unnamed", () => {
    const world = namingWorld([
      { id: 1, parent: 0, fields: { title: "Memória", nameState: "named", nameSource: "llm" } },
      {
        id: 2,
        parent: 1,
        notes: [pt("Memória longa"), pt("Memória curta"), pt("Memória de trabalho")]
      },
      { id: 3, parent: 1, notes: [pt("Marés"), pt("Oceanos")] }
    ]);
    const { names, skipped } = provisionalNames(
      world.state,
      [world.topic(2)],
      world.texts,
      ptOptions
    );
    expect(skipped.size).toBe(0);
    expect(names.get(world.topic(2))?.terms).toEqual(["memória"]);
    expect(names.get(world.topic(2))?.title).toBe("Memória › memória");
  });

  it("depends on content, not on IDs", () => {
    const first = seaAndMemory(0);
    const second = seaAndMemory(5000);
    const a = provisionalNames(
      first.state,
      [first.topic(2), first.topic(3)],
      first.texts,
      ptOptions
    );
    const b = provisionalNames(
      second.state,
      [second.topic(2), second.topic(3)],
      second.texts,
      ptOptions
    );
    expect([...a.names.values()].map((name) => name.title)).toEqual(
      [...b.names.values()].map((name) => name.title)
    );
    expect(topicOrderKey(first.state, first.topic(2))).toBe(
      topicOrderKey(second.state, second.topic(2))
    );
  });

  it("scopes the texts it needs to the parents' subtrees", () => {
    const world = seaAndMemory();
    expect(fallbackScope(world.state, [world.topic(2)]).sort()).toEqual(
      [...world.itemsOf(2), ...world.itemsOf(3)].sort()
    );
  });

  it("ignores retired and unknown topics", () => {
    const world = seaAndMemory();
    const { names, skipped } = provisionalNames(
      world.state,
      [world.topic(2), "00000000-0000-4000-8000-0000000fffff"],
      world.texts,
      ptOptions
    );
    expect(names.has(world.topic(2))).toBe(true);
    expect(skipped.size).toBe(0);
  });
});

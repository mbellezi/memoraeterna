import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { noteIds, sourceFixture } from "./source-panel-fixtures";
import {
  addedAt,
  addedWords,
  creatorsText,
  metaItems,
  noteRows,
  passageOf,
  sectionWords,
  splitSentence,
  tabForAnchor
} from "./source-panel-model";

const en = createTranslator("en");
const pt = createTranslator("pt-BR");
const now = new Date(2026, 10, 12, 9, 30).getTime();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("the tab an address opens", () => {
  it("opens Connections for a relation, Content for a passage or a span, the Overview otherwise", () => {
    expect(tabForAnchor({ relation: uuid(1) })).toBe("connections");
    expect(tabForAnchor({ passage: uuid(2) })).toBe("content");
    expect(tabForAnchor({ span: uuid(3) })).toBe("content");
    expect(tabForAnchor({ passage: uuid(2), relation: uuid(1) })).toBe("connections");
    expect(tabForAnchor(undefined)).toBe("overview");
  });

  it("asks for a passage by its chunk, its span, or both", () => {
    expect(passageOf(undefined)).toBeNull();
    expect(passageOf({ relation: uuid(1) })).toBeNull();
    expect(passageOf({ passage: uuid(2) })).toEqual({
      chunkId: uuid(2),
      sourceSpanId: null,
      documentId: null
    });
    expect(passageOf({ span: uuid(3) })).toEqual({
      chunkId: null,
      sourceSpanId: uuid(3),
      documentId: null
    });
    expect(passageOf({ passage: uuid(2), span: uuid(3) })).toEqual({
      chunkId: uuid(2),
      sourceSpanId: uuid(3),
      documentId: null
    });
  });
});

describe("the note rows", () => {
  const detail = sourceFixture(now);

  it("list the newest note first and mark only a recent one, only while the source is made", () => {
    const rows = noteRows(detail, now, true);
    expect(rows.map((row) => row.id)).toEqual(noteIds);
    expect(rows[0]?.fresh).toBe(true);
    expect(rows[1]?.fresh).toBe(false);
    expect(noteRows(detail, now, false).some((row) => row.fresh)).toBe(false);
  });

  it("address each note as an object", () => {
    expect(noteRows(detail, now, false)[0]?.address).toBe(`memora://note/${noteIds[0]}`);
  });

  it("leave out a rejected note and one that was replaced", () => {
    const changed = {
      ...detail,
      atomicNotes: detail.atomicNotes.map((note, index) =>
        index === 0
          ? { ...note, status: "rejected" as const }
          : index === 1
            ? { ...note, supersessionStatus: "superseded" }
            : note
      )
    };
    expect(noteRows(changed, now, false).map((row) => row.id)).toEqual(noteIds.slice(2));
  });

  it("fall back to the page or the passage when the text has fewer than two sections", () => {
    const [document] = detail.documents;
    const plain = {
      ...detail,
      documents: [
        { ...document!, canonicalMarkdown: "# Title\n\nBody.\n", chunks: document!.chunks }
      ]
    };
    const sections = noteRows(plain, now, false).map((row) => row.section);
    expect(sections).toContainEqual({ kind: "page", page: 9 });
    expect(sections).toContainEqual({ kind: "passage", index: 1 });
    expect(sections.some((section) => section?.kind === "heading")).toBe(false);
  });

  it("say where a note rests: its section first, in words", () => {
    const sections = noteRows(detail, now, false).map((row) => row.section);
    expect(sections).toContainEqual({ kind: "heading", title: "Introduction" });
    expect(sections).toContainEqual({ kind: "heading", title: "Medellín" });
    expect(sectionWords({ kind: "heading", title: "Medellín" }, pt)).toBe("seção Medellín");
    expect(sectionWords({ kind: "heading", title: "Medellín" }, en)).toBe("section Medellín");
    expect(sectionWords({ kind: "page", page: 9 }, pt)).toBe("p.\u00a09");
    expect(sectionWords({ kind: "passage", index: 3 }, pt)).toBe("trecho 3");
    expect(sectionWords({ kind: "passage", index: 3 }, en)).toBe("passage 3");
  });
});

describe("the meta line", () => {
  const detail = sourceFixture(now);

  it("lists the type, the authors with the year, the venue, the length and when it was added", () => {
    expect(metaItems(detail, now, en)).toEqual([
      "Academic paper",
      "R. Andrade and L. Quispe (2023)",
      "Journal of Urban Studies, vol. 12",
      "24 pages",
      expect.stringMatching(/^added (today|yesterday), /u)
    ]);
  });

  it("speaks pt-BR with no English word in it", () => {
    const items = metaItems(detail, now, pt);
    expect(items[0]).toBe("Artigo acadêmico");
    expect(items[1]).toContain(" e ");
    expect(items[2]).toContain("v. 12");
    expect(items[3]).toBe("24 páginas");
    expect(items.join(" ")).not.toMatch(/\bpages\b|\band\b|added/u);
    expect(items[4]).toMatch(/^adicionada (hoje|ontem), /u);
  });

  it("leaves out what the descriptor does not say, never a placeholder", () => {
    const bare = { ...detail, metadata: {}, history: [] };
    expect(metaItems(bare, now, en)).toEqual(["Academic paper"]);
  });

  it("finds when the source was added in its oldest stored version", () => {
    const older = {
      ...detail,
      history: [
        { id: uuid(1), title: "x", createdAt: "2026-11-10T08:00:00.000Z", isCurrent: false },
        { id: uuid(2), title: "x", createdAt: "2026-11-12T08:00:00.000Z", isCurrent: true }
      ]
    };
    expect(addedAt(older)).toBe("2026-11-10T08:00:00.000Z");
    expect(addedAt({ ...detail, history: [] })).toBeNull();
  });

  it("words the day: today, yesterday, or the date", () => {
    const at = (day: number) => new Date(2026, 10, day, 9, 12).toISOString();
    expect(addedWords(at(12), now, "pt-BR", pt)).toMatch(/^adicionada hoje, 09:12$/u);
    expect(addedWords(at(11), now, "pt-BR", pt)).toMatch(/^adicionada ontem, 09:12$/u);
    expect(addedWords(at(3), now, "pt-BR", pt)).toMatch(/^adicionada em 3 de nov/u);
  });

  it("names authors with a list and 'et al.' from the fourth", () => {
    expect(creatorsText([], "en", en)).toBe("");
    expect(creatorsText(["A"], "en", en)).toBe("A");
    expect(creatorsText(["A", "B", "C"], "pt-BR", pt)).toBe("A, B e C");
    expect(creatorsText(["A", "B", "C", "D"], "en", en)).toBe("A et al.");
  });
});

describe("a sentence around a token", () => {
  it("splits at the token and says nothing when it is missing", () => {
    expect(splitSentence("one {key} two", "{key}")).toEqual(["one ", " two"]);
    expect(splitSentence("none", "{key}")).toBeNull();
  });
});

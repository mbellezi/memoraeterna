import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { SourceRelationExplanation } from "./SourceRelationExplanation";
import {
  asksForSourceExplanation,
  initialSourceRelationOpenState,
  sourceRelationExcerpt,
  sourceRelationExplanationView,
  sourceRelationOpenReducer,
  type SourceRelationExplanationView
} from "./source-relation-explanation-state";
import { notePageTiming } from "./note-page/note-page-model";

const relation = {
  sourceItemId: "A",
  targetSourceItemId: "B",
  sourceTitle: "Feedback study",
  targetTitle: "Retrieval review"
};
const decided = { explanation: null, writtenExplanation: null };

describe("opening a source relation", () => {
  it("asks for the explanation only after the open row stayed open for the dwell", () => {
    let state = sourceRelationOpenReducer(initialSourceRelationOpenState, {
      type: "open",
      id: "r1"
    });
    expect(state).toEqual({
      open: "r1",
      dwell: { id: "r1", delayMs: notePageTiming.explainDwellMs },
      explain: null
    });
    expect(notePageTiming.explainDwellMs).toBe(600);
    state = sourceRelationOpenReducer(state, { type: "dwell" });
    expect(state).toEqual({ open: "r1", dwell: null, explain: "r1" });
    // Opening another row restarts the dwell and forgets the first request.
    state = sourceRelationOpenReducer(state, { type: "open", id: "r2" });
    expect(state).toMatchObject({ open: "r2", explain: null, dwell: { id: "r2" } });
  });

  it("asks nothing when the row closes before the dwell, and cancels by forgetting the request", () => {
    let state = sourceRelationOpenReducer(initialSourceRelationOpenState, {
      type: "open",
      id: "r1"
    });
    state = sourceRelationOpenReducer(state, { type: "close", id: "r1" });
    expect(state).toEqual(initialSourceRelationOpenState);
    expect(sourceRelationOpenReducer(state, { type: "dwell" })).toBe(state);
    const asked = sourceRelationOpenReducer(
      sourceRelationOpenReducer(
        sourceRelationOpenReducer(initialSourceRelationOpenState, { type: "open", id: "r1" }),
        { type: "dwell" }
      ),
      { type: "close", id: "r1" }
    );
    expect(asked.explain).toBeNull();
    // Closing a row that is not the open one changes nothing.
    const open = sourceRelationOpenReducer(initialSourceRelationOpenState, {
      type: "open",
      id: "r1"
    });
    expect(sourceRelationOpenReducer(open, { type: "close", id: "r2" })).toBe(open);
  });

  it("asks at once on Retry, only for the open row", () => {
    const open = sourceRelationOpenReducer(initialSourceRelationOpenState, {
      type: "open",
      id: "r1"
    });
    expect(sourceRelationOpenReducer(open, { type: "explainNow", id: "r1" })).toEqual({
      open: "r1",
      dwell: null,
      explain: "r1"
    });
    expect(sourceRelationOpenReducer(open, { type: "explainNow", id: "r2" })).toBe(open);
  });

  it("asks only for relations without stored prose or a written explanation, and not after none was available", () => {
    expect(asksForSourceExplanation(decided, undefined, undefined)).toBe(true);
    expect(asksForSourceExplanation(decided, undefined, { status: "failed", kind: "failed" })).toBe(
      true
    );
    expect(asksForSourceExplanation(undefined, undefined, undefined)).toBe(false);
    expect(
      asksForSourceExplanation({ ...decided, explanation: "Stored prose." }, undefined, undefined)
    ).toBe(false);
    expect(
      asksForSourceExplanation(
        { ...decided, writtenExplanation: { text: "Written.", writtenBy: "m" } },
        undefined,
        undefined
      )
    ).toBe(false);
    expect(asksForSourceExplanation(decided, { text: "Now.", writtenBy: "m" }, undefined)).toBe(
      false
    );
    expect(asksForSourceExplanation(decided, undefined, { status: "unavailable" })).toBe(false);
  });

  it("shows stored prose first, then a written explanation, then the writing state", () => {
    expect(
      sourceRelationExplanationView({ ...decided, explanation: "Stored." }, undefined, undefined)
    ).toEqual({ kind: "stored", text: "Stored." });
    expect(
      sourceRelationExplanationView(
        decided,
        { text: "Written now.", writtenBy: "m" },
        { status: "writing" }
      )
    ).toEqual({ kind: "written", text: "Written now.", writtenBy: "m" });
    expect(sourceRelationExplanationView(decided, undefined, { status: "writing" })).toEqual({
      kind: "writing"
    });
    expect(
      sourceRelationExplanationView(decided, undefined, { status: "failed", kind: "noModel" })
    ).toEqual({ kind: "failed", noModel: true });
    expect(sourceRelationExplanationView(decided, undefined, undefined)).toEqual({ kind: "none" });
  });

  it("reads the first current evidence pair for rows decided without prose", () => {
    const evidence = (current: boolean, source: string) => ({
      current,
      sourceExcerpt: source,
      targetExcerpt: `${source} target`
    });
    expect(
      sourceRelationExcerpt({
        evidence: [evidence(false, "Old"), evidence(true, "Current")] as never
      })
    ).toEqual({ source: "Current", target: "Current target" });
    expect(sourceRelationExcerpt({ evidence: [evidence(false, "Old")] as never })).toEqual({
      source: "Old",
      target: "Old target"
    });
    expect(sourceRelationExcerpt({ evidence: [] })).toBeNull();
  });
});

describe("source relation explanation states", () => {
  const render = (view: SourceRelationExplanationView, language = "en" as const) =>
    renderToStaticMarkup(
      <SourceRelationExplanation
        t={createTranslator(language)}
        relation={relation}
        view={view}
        onRetry={() => undefined}
      />
    ).replaceAll("<!-- -->", "");

  it("renders writing, unavailable, failure with Retry and the written explanation", () => {
    expect(render({ kind: "writing" })).toContain('role="status"');
    expect(render({ kind: "writing" })).toContain("Writing an explanation…");
    expect(render({ kind: "unavailable" })).toContain("no longer available");
    const failed = render({ kind: "failed", noModel: false });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("could not be written");
    expect(failed).toContain("<button");
    expect(render({ kind: "failed", noModel: true })).toContain("No model is set up");
    const written = render({
      kind: "written",
      text: 'The study in <source-ref id="A" /> supports <source-ref id="B" />.',
      writtenBy: "writer-model"
    });
    expect(written).toContain('aria-label="1: Feedback study"');
    expect(written).toContain('aria-label="2: Retrieval review"');
    expect(written).toContain("Explained by writer-model");
    expect(written).not.toContain("source-ref");
    expect(render({ kind: "none" })).toBe("");
  });

  it("keeps the stored prose of older relations and escapes model markup", () => {
    const html = render({ kind: "stored", text: "<script>x</script> stored prose" });
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("stored prose");
  });

  it("has every state in every interface language", () => {
    for (const language of supportedLanguageCodes)
      for (const view of [
        { kind: "writing" },
        { kind: "unavailable" },
        { kind: "failed", noModel: false },
        { kind: "failed", noModel: true }
      ] as SourceRelationExplanationView[])
        expect(render(view, language as "en")).not.toContain("sourceRelations.");
  });
});

describe("a suggested source relation (decision 29)", () => {
  it("says suggested, confirmed and how to keep a suggestion in every interface language", () => {
    const suggested = new Set<string>();
    for (const language of supportedLanguageCodes) {
      const t = createTranslator(language as "en");
      for (const key of [
        "sourceRelations.suggested",
        "sourceRelations.suggestedHint",
        "sourceRelations.confirmed",
        "sourceRelations.accepted",
        "sourceRelations.rejected"
      ] as const) {
        expect(t(key)).not.toContain("sourceRelations.");
        expect(t(key).trim()).not.toBe("");
      }
      suggested.add(t("sourceRelations.suggested"));
    }
    // Translated, not copied: the five languages do not all read the same.
    expect(suggested.size).toBeGreaterThan(2);
  });

  it("has one word for an automatic relation nobody kept, not a second 'AI suggestion'", () => {
    for (const language of supportedLanguageCodes) {
      const t = createTranslator(language as "en");
      expect(t("sourceRelations.restore")).not.toContain("sourceRelations.");
      // The retired status wording stays retired: the key is gone from every language.
      expect(() =>
        t("sourceRelations.pending_review" as never, { missingKeyBehavior: "throw" })
      ).toThrow();
    }
  });
});

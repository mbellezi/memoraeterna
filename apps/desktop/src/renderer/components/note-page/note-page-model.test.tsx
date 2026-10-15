import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { notePageLoadDecision, notePageOpenedObject } from "./NotePage";
import {
  cardContent,
  editChanges,
  evidenceLinkState,
  evidenceLocator,
  evidenceSummary,
  explanationErrorKind,
  formatNoteDate,
  interpolateNodes,
  isPristineDraft,
  noteActions,
  noteHeaderState,
  noteRefSegments,
  provenanceMessage,
  refreshRelationLimit,
  relationSentence,
  reviewErrorKind
} from "./note-page-model";
import { evidenceItem, fixtureAt, fixtureId, notePage, relationItem } from "./note-page-fixtures";

const t = createTranslator("en");
const note = notePage().note;

describe("note header state", () => {
  it("follows the precedence discarded, archived, edited, evolution, reviewed, AI", () => {
    expect(noteHeaderState({ status: "rejected", authorship: "edited" })).toEqual({
      kind: "discarded"
    });
    expect(noteHeaderState({ status: "archived", authorship: "evolution" })).toEqual({
      kind: "archived"
    });
    expect(noteHeaderState({ status: "approved", authorship: "edited" })).toEqual({
      kind: "edited"
    });
    expect(noteHeaderState({ status: "active", authorship: "evolution" })).toEqual({
      kind: "evolution"
    });
    expect(noteHeaderState({ status: "approved", authorship: "ai" })).toEqual({ kind: "reviewed" });
    expect(noteHeaderState({ status: "active", authorship: "ai" })).toEqual({
      kind: "ai",
      pending: false
    });
    expect(noteHeaderState({ status: "pending_review", authorship: "ai" })).toEqual({
      kind: "ai",
      pending: true
    });
  });

  it("offers review only to AI notes and nothing on history", () => {
    expect(noteActions({ ...note })).toEqual({ markReviewed: true, edit: true });
    expect(noteActions({ ...note, status: "approved" })).toEqual({
      markReviewed: false,
      edit: true
    });
    expect(noteActions({ ...note, authorship: "edited" })).toEqual({
      markReviewed: false,
      edit: true
    });
    for (const changed of [
      { superseded: true },
      { status: "rejected" as const },
      { status: "archived" as const }
    ])
      expect(noteActions({ ...note, ...changed })).toEqual({ markReviewed: false, edit: false });
  });
});

describe("provenance", () => {
  const date = formatNoteDate(fixtureAt, "en");

  it("counts passages and names the work they come from", () => {
    expect(provenanceMessage(notePage(), "en")).toEqual({
      key: "notePage.provenance.onePassage",
      values: { model: "writer-model", source: "A fictional memory study", date }
    });
    const two = notePage({
      evidence: {
        items: [evidenceItem(), evidenceItem({ chunkId: fixtureId(43), primary: false })],
        total: 2
      }
    });
    expect(provenanceMessage(two, "en").key).toBe("notePage.provenance.passages");
    const sources = notePage({
      evidence: {
        items: [
          evidenceItem(),
          evidenceItem({ chunkId: fixtureId(43), sourceTitle: "Other", workTitle: "Other work" })
        ],
        total: 5
      }
    });
    expect(provenanceMessage(sources, "en")).toEqual({
      key: "notePage.provenance.passagesOfSources",
      values: { model: "writer-model", count: 5, sourceCount: 2, date }
    });
    expect(provenanceMessage(notePage({ evidence: { items: [], total: 0 } }), "en").key).toBe(
      "notePage.provenance.noEvidence"
    );
    expect(evidenceSummary(sources.evidence)).toEqual({ count: 5, workCount: 2, workTitle: null });
  });

  it("says who edited and when, and names a reviewed evolution", () => {
    const edited = notePage({
      note: { ...note, authorship: "edited", lastEditedAt: "2026-10-15T09:00:00.000Z" }
    });
    expect(provenanceMessage(edited, "en")).toEqual({
      key: "notePage.provenance.edited",
      values: { model: "writer-model", date: formatNoteDate("2026-10-15T09:00:00.000Z", "en") }
    });
    expect(
      provenanceMessage(notePage({ note: { ...note, authorship: "evolution" } }), "en").key
    ).toBe("notePage.provenance.evolution");
  });

  it("formats dates in the interface locale", () => {
    expect(formatNoteDate(fixtureAt, "pt-BR")).not.toBe(formatNoteDate(fixtureAt, "en"));
  });
});

describe("evidence", () => {
  it("joins only the known parts of the locator", () => {
    expect(evidenceLocator(evidenceItem(), t)).toBe("passage 18 · range 412–618");
    expect(
      evidenceLocator(evidenceItem({ workTitle: "The work", sourceTitle: "Chapter 2", page: 7 }), t)
    ).toBe("Chapter 2 · passage 18 · p. 7 · range 412–618");
    expect(evidenceLocator(evidenceItem({ chunkIndex: null, range: null }), t)).toBe("");
  });

  it("opens current passages only", () => {
    expect(evidenceLinkState({ current: true, sourceAvailable: true })).toBe("open");
    expect(evidenceLinkState({ current: false, sourceAvailable: true })).toBe("earlierVersion");
    expect(evidenceLinkState({ current: false, sourceAvailable: false })).toBe("preserved");
  });
});

describe("relation sentence", () => {
  it("states a decided direction and never invents one", () => {
    expect(relationSentence({ type: "supports", direction: "outgoing" })).toMatchObject({
      key: "notePage.card.sentence",
      subject: "this",
      object: "other",
      directionConfirmed: true
    });
    expect(relationSentence({ type: "extends", direction: "incoming" })).toMatchObject({
      subject: "other",
      object: "this",
      directionConfirmed: true
    });
    expect(relationSentence({ type: "contrasts", direction: "incoming" })).toMatchObject({
      key: "notePage.card.sentence",
      subject: "this",
      directionConfirmed: false
    });
    expect(relationSentence({ type: "supports", direction: "unknown" })).toMatchObject({
      key: "notePage.card.undirected",
      wordKey: "notePage.stance.supports",
      directionConfirmed: false
    });
  });

  it("puts elements where the template has tokens, never HTML", () => {
    const html = renderToString(
      <p>
        {interpolateNodes("{subject} supports {object} ({missing})", {
          subject: <b>A</b>,
          object: "<i>"
        })}
      </p>
    );
    expect(html.replaceAll("<!-- -->", "")).toBe("<p><b>A</b> supports &lt;i&gt; ({missing})</p>");
  });

  it("resolves note references by ID and keeps unknown ones inert", () => {
    const text = `<note-ref id="${fixtureId(1)}" /> and <note-ref id="${fixtureId(61).toUpperCase()}"/> beat <note-ref id="x" />.`;
    expect(noteRefSegments(text, { thisId: fixtureId(1), otherId: fixtureId(61) })).toEqual([
      { ref: "this" },
      " and ",
      { ref: "other" },
      " beat ",
      { ref: "unknown" },
      "."
    ]);
    expect(noteRefSegments("No tags.", { thisId: "a", otherId: "b" })).toEqual(["No tags."]);
  });

  it("gives every relation a card: an explanation is written when it opens", () => {
    const content = cardContent(
      relationItem({ other: { ...relationItem().other, passage: null }, decidedBy: null }),
      null
    );
    expect(content).toEqual({
      thisPassage: null,
      otherPassage: null,
      explanation: null,
      decidedBy: null
    });
    expect(cardContent(relationItem(), evidenceItem()).thisPassage?.chunkIndex).toBe(17);
  });
});

describe("actions", () => {
  it("tells a stale edit token from other failures", () => {
    expect(
      reviewErrorKind(new Error("Error invoking remote method: Error: sourceWorkspace.conflict"))
    ).toBe("conflict");
    expect(reviewErrorKind(new Error("boom"))).toBe("failed");
    expect(explanationErrorKind(new Error("errors.ai.noCompatibleModel"))).toBe("noModel");
    expect(explanationErrorKind("x")).toBe("failed");
  });

  it("sends only the changed, trimmed fields and refuses blanks", () => {
    const draft = {
      title: note.title,
      ideaStatement: note.ideaStatement,
      bodyMarkdown: note.bodyMarkdown
    };
    expect(editChanges(note, draft)).toBeNull();
    expect(isPristineDraft(note, draft)).toBe(true);
    expect(editChanges(note, { ...draft, title: "  New title " })).toEqual({ title: "New title" });
    expect(editChanges(note, { ...draft, bodyMarkdown: `${note.bodyMarkdown}  ` })).toBeNull();
    expect(editChanges(note, { ...draft, ideaStatement: "  " })).toBe("invalid");
    expect(isPristineDraft(note, { ...draft, title: "x" })).toBe(false);
  });

  it("keeps the rows already shown when the page is read again", () => {
    expect(refreshRelationLimit(0)).toBe(20);
    expect(refreshRelationLimit(35)).toBe(35);
    expect(refreshRelationLimit(80)).toBe(50);
  });
});

describe("note page loading", () => {
  const ok = { key: "n|0", ok: true, hasData: true };
  it("loads nothing while hidden and refreshes in place when shown again", () => {
    expect(
      notePageLoadDecision({
        active: false,
        wasHidden: false,
        outcome: null,
        key: "n|0",
        showing: false
      })
    ).toBe("skip");
    expect(
      notePageLoadDecision({
        active: true,
        wasHidden: false,
        outcome: null,
        key: "n|0",
        showing: false
      })
    ).toBe("load");
    expect(
      notePageLoadDecision({
        active: true,
        wasHidden: true,
        outcome: ok,
        key: "n|0",
        showing: true
      })
    ).toBe("silent");
    expect(
      notePageLoadDecision({
        active: true,
        wasHidden: false,
        outcome: ok,
        key: "n|0",
        showing: true
      })
    ).toBe("skip");
  });

  it("reloads the note it shows silently after its own actions, and keeps failures until Retry", () => {
    expect(
      notePageLoadDecision({
        active: true,
        wasHidden: false,
        outcome: ok,
        key: "n|1",
        showing: true
      })
    ).toBe("silent");
    const failed = { key: "n|0", ok: false, hasData: false };
    expect(
      notePageLoadDecision({
        active: true,
        wasHidden: true,
        outcome: failed,
        key: "n|0",
        showing: false
      })
    ).toBe("skip");
    expect(
      notePageLoadDecision({
        active: true,
        wasHidden: false,
        outcome: failed,
        key: "n|1",
        showing: false
      })
    ).toBe("load");
  });

  it("records the note with its home source, so recents can open it again", () => {
    expect(notePageOpenedObject(notePage())).toEqual({
      kind: "note",
      id: fixtureId(1),
      title: "Forgetting curve",
      parentAddress: `memora://source/${fixtureId(3)}`
    });
  });
});

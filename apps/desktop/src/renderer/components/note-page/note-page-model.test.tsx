import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { createNavigationRouter } from "../../lib/window-navigation";
import { notePageLoadDecision, notePageOpenedObject } from "./NotePage";
import {
  asksForExplanation,
  cardContent,
  editBase,
  editChanges,
  editRequest,
  evidenceLinkState,
  evidenceLocator,
  evidenceSummary,
  explanationAfter,
  explanationErrorKind,
  formatNoteDate,
  hasUnsavedEdit,
  interpolateNodes,
  isPristineDraft,
  keepShownRelations,
  keepsNotePageMounted,
  nextAnnouncement,
  noteActions,
  noteHeaderState,
  noteRefSegments,
  provenanceMessage,
  refreshRelationLimit,
  relationSentence,
  reviewErrorKind,
  unsavedEditNavigationGuard,
  withPlacement
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

  it("asks for as many rows as are shown on a refresh, within the schema's page cap", () => {
    expect(refreshRelationLimit(0)).toBe(20);
    expect(refreshRelationLimit(35)).toBe(35);
    expect(refreshRelationLimit(80)).toBe(50);
  });

  it("keeps the rows shown past the first page when the page is read again", () => {
    const rows = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, index) =>
        relationItem({ id: fixtureId(1000 + from + index) })
      );
    const shown = notePage({ relations: { items: rows(0, 80), total: 80 } });
    const refreshed = notePage({ relations: { items: rows(0, 50), total: 80 } });
    const kept = keepShownRelations(shown, refreshed);
    expect(kept.relations.items).toHaveLength(80);
    expect(kept.relations.items.map((item) => item.id)).toEqual(
      shown.relations.items.map((item) => item.id)
    );
    // A row that moved into the first page is not listed twice; the refreshed total wins.
    const moved = notePage({ relations: { items: [...rows(1, 50), rows(60, 61)[0]!], total: 79 } });
    const merged = keepShownRelations(shown, moved);
    expect(new Set(merged.relations.items.map((item) => item.id)).size).toBe(
      merged.relations.items.length
    );
    expect(merged.relations.total).toBe(79);
    expect(keepShownRelations(null, refreshed)).toBe(refreshed);
    expect(keepShownRelations(refreshed, shown)).toBe(shown);
  });

  it("shows a path read again without touching the rest of the page, and nothing when it is the same", () => {
    const page = notePage();
    // The topic the note sits under was renamed and the note also shows in another topic.
    const moved = {
      ...page.placement,
      primaryPath: page.placement.primaryPath.map((segment) =>
        segment.kind === "topic" && segment.title === "Memory"
          ? { ...segment, title: "Learning and memory" }
          : segment
      ),
      alsoIn: [
        ...page.placement.alsoIn,
        { kind: "topic" as const, id: fixtureId(8), title: "Sleep" }
      ],
      counts: { ...page.placement.counts, alsoIn: 2 }
    };
    const next = withPlacement(page, moved);
    expect(next).not.toBe(page);
    expect(next.placement).toEqual(moved);
    expect(next.note).toBe(page.note);
    expect(next.relations).toBe(page.relations);
    expect(next.evidence).toBe(page.evidence);
    // The same answer is the same page, so the view does not redraw.
    expect(withPlacement(page, JSON.parse(JSON.stringify(page.placement)))).toBe(page);
  });

  it("takes an edit against the version it started from, not a page refreshed meanwhile", () => {
    const v1 = notePage().note;
    const v2 = { ...v1, title: "Changed elsewhere", updatedAt: "2026-10-15T10:00:00.000Z" };
    const base = editBase(v1);
    const draft = { title: v1.title, ideaStatement: v1.ideaStatement, bodyMarkdown: "Mine." };
    // The page now shows v2; the request still names v1, so the server answers with a conflict.
    expect(editRequest(v2.id, { base, draft })).toEqual({
      id: v1.id,
      action: "edit",
      expectedUpdatedAt: v1.updatedAt,
      bodyMarkdown: "Mine."
    });
    expect(editRequest(v1.id, { base, draft: { ...draft, bodyMarkdown: v1.bodyMarkdown } })).toBe(
      null
    );
    expect(editRequest(v1.id, { base, draft: { ...draft, title: " " } })).toBe(null);
  });

  it("holds Back and Forward while an unsaved edit is open and asks first", () => {
    const base = editBase(note);
    const pristine = { base, draft: { ...base } };
    const changed = { base, draft: { ...base, title: "Typed" } };
    expect(hasUnsavedEdit(null)).toBe(false);
    expect(hasUnsavedEdit(pristine)).toBe(false);
    expect(hasUnsavedEdit(changed)).toBe(true);

    let editing: typeof changed | null = changed;
    const router = createNavigationRouter(() => 1_000);
    const library = vi.fn(() => true);
    const ask = vi.fn();
    router.subscribe(library);
    router.subscribe(
      unsavedEditNavigationGuard(() => hasUnsavedEdit(editing), ask),
      5
    );
    expect(router.dispatch("back", "native")).toBe(true);
    expect(ask).toHaveBeenCalledWith("back");
    expect(library).not.toHaveBeenCalled();
    // Discarded: the same move goes through to the Library's history.
    editing = null;
    router.dispatch("forward", "native");
    expect(library).toHaveBeenCalledWith("forward");
    expect(ask).toHaveBeenCalledOnce();
  });

  it("opens a topic over the page without asking, and asks before any target that replaces it", () => {
    expect(keepsNotePageMounted({ type: "topic" })).toBe(true);
    for (const type of ["source", "note", "resolve", "none"])
      expect(keepsNotePageMounted({ type }), type).toBe(false);
  });

  it("announces the same outcome twice by changing the live region's text", () => {
    const first = nextAnnouncement("", "Saved.");
    const second = nextAnnouncement(first, "Saved.");
    const third = nextAnnouncement(second, "Saved.");
    expect(first).toBe("Saved.");
    expect(second).not.toBe(first);
    expect(second.trim()).toBe("Saved.");
    expect(third).not.toBe(second);
    expect(nextAnnouncement(second, "Reviewed.")).toBe("Reviewed.");
  });
});

describe("explanations on demand", () => {
  it("ends the writing state for a relation found gone and never asks for it again", () => {
    const relation = relationItem();
    expect(asksForExplanation(relation, undefined)).toBe(true);
    const gone = explanationAfter(null);
    expect(gone).toEqual({ status: "unavailable" });
    expect(asksForExplanation(relation, gone!)).toBe(false);
    expect(explanationAfter({ text: "Both describe recall." })).toBeNull();
    // A failure is asked for again on the next deliberate open; a stored one never is.
    expect(asksForExplanation(relation, { status: "failed", kind: "failed" })).toBe(true);
    expect(
      asksForExplanation(relationItem({ explanation: { text: "x", writtenBy: "w" } }), undefined)
    ).toBe(false);
    expect(asksForExplanation(undefined, undefined)).toBe(false);
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

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NotePage } from "@app/domain";
import { createTranslator, supportedLanguageCodes, type Translator } from "@app/i18n";

import { NoteLeaveDialog } from "./NoteLeaveDialog";
import { ViewTabs } from "./NoteRelations";
import { NotePageView, type NotePageLoad, type NotePageViewProps } from "./NotePageView";
import type { ExplanationState } from "./RelationEvidenceCard";
import { evidenceItem, fixtureId, idleMore, notePage, relationItem } from "./note-page-fixtures";
import { editBase } from "./note-page-model";

const en = createTranslator("en");
const noop = () => undefined;
const plain = (html: string) => html.replaceAll("<!-- -->", "");
// Visible text only: attribute values (IDs used by aria and React) are not shown to the person.
const text = (html: string) => html.replace(/<[^>]*>/g, " ");

function render(
  load: NotePageLoad,
  overrides: Partial<NotePageViewProps> = {},
  t: Translator = en
): string {
  return plain(
    renderToString(
      <NotePageView
        t={t}
        backLabel="Back to library"
        load={load}
        editing={null}
        review={{ pending: false, failed: false }}
        openCard={null}
        explanations={{}}
        reviews={{}}
        more={idleMore}
        relationFocus={null}
        withdrawnOpen={false}
        openFailed={false}
        announcement=""
        onBack={noop}
        onRetry={noop}
        onMarkReviewed={noop}
        onStartEdit={noop}
        onDraftChange={noop}
        onSave={noop}
        onCancelEdit={noop}
        onDiscardAndReload={noop}
        onEscapeEdit={noop}
        onOpenNote={noop}
        onOpenPassage={noop}
        onOpenPlacement={noop}
        onCardEvent={noop}
        onRetryExplanation={noop}
        onReview={noop}
        onRelationFocusHandled={noop}
        onToggleWithdrawn={noop}
        onShowMore={noop}
        {...overrides}
      />
    )
  );
}
const ready = (page: NotePage = notePage()): NotePageLoad => ({ status: "ready", page });

describe("Note page states", () => {
  it("shows a busy skeleton, a retryable failure and a missing note under the host strip", () => {
    const loading = render({ status: "loading" });
    expect(loading).toContain("Back to library");
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain(">Loading...<");
    const error = render({ status: "error" });
    expect(error).toContain('role="alert"');
    expect(error).toContain("This note could not be loaded.");
    expect(error).toContain(">Retry<");
    expect(render({ status: "missing" })).toContain("This note is no longer in the library.");
  });

  it("renders the sections in order, named for assistive technology", () => {
    const html = render(ready());
    expect(html).toContain('aria-label="Note: Forgetting curve"');
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*lang="en"[^>]*>Forgetting is fastest/);
    const order = ["<h1", "Note text", "Where is this", "Evidence", "Relations"].map((part) =>
      html.indexOf(part)
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/<h2/g)!.length).toBe(4);
  });

  it("shows where the note is with no click: its topic path, then the path of its sources", () => {
    const html = render(ready());
    expect(html).toContain(">Main path<");
    const crumbs = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
    expect(crumbs).toEqual(
      expect.arrayContaining([
        "All topics",
        "Memory",
        "Fictional classics",
        "A fictional memory study"
      ])
    );
    expect(html.indexOf(">Memory<")).toBeLessThan(html.indexOf(">Fictional classics<"));
    expect(html).toContain('<span class="truncate">Recall</span>');
  });

  it("never shows an identifier or a raw reference tag", () => {
    const page = notePage({
      relations: {
        items: [
          relationItem({
            explanation: {
              text: `<note-ref id="${fixtureId(1)}" /> qualifies <note-ref id="${fixtureId(61)}" />.`,
              writtenBy: "writer-x"
            }
          })
        ],
        total: 1
      }
    });
    const html = render(ready(page), { openCard: fixtureId(60) });
    expect(text(html)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(html).not.toContain("note-ref");
    expect(html).not.toContain("memora://");
  });
});

describe("Note page header", () => {
  it("marks an AI note active since creation, offers review and the edit hint", () => {
    const html = render(ready());
    expect(html).toContain("AI generated");
    expect(html).toContain("active since creation");
    expect(html).toContain("review optional");
    expect(html).toContain(">Mark as reviewed<");
    expect(html).toContain(">Edit<");
    expect(html).toContain("Written by <strong");
    expect(html).toContain("from 1 passage of A fictional memory study");
    expect(html).toContain("If you edit it, the note becomes yours");
  });

  it("says when a note was reviewed and offers only Edit", () => {
    const page = notePage({
      note: { ...notePage().note, status: "approved", reviewedAt: "2026-10-15T09:00:00.000Z" }
    });
    const html = render(ready(page));
    expect(html).toContain("Reviewed on");
    expect(html).not.toContain("Mark as reviewed");
    expect(html).not.toContain("AI generated");
  });

  it("shows a person's note as theirs and protected, without the AI badge or the hint", () => {
    const page = notePage({
      note: {
        ...notePage().note,
        authorship: "edited",
        humanProtected: true,
        lastEditedAt: "2026-10-15T09:00:00.000Z"
      }
    });
    const html = render(ready(page));
    expect(html).toContain("Your note");
    expect(html).toContain("protected from automatic changes");
    expect(html).toContain("edited by you on");
    expect(html).not.toContain("AI generated");
    expect(html).not.toContain("If you edit it");
    const evolution = render(
      ready(
        notePage({ note: { ...notePage().note, authorship: "evolution", humanProtected: true } })
      )
    );
    expect(evolution).toContain("Reviewed evolution");
    expect(evolution).toContain("in a note evolution you reviewed");
  });

  it("keeps history read-only and links to the current note", () => {
    const page = notePage({
      note: { ...notePage().note, superseded: true },
      successors: [{ id: fixtureId(9), title: "Merged note" }]
    });
    const html = render(ready(page));
    expect(html).toContain("Superseded · history retained");
    expect(html).toContain(">Open the current note<");
    expect(html).not.toContain("Mark as reviewed");
    expect(html).not.toContain(">Edit<");
    const two = render(
      ready(
        notePage({
          note: { ...notePage().note, superseded: true },
          successors: [
            { id: fixtureId(9), title: "First" },
            { id: fixtureId(10), title: "Second" }
          ]
        })
      )
    );
    expect(two).toContain("Open “First”");
    expect(two).toContain("Open “Second”");
    const discarded = render(ready(notePage({ note: { ...notePage().note, status: "rejected" } })));
    expect(discarded).toContain(">Discarded<");
    expect(discarded).not.toContain(">Edit<");
  });

  it("edits inline with labelled fields, a hint and the review failure", () => {
    const note = notePage().note;
    const draft = {
      title: note.title,
      ideaStatement: note.ideaStatement,
      bodyMarkdown: note.bodyMarkdown
    };
    const html = render(ready(), {
      editing: { base: editBase(note), draft, canSave: false, saving: false, error: "conflict" }
    });
    expect(html).not.toContain("<h1");
    expect(html).toMatch(/<label[^>]*>Title<\/label>/);
    expect(html).toMatch(/<label[^>]*>Idea statement<\/label>/);
    expect(html).toMatch(/<label[^>]*>Note text<\/label>/);
    expect(html).toContain("Saving makes the note yours");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toContain("Discard my edit and reload");
    expect(render(ready(), { review: { pending: false, failed: true } })).toContain(
      "The note could not be marked as reviewed."
    );
  });

  it("asks before leaving an unsaved edit: keep editing or discard, as a labelled alert dialog", () => {
    const html = plain(
      renderToString(<NoteLeaveDialog t={en} onKeepEditing={noop} onDiscard={noop} />)
    );
    expect(html).toMatch(/^<dialog[^>]*role="alertdialog"/);
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(html).toMatch(
      new RegExp(`<h2 id="${labelledBy}"[^>]*>Discard your unsaved edit\\?</h2>`)
    );
    expect(html).toMatch(new RegExp(`<p id="${describedBy}"[^>]*>You changed this note`));
    expect(html).toContain(">Keep editing<");
    expect(html).toContain(">Discard changes<");
    // Keeping the edit comes last, as the default action of the dialog.
    expect(html.indexOf(">Discard changes<")).toBeLessThan(html.indexOf(">Keep editing<"));
  });
});

describe("Note page evidence", () => {
  it("lists each passage with its locator and an exact link", () => {
    const html = render(ready());
    expect(html).toContain("<figure");
    expect(html).toContain("passage 18 · range 412–618");
    expect(html).toContain(">Open at passage<");
    expect(html).toContain("line-clamp-6");
  });

  it("hides the section and the provenance clause without evidence", () => {
    const html = render(ready(notePage({ evidence: { items: [], total: 0 } })));
    expect(html).not.toContain(">Evidence<");
    expect(html).not.toContain("passage of");
  });

  it("tags earlier versions and preserved passages and gives them no link", () => {
    const html = render(
      ready(
        notePage({
          evidence: {
            items: [
              evidenceItem({ current: false }),
              evidenceItem({ chunkId: fixtureId(43), current: false, sourceAvailable: false })
            ],
            total: 2
          }
        })
      )
    );
    expect(html).toContain("Earlier version of the source");
    expect(html).toContain("Preserved passage");
    expect(html).not.toContain("Open at passage");
  });

  it("says how many passages are not listed", () => {
    expect(render(ready(notePage({ evidence: { items: [evidenceItem()], total: 2 } })))).toContain(
      "1 more passage is not shown."
    );
    expect(render(ready(notePage({ evidence: { items: [evidenceItem()], total: 9 } })))).toContain(
      "8 more passages are not shown."
    );
  });
});

describe("Note page relations", () => {
  it("lists relations with stance, idea, source and decider", () => {
    const html = render(ready());
    expect(html).toContain("text-stance-supports");
    expect(html).toContain(">supports<");
    expect(html).toContain("Spaced repetition flattens the forgetting curve.");
    expect(html).toContain("Spacing handbook");
    expect(html).toContain(
      'decided <strong class="font-semibold text-secondary-foreground">decider-model</strong>'
    );
    expect(html).toContain("hover or focus a relation to see its evidence");
    expect(html).not.toContain("explained");
  });

  it("names who explained a relation when an explanation exists", () => {
    const page = notePage({
      relations: {
        items: [
          relationItem({ explanation: { text: "Both describe recall.", writtenBy: "writer-x" } })
        ],
        total: 1
      }
    });
    expect(render(ready(page))).toContain(
      'explained <strong class="font-semibold text-secondary-foreground">writer-x</strong>'
    );
    const noDecider = render(
      ready(notePage({ relations: { items: [relationItem({ decidedBy: null })], total: 1 } }))
    );
    expect(noDecider).not.toContain("decided");
  });

  it("says when there are no relations", () => {
    const html = render(ready(notePage({ relations: { items: [], total: 0 } })));
    expect(html).toContain("No relations to other notes were found.");
    expect(html).not.toContain("hover or focus");
  });

  it("puts the open card right after its row, as a group and never a dialog", () => {
    const html = render(ready(), { openCard: fixtureId(60) });
    const row = html.indexOf("Spaced repetition flattens");
    const card = html.indexOf('role="group"');
    expect(card).toBeGreaterThan(row);
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('aria-label="Evidence for the relation: supports"');
    expect(html).toContain("direction confirmed");
    expect(html).toContain('<strong class="font-semibold">This note</strong> supports');
    expect(html).toContain("“Spaced repetition flattens the forgetting curve.”");
    expect(html).toContain("A fictional memory study · passage 18");
    expect(html).toContain("Spacing handbook · passage 5");
    expect(html).toContain(">Decided<");
  });

  it("says it writes a missing explanation only once it was asked for, and shows who wrote it", () => {
    // Before the dwell nothing is being written, so nothing says so.
    const opened = render(ready(), { openCard: fixtureId(60) });
    expect(opened).not.toContain("Writing an explanation");
    const writing = render(ready(), {
      openCard: fixtureId(60),
      explanations: { [fixtureId(60)]: { status: "writing" } }
    });
    expect(writing).toContain("Writing an explanation…");
    expect(writing).toContain('aria-busy="true"');
    const explained = render(
      ready(
        notePage({
          relations: {
            items: [
              relationItem({
                explanation: {
                  text: `<note-ref id="${fixtureId(1)}" /> qualifies <note-ref id="${fixtureId(61)}" />.`,
                  writtenBy: "writer-x"
                },
                explainedBy: { model: "writer-x", kind: "remote" }
              })
            ],
            total: 1
          }
        })
      ),
      { openCard: fixtureId(60) }
    );
    // A reference that starts the explanation starts the sentence.
    expect(explained).toContain('<strong class="font-semibold">This note</strong><span> qualifies');
    // The writer is one of the card's provenance lines, beside the decider.
    expect(explained).toMatch(
      /<dt[^>]*>Explained<\/dt><dd[^>]*>writer-x<span[^>]*> · online<\/span><\/dd>/
    );
    expect(explained).not.toContain("Writing an explanation");
  });

  it("shows the explanation as it streams, with references as words, marked busy and never announced", () => {
    const html = render(ready(), {
      openCard: fixtureId(60),
      explanations: {
        [fixtureId(60)]: {
          status: "streaming",
          text: `<note-ref id="${fixtureId(1)}" /> qualifies the recall benefit that`
        }
      }
    });
    expect(html).toContain('<strong class="font-semibold">This note</strong><span> qualifies');
    expect(html).toContain("the recall benefit that");
    expect(html).toMatch(/<p aria-busy="true" class="font-reading[^"]*">/);
    expect(html).not.toContain("note-ref");
    // The preview is not a status region: a screen reader hears the card, not every piece.
    expect(html).not.toContain("Writing an explanation");
    expect(html).not.toMatch(/<p role="status"/);
    expect(html).not.toContain(">Retry<");
  });

  it("prefers the stored explanation over a stale streaming state", () => {
    const html = render(
      ready(
        notePage({
          relations: {
            items: [relationItem({ explanation: { text: "Stored text.", writtenBy: "writer-x" } })],
            total: 1
          }
        })
      ),
      {
        openCard: fixtureId(60),
        explanations: { [fixtureId(60)]: { status: "streaming", text: "Stale preview" } }
      }
    );
    expect(html).toContain("Stored text.");
    expect(html).not.toContain("Stale preview");
  });

  it("says the model that writes explanations found the notes unrelated and that the relation is hidden", () => {
    const html = render(ready(), {
      openCard: fixtureId(60),
      explanations: { [fixtureId(60)]: { status: "vetoed" } }
    });
    expect(html).toContain(
      "The model that writes explanations found these notes unrelated, so this relation is now hidden."
    );
    expect(html).toMatch(/<p role="status" class="text-sm text-foreground">The model that writes/);
    expect(html).not.toContain("Writing an explanation");
    expect(html).not.toContain(">Retry<");
    expect(html).not.toContain('aria-busy="true"');
  });

  it("says no explanation is available when the writer disagrees with a relation that stays, without blaming a veto", () => {
    const html = render(ready(), {
      openCard: fixtureId(60),
      explanations: { [fixtureId(60)]: { status: "unexplained" } }
    });
    expect(html).toContain(
      "No explanation is available. The model that writes explanations did not find a link between these notes, and the relation stays as it is."
    );
    // Neither the veto message nor the "no longer available" one: the relation is still there.
    expect(html).not.toContain("now hidden");
    expect(html).not.toContain("no longer available");
    expect(html).not.toContain("Writing an explanation");
    expect(html).not.toContain(">Retry<");
    expect(html).not.toContain('aria-busy="true"');
    expect(html).not.toContain("NOT_RELATED");
  });

  it("says it in every language", () => {
    for (const code of supportedLanguageCodes) {
      const t = createTranslator(code);
      const html = render(
        ready(),
        {
          openCard: fixtureId(60),
          explanations: { [fixtureId(60)]: { status: "unexplained" } }
        },
        t
      );
      expect(html).toContain(t("notePage.card.unexplained"));
      expect(t("notePage.card.unexplained")).not.toBe("notePage.card.unexplained");
      // Its own words: not the veto, not the unavailable one.
      expect(t("notePage.card.unexplained")).not.toBe(t("notePage.card.unrelated"));
      expect(t("notePage.card.unexplained")).not.toBe(t("notePage.card.explainUnavailable"));
    }
    for (const code of supportedLanguageCodes) {
      const t = createTranslator(code);
      const html = render(
        ready(),
        {
          openCard: fixtureId(60),
          explanations: { [fixtureId(60)]: { status: "vetoed" } }
        },
        t
      );
      expect(html).toContain(t("notePage.card.unrelated"));
      expect(t("notePage.card.unrelated")).not.toBe("notePage.card.unrelated");
    }
  });

  it("shows a failed explanation with Retry, and says when no model can write it", () => {
    const failed = (state: ExplanationState) =>
      render(ready(), { openCard: fixtureId(60), explanations: { [fixtureId(60)]: state } });
    const html = failed({ status: "failed", kind: "failed" });
    expect(html).toContain("The explanation could not be written.");
    expect(html).toContain('role="alert"');
    expect(html).toContain(">Retry<");
    expect(failed({ status: "failed", kind: "noModel" })).toContain(
      "No model is set up to write explanations."
    );
  });

  it("ends the writing state when the relation is gone, with no Retry to loop on", () => {
    const html = render(ready(), {
      openCard: fixtureId(60),
      explanations: { [fixtureId(60)]: { status: "unavailable" } }
    });
    expect(html).toContain("This relation is no longer available, so it cannot be explained.");
    expect(html).not.toContain("Writing an explanation");
    expect(html).not.toContain('aria-busy="true"');
    expect(html).not.toContain(">Retry<");
  });

  it("states an unknown direction neutrally and a contrast without claiming a contradiction", () => {
    const unknown = render(
      ready(notePage({ relations: { items: [relationItem({ direction: "unknown" })], total: 1 } })),
      { openCard: fixtureId(60) }
    );
    expect(unknown).toContain("are linked: supports");
    expect(unknown).not.toContain("direction confirmed");
    const contrast = render(
      ready(notePage({ relations: { items: [relationItem({ type: "contrasts" })], total: 1 } })),
      { openCard: fixtureId(60) }
    );
    expect(contrast).toContain("contrasts with");
    expect(text(contrast)).not.toContain("contradicts");
  });

  it("offers more relations and a retry when they failed", () => {
    const page = notePage({ relations: { items: [relationItem()], total: 30 } });
    expect(render(ready(page))).toContain("Show 20 more");
    const failed = render(ready(page), { more: { ...idleMore, shown: { status: "error" } } });
    expect(failed).toContain("More relations could not be loaded.");
  });
});

describe("Note page relation graph tabs (F3 D43)", () => {
  const graph = { active: true, revision: 0 };

  it("offers List and Graph tabs, with the list shown and selected by default", () => {
    const html = render(ready(), { graph });
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Relations view"');
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((match) => match[0]);
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toContain('aria-selected="true"');
    expect(tabs[0]).toContain('tabindex="0"');
    expect(tabs[1]).toContain('aria-selected="false"');
    expect(tabs[1]).toContain('tabindex="-1"');
    expect(html).toContain(">List<");
    expect(html).toContain(">Graph<");
    // The list is the panel the first tab names, and it is the text alternative: the relation is in it.
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain("Spaced repetition flattens the forgetting curve.");
    expect(html).not.toContain('role="application"');
    const panel = /role="tabpanel" id="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`aria-controls="${panel}"`);
  });

  it("has no tabs without the graph's inputs or without a shown relation", () => {
    expect(render(ready())).not.toContain('role="tablist"');
    const none = notePage({ relations: { items: [], total: 0 } });
    const html = render(ready(none), { graph });
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain("No relations to other notes were found.");
  });

  it("keeps the withdrawn and earlier-version groups below the tabs", () => {
    const page = notePage({
      withdrawn: { items: [relationItem({ id: fixtureId(70), state: "withdrawn" })], total: 1 },
      earlierVersions: { items: [], total: 2 }
    });
    const html = render(ready(page), { graph });
    expect(html).toContain("1 relation withdrawn");
    expect(html).toContain("Earlier versions");
    expect(html.indexOf('role="tablist"')).toBeLessThan(html.indexOf("1 relation withdrawn"));
  });

  it("keeps the Graph tab but cannot be chosen, with a notice, when this window cannot draw it", () => {
    const refs = { list: { current: null }, graph: { current: null } };
    const html = renderToString(
      <ViewTabs
        t={en}
        id="tabs"
        view="list"
        graphUnavailable
        onView={noop}
        listTab={refs.list}
        graphTab={refs.graph}
      />
    ).replaceAll("<!-- -->", "");
    const graphTab = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0])[1];
    expect(graphTab).toContain('aria-disabled="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain(
      "The graph cannot be drawn on this computer, so the relations are listed instead."
    );
    const available = renderToString(
      <ViewTabs
        t={en}
        id="tabs"
        view="list"
        graphUnavailable={false}
        onView={noop}
        listTab={refs.list}
        graphTab={refs.graph}
      />
    );
    expect(available).not.toContain('aria-disabled="true"');
    expect(available).not.toContain('role="status"');
  });

  it("says it in every language", () => {
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      const html = render(ready(), { graph }, t);
      expect(html, locale).toContain('role="tablist"');
      expect(html, locale).not.toContain("notePage.");
      expect(html, locale).not.toContain("[[missing");
    }
  });
});

describe("Note page translations", () => {
  it("renders every state in the five locales without missing keys", () => {
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      for (const load of [
        { status: "loading" } as const,
        { status: "error" } as const,
        { status: "missing" } as const,
        ready(),
        ready(
          notePage({ note: { ...notePage().note, authorship: "edited", humanProtected: true } })
        )
      ]) {
        const html = render(load, { openCard: fixtureId(60) }, t);
        expect(html, `${locale} ${load.status}`).not.toContain("[[missing");
        expect(html).not.toContain("notePage.");
      }
      const unavailable = render(
        ready(),
        {
          openCard: fixtureId(60),
          explanations: { [fixtureId(60)]: { status: "unavailable" } }
        },
        t
      );
      const dialog = renderToString(
        <NoteLeaveDialog t={t} onKeepEditing={noop} onDiscard={noop} />
      );
      for (const html of [unavailable, dialog]) {
        expect(html, locale).not.toContain("[[missing");
        expect(html, locale).not.toContain("notePage.");
      }
    }
  });
});

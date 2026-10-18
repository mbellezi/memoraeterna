import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  NoteRelationBandSchema,
  noteRelationBandWords,
  type NotePage,
  type NotePageRelation
} from "@app/domain";
import { createTranslator, supportedLanguageCodes, type Translator } from "@app/i18n";

import { NotePageView, type NotePageViewProps } from "./NotePageView";
import { fixtureId, idleMore, notePage, relationItem, viewProps } from "./note-page-fixtures";

// Relations v2 on the Note page (F3 D15, D42, R29): band words, state, the three actors, Keep and
// Remove, the withdrawn and earlier-version groups. Markup only: the behaviour that needs a
// document (focus, events) lives in pure helpers tested in `note-page-model.test.tsx`.
const en = createTranslator("en");
const plain = (html: string) => html.replaceAll("<!-- -->", "");
const text = (html: string) => plain(html).replace(/<[^>]*>/g, " ");

function render(
  page: NotePage,
  overrides: Partial<NotePageViewProps> = {},
  t: Translator = en
): string {
  return plain(
    renderToString(<NotePageView {...viewProps({ status: "ready", page }, overrides, t)} />)
  );
}

const rel = (n: number, overrides: Partial<NotePageRelation> = {}) =>
  relationItem({
    id: fixtureId(n),
    other: { ...relationItem().other, id: fixtureId(n + 100), ideaStatement: `Idea ${n}.` },
    ...overrides
  });
const pageOf = (
  shown: NotePageRelation[],
  extra: Partial<NotePage> = {},
  total = shown.length
): NotePage => notePage({ relations: { items: shown, total }, ...extra });

describe("band words, never a percentage (D42)", () => {
  const strong = rel(60, { band: "apply", calibration: "frozen", probability: 0.93 });
  const possible = rel(62, {
    state: "suggested",
    band: "suggest",
    calibration: "frozen",
    probability: 0.71
  });
  const notCalibrated = rel(64, {
    state: "suggested",
    band: "suggest",
    calibration: "uncalibrated",
    probability: null
  });
  const legacy = rel(66);
  const kept = rel(68, { state: "kept", band: "suggest", calibration: "frozen", probability: 0.6 });

  it("says the band of a row that has no state chip, and nothing for a legacy or a kept one", () => {
    // A suggested row says "Suggested" and keeps its confidence for the card; an applied one (an
    // apply band wrote it) has no chip, so its band is in the row.
    const html = render(pageOf([strong, possible, notCalibrated, legacy, kept]));
    expect(html).toContain(">Strong</strong>");
    expect(html.match(/Confidence: /g)).toHaveLength(1);
    expect(text(html).match(/Suggested/g)).toHaveLength(2);
    expect(text(html).match(/Kept/g)).toHaveLength(1);
    expect(text(html)).not.toContain("Possible");
    expect(text(html)).not.toContain("Not calibrated");
  });

  it("puts the word in the card beside the type, and the probability never on screen", () => {
    for (const relation of [strong, possible, notCalibrated]) {
      const html = render(pageOf([relation]), { openCard: relation.id });
      expect(text(html)).toMatch(/Confidence:\s+(Strong|Possible|Not calibrated)/);
      expect(text(html)).not.toMatch(/\d\s*%/);
      expect(html).not.toContain(String(relation.probability ?? "never"));
    }
    expect(text(render(pageOf([legacy]), { openCard: legacy.id }))).not.toContain("Confidence");
  });

  it("works with no apply band at all (decision 29): suggestions, kept and withdrawn relations never say strong or applied", () => {
    const withdrawn = rel(70, { state: "withdrawn", vetoSource: "explainer" });
    const page = pageOf([possible, notCalibrated, kept], {
      withdrawn: { items: [withdrawn], total: 1 }
    });
    for (const relation of [possible, notCalibrated, kept]) {
      const html = render(page, { withdrawnOpen: true, openCard: relation.id });
      expect(text(html)).not.toContain("Strong");
      expect(text(html)).not.toContain("applied automatically");
    }
    const opened = render(page, { withdrawnOpen: true, openCard: possible.id });
    expect(text(opened)).toMatch(/Confidence:\s+Possible/);
    const uncalibrated = render(page, { withdrawnOpen: true, openCard: notCalibrated.id });
    expect(text(uncalibrated)).toMatch(/Confidence:\s+Not calibrated/);
    // Only the owner makes a relation final: Keep and Remove are there, and a kept one says so.
    expect(text(opened)).toContain("Keep confirms this relation. Remove is final");
    expect(text(render(page, { openCard: kept.id }))).toContain("You kept this relation.");
    expect(text(render(page, { withdrawnOpen: true, openCard: withdrawn.id }))).not.toContain(
      "Confidence"
    );
  });

  it("never says a suggestion stays out of the graph: where suggestions are drawn is not this page's to state", () => {
    const html = render(pageOf([possible]), { openCard: possible.id });
    expect(text(html)).toContain("This relation is a suggestion. Keep it to make it yours");
    expect(text(html)).not.toMatch(/graph|source links/i);
  });

  it("gives every band a word, in every language, so a new tier cannot ship without its copy", () => {
    for (const band of NoteRelationBandSchema.options) {
      const word = noteRelationBandWords[band];
      expect(word, band).toBeTruthy();
      for (const code of supportedLanguageCodes) {
        const translate = createTranslator(code);
        const key = `notePage.band.${word}` as const;
        expect(translate(key), `${code} ${key}`).not.toBe(key);
        expect(translate(key), `${code} ${key}`).not.toContain("[[missing");
      }
    }
  });

  it("says it in every language, with the word of the band and its own state words", () => {
    for (const code of supportedLanguageCodes) {
      const t = createTranslator(code);
      const row = render(pageOf([strong, possible, notCalibrated]), {}, t);
      expect(row, code).toContain(t("notePage.band.strong"));
      expect(row, code).toContain(t("notePage.state.suggested"));
      for (const [relation, key] of [
        [possible, "notePage.band.possible"],
        [notCalibrated, "notePage.band.uncalibrated"]
      ] as const) {
        expect(t(key), `${code} ${key}`).not.toBe(key);
        expect(
          render(pageOf([relation]), { openCard: relation.id }, t),
          `${code} ${key}`
        ).toContain(t(key));
      }
    }
  });
});

describe("state of a relation", () => {
  it("marks a suggested, a kept and a withdrawn relation, and an applied one with nothing", () => {
    const html = render(
      pageOf(
        [rel(60), rel(62, { state: "suggested", band: "suggest" }), rel(64, { state: "kept" })],
        {
          withdrawn: { items: [rel(66, { state: "withdrawn", vetoSource: "explainer" })], total: 1 }
        }
      ),
      { withdrawnOpen: true }
    );
    expect(text(html)).toContain("Suggested");
    expect(text(html)).toContain("Kept");
    expect(text(html)).toContain("Withdrawn");
    // Each row has one chip at most.
    expect(html.match(/rounded-full border border-border/g)?.length).toBe(3);
  });

  it("explains each state in the card", () => {
    const open = (relation: NotePageRelation) =>
      text(render(pageOf([relation]), { openCard: relation.id }));
    expect(open(rel(60, { state: "suggested", band: "suggest" }))).toContain(
      "This relation is a suggestion."
    );
    expect(open(rel(60, { state: "kept" }))).toContain("You kept this relation.");
    expect(open(rel(60, { state: "withdrawn", vetoSource: "explainer" }))).toContain(
      "The model that writes explanations found these notes unrelated, so this relation is hidden."
    );
    expect(open(rel(60, { state: "withdrawn", vetoSource: "typer" }))).toContain(
      "The typing step found no real link between these notes"
    );
    expect(open(rel(60))).not.toContain("This relation is a suggestion");
  });

  it("does not repeat the veto when the writer found the notes unrelated a moment ago", () => {
    const html = render(pageOf([rel(60)]), {
      openCard: fixtureId(60),
      explanations: { [fixtureId(60)]: { status: "vetoed" } }
    });
    expect(text(html)).toContain("now hidden");
    expect(text(html)).not.toContain("so this relation is hidden.");
  });
});

describe("three actors (D42)", () => {
  it("lists who decided, typed and explained, in that order, with where each ran", () => {
    const relation = rel(60, {
      decidedBy: { model: "ranker-x", kind: "local" },
      typedBy: { model: "typer-y", kind: "remote" },
      explainedBy: { model: "writer-z", kind: null }
    });
    const html = render(pageOf([relation]), { openCard: relation.id });
    const card = html.slice(html.indexOf('role="group"'));
    const lines = [...card.matchAll(/<dt[^>]*>([^<]*)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map((match) => [
      match[1],
      text(match[2]!).replace(/\s+/g, " ").trim()
    ]);
    expect(lines).toEqual([
      ["Decided", "ranker-x · on this computer"],
      ["Typed", "typer-y · online"],
      ["Explained", "writer-z"]
    ]);
  });

  it("shows a line only for a step that is known", () => {
    const html = render(pageOf([rel(60, { decidedBy: null })]), { openCard: fixtureId(60) });
    expect(html.slice(html.indexOf('role="group"'))).not.toContain("<dl");
    const only = render(pageOf([rel(60, { typedBy: { model: "typer-y", kind: null } })]), {
      openCard: fixtureId(60)
    });
    expect(only).toContain(">Typed<");
    expect(only).not.toContain(">Explained<");
  });
});

describe("Keep and Remove (D15)", () => {
  const buttons = (html: string) =>
    [...html.matchAll(/<button[^>]*>(?:<svg.*?<\/svg>)?(Keep|Remove)<\/button>/g)].map(
      (match) => match[1]
    );
  const open = (relation: NotePageRelation, overrides: Partial<NotePageViewProps> = {}) =>
    render(pageOf([relation]), { openCard: relation.id, ...overrides });

  it("are offered on a suggested relation and on a withdrawn one, and on one withdrawn a moment ago", () => {
    expect(buttons(open(rel(60, { state: "suggested", band: "suggest" })))).toEqual([
      "Keep",
      "Remove"
    ]);
    const withdrawn = rel(62, { state: "withdrawn", vetoSource: "explainer" });
    expect(
      buttons(
        render(pageOf([], { withdrawn: { items: [withdrawn], total: 1 } }), {
          withdrawnOpen: true,
          openCard: withdrawn.id
        })
      )
    ).toEqual(["Keep", "Remove"]);
    expect(
      buttons(open(rel(64), { explanations: { [fixtureId(64)]: { status: "vetoed" } } }))
    ).toEqual(["Keep", "Remove"]);
  });

  it("are not offered on an applied relation, a kept one or one to an earlier version", () => {
    expect(buttons(open(rel(60)))).toEqual([]);
    expect(buttons(open(rel(62, { state: "kept" })))).toEqual([]);
    const earlier = rel(64);
    expect(
      buttons(
        render(pageOf([], { earlierVersions: { items: [earlier], total: 1 } }), {
          openCard: earlier.id
        })
      )
    ).toEqual([]);
  });

  it("come after their row in the page, so one Tab from the row reaches them", () => {
    const html = open(rel(60, { state: "suggested", band: "suggest" }));
    const row = html.indexOf('data-relation-button="');
    const keep = html.indexOf(">Keep<");
    const remove = html.indexOf(">Remove<");
    expect(row).toBeGreaterThan(-1);
    expect(keep).toBeGreaterThan(row);
    expect(remove).toBeGreaterThan(keep);
  });

  it("say what each one does, and stop while a verdict is saved", () => {
    const suggested = rel(60, { state: "suggested", band: "suggest" });
    const idle = open(suggested);
    expect(text(idle)).toContain("Keep confirms this relation. Remove is final");
    const scope = idle.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(scope).toBeTruthy();
    expect(idle).toContain(`id="${scope}"`);
    expect(idle).not.toContain('disabled=""');
    const saving = open(suggested, { reviews: { [suggested.id]: { status: "pending" } } });
    // Not `disabled`: a disabled button can lose the focus, and the card closes with it.
    expect(saving).not.toContain('disabled=""');
    // Both buttons and, on a directed type, the three radios of the owner's direction (31b).
    expect(saving.match(/aria-disabled="true"/g)).toHaveLength(5);
    expect(saving).toContain('aria-busy="true"');
  });

  it("show a verdict that could not be saved as an alert, with both choices still there", () => {
    const suggested = rel(60, { state: "suggested", band: "suggest" });
    const html = open(suggested, { reviews: { [suggested.id]: { status: "failed" } } });
    expect(html).toMatch(/role="alert"[^>]*>Your choice could not be saved\. Try again\./);
    expect(buttons(html)).toEqual(["Keep", "Remove"]);
    expect(html).not.toContain('disabled=""');
  });
});

describe("withdrawn relations and earlier versions", () => {
  const withdrawnRows = [
    rel(70, { state: "withdrawn", vetoSource: "explainer" }),
    rel(72, { state: "withdrawn", vetoSource: "typer" })
  ];
  const earlierRows = [{ ...rel(80), other: { ...rel(80).other, superseded: true } }];

  it("count the withdrawn ones behind Show, listing none until asked", () => {
    const page = pageOf([rel(60)], { withdrawn: { items: withdrawnRows, total: 2 } });
    const collapsed = render(page);
    expect(collapsed).toContain("2 relations withdrawn");
    expect(collapsed).toMatch(/aria-expanded="false"[^>]*>(?:<svg.*?<\/svg>)?Show</);
    expect(collapsed).not.toContain("Idea 70.");
    // The list the toggle controls is not in the page while it is collapsed.
    expect(collapsed).not.toContain("aria-controls");
    // The main count is the shown relations only.
    expect(collapsed).toMatch(/Relations<\/h2><span[^>]*>1<\/span>/);
    const opened = render(page, { withdrawnOpen: true });
    expect(opened).toMatch(/aria-expanded="true"[^>]*>(?:<svg.*?<\/svg>)?Hide</);
    expect(opened).toContain("Idea 70.");
    expect(opened).toContain("Idea 72.");
    expect(opened).toContain("Automatic checks found these notes unrelated.");
    const controls = opened.match(/aria-controls="([^"]+)"/)?.[1];
    expect(opened).toContain(`id="${controls}"`);
  });

  it("say one relation in the singular and offer more past the first page", () => {
    const one = render(pageOf([], { withdrawn: { items: [withdrawnRows[0]!], total: 1 } }));
    expect(one).toContain("1 relation withdrawn");
    const many = render(pageOf([], { withdrawn: { items: withdrawnRows, total: 45 } }), {
      withdrawnOpen: true
    });
    expect(many).toContain("45 relations withdrawn");
    expect(many).toContain("Show 20 more");
    expect(
      render(pageOf([], { withdrawn: { items: withdrawnRows, total: 45 } }), {
        withdrawnOpen: true,
        more: { ...idleMore, withdrawn: { status: "error" } }
      })
    ).toContain("More relations could not be loaded.");
  });

  it("list the earlier versions in their own group with the superseded flag, outside the shown count", () => {
    const html = render(pageOf([rel(60)], { earlierVersions: { items: earlierRows, total: 3 } }));
    expect(html).toMatch(/<h3[^>]*>Earlier versions<\/h3>/);
    expect(text(html)).toContain("Superseded");
    expect(text(html)).toContain("Relations to a note that a newer version replaced");
    expect(html).toContain("Show 2 more");
    // Shown relations count only themselves: the group has its own number.
    expect(html).toMatch(/Relations<\/h2><span[^>]*>1<\/span>/);
    expect(html.indexOf("Idea 80.")).toBeGreaterThan(html.indexOf("Earlier versions"));
    expect(html.indexOf("Idea 80.")).toBeGreaterThan(html.indexOf("Idea 60."));
  });

  it("show no group heading when the group is empty, and the empty sentence only when all three are", () => {
    const none = render(pageOf([]));
    expect(none).toContain("No relations to other notes were found.");
    expect(none).not.toContain("Earlier versions");
    expect(none).not.toContain("withdrawn");
    const onlyWithdrawn = render(pageOf([], { withdrawn: { items: withdrawnRows, total: 2 } }));
    expect(onlyWithdrawn).not.toContain("No relations to other notes were found.");
    expect(onlyWithdrawn).toContain("2 relations withdrawn");
  });

  it("gives every heading a place for focus to land when a row leaves its list", () => {
    const html = render(
      pageOf([rel(60)], {
        withdrawn: { items: withdrawnRows, total: 2 },
        earlierVersions: { items: earlierRows, total: 1 }
      })
    );
    expect(html.match(/<h[23][^>]*tabindex="-1"/g)).toHaveLength(3);
    for (const id of [60, 80]) expect(html).toContain(`data-relation-button="${fixtureId(id)}"`);
  });
});

describe("every state in the five languages", () => {
  it("renders the card of each state without missing keys or raw keys", () => {
    const rows = [
      rel(60, {
        state: "suggested",
        band: "suggest",
        calibration: "uncalibrated",
        decidedBy: { model: "a", kind: "local" },
        typedBy: { model: "b", kind: "remote" },
        explainedBy: { model: "c", kind: null }
      }),
      rel(62, { state: "kept", band: "apply", calibration: "frozen" }),
      rel(64, { band: "apply", calibration: "provisional" })
    ];
    const withdrawn = [
      rel(66, { state: "withdrawn", vetoSource: "explainer" }),
      rel(68, { state: "withdrawn", vetoSource: "typer" })
    ];
    for (const code of supportedLanguageCodes) {
      const t = createTranslator(code);
      for (const relation of [...rows, ...withdrawn]) {
        const html = render(
          pageOf(rows, {
            withdrawn: { items: withdrawn, total: 30 },
            earlierVersions: { items: [rel(80)], total: 1 }
          }),
          {
            withdrawnOpen: true,
            openCard: relation.id,
            reviews: { [fixtureId(66)]: { status: "failed" } },
            more: { ...idleMore, withdrawn: { status: "error" } }
          },
          t
        );
        expect(html, `${code} ${relation.state}`).not.toContain("[[missing");
        expect(html, `${code} ${relation.state}`).not.toMatch(/notePage\.[a-zA-Z]+\./);
      }
    }
  });

  it("gives the new words their own text in every language", () => {
    const keys = [
      "notePage.announce.kept",
      "notePage.announce.removed",
      "notePage.announce.withdrawn",
      "notePage.relations.withdrawn",
      "notePage.relations.withdrawnOne",
      "notePage.relations.withdrawnHint",
      "notePage.relations.showWithdrawn",
      "notePage.relations.hideWithdrawn",
      "notePage.relations.earlierTitle",
      "notePage.relations.earlierHint",
      "notePage.card.confidence",
      "notePage.card.typed",
      "notePage.card.explained",
      "notePage.card.kindLocal",
      "notePage.card.kindRemote",
      "notePage.card.suggestedHint",
      "notePage.card.keptNote",
      "notePage.card.withdrawnExplainer",
      "notePage.card.withdrawnTyper",
      "notePage.card.keep",
      "notePage.card.remove",
      "notePage.card.reviewScope",
      "notePage.card.reviewFailed"
    ] as const;
    for (const code of supportedLanguageCodes) {
      const t = createTranslator(code);
      for (const key of keys) {
        expect(t(key), `${code} ${key}`).not.toBe(key);
        expect(t(key), `${code} ${key}`).not.toContain("[[missing");
      }
      // The placeholders survive translation.
      expect(t("notePage.card.confidence")).toContain("{word}");
      expect(t("notePage.relations.withdrawn")).toContain("{count}");
      // Keep and Remove are two different words.
      expect(t("notePage.card.keep")).not.toBe(t("notePage.card.remove"));
    }
  });
});

describe("direction of an automatic relation (plan decision 31b)", () => {
  const suggested = (n: number, overrides: Partial<NotePageRelation> = {}) =>
    rel(n, {
      type: "extends",
      state: "suggested",
      band: "suggest",
      direction: "unknown",
      directionSource: null,
      ...overrides
    });
  const open = (relation: NotePageRelation, overrides: Partial<NotePageViewProps> = {}) =>
    render(pageOf([relation]), { openCard: relation.id, ...overrides });
  /** The visible text with its emphasis joined to the words around it. */
  const flat = (html: string) =>
    plain(html)
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ");
  const radios = (html: string) =>
    [
      ...html.matchAll(/<label[^>]*><input type="radio"([^>]*)\/><span>([^<]*)<\/span><\/label>/g)
    ].map((match) => ({ label: match[2]!, checked: match[1]!.includes('checked=""') }));

  it("calls a relation nobody gave a direction linked, in its row and in its card, and states no one extends", () => {
    const html = open(suggested(60));
    // The row's label reads "linked: extends", never the bare verb beside the other note.
    expect(text(html)).toContain("linked: extends");
    expect(flat(html)).toContain("This note and “Idea 60.” are linked: extends");
    expect(text(html)).not.toContain("direction confirmed");
    expect(text(html)).not.toContain("direction set by you");
    // A relation that reads both ways is not "linked".
    const symmetric = open(suggested(62, { type: "contradicts" }));
    expect(text(symmetric)).not.toContain("linked:");
    expect(flat(symmetric)).toContain("This note contradicts");
  });

  it("states a direction only for the one who gave it, and says who", () => {
    const owner = open(suggested(60, { direction: "outgoing", directionSource: "owner" }));
    expect(flat(owner)).toContain("This note extends “Idea 60.”");
    expect(text(owner)).toContain("direction set by you");
    expect(text(owner)).not.toContain("linked:");
    const decider = open(suggested(62, { direction: "incoming", directionSource: "decider" }));
    expect(flat(decider)).toContain("“Idea 62.” extends this note");
    expect(text(decider)).toContain("direction suggested by OpenAI Decisions");
    // A legacy relation was decided with its direction and keeps saying so.
    const legacy = open(rel(64, { type: "extends", direction: "outgoing", directionSource: null }));
    expect(text(legacy)).toContain("direction confirmed");
  });

  it("offers the direction beside Keep, none by default, as a group of three radios", () => {
    const html = open(suggested(60));
    expect(html).toContain("<fieldset");
    expect(html).toMatch(/<legend[^>]*>Direction<\/legend>/);
    expect(radios(html)).toEqual([
      { label: "No direction", checked: true },
      { label: "This note extends the other note", checked: false },
      { label: "The other note extends this note", checked: false }
    ]);
    // The radios share one name, and the group is described by the hint that follows it.
    const names = [...html.matchAll(/<input type="radio"[^>]*name="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(1);
    expect(names).toHaveLength(3);
    const hint = html.match(/<fieldset[^>]*aria-describedby="([^"]+)"/)?.[1];
    expect(hint).toBeTruthy();
    expect(html).toContain(`id="${hint}"`);
    expect(text(html)).toContain(
      "Optional. Your choice is saved when you keep the relation; with no direction, the notes stay linked."
    );
    // It comes before Keep and Remove, so Tab reaches the choice first.
    expect(html.indexOf("<fieldset")).toBeLessThan(html.indexOf(">Keep<"));
  });

  it("opens on the direction the card already shows, so a Keep confirms what it says", () => {
    expect(
      radios(open(suggested(60, { direction: "outgoing", directionSource: "decider" })))
    ).toEqual([
      { label: "No direction", checked: false },
      { label: "This note extends the other note", checked: true },
      { label: "The other note extends this note", checked: false }
    ]);
    expect(
      radios(open(suggested(62, { direction: "incoming", directionSource: "decider" }))).map(
        (radio) => radio.checked
      )
    ).toEqual([false, false, true]);
  });

  it("offers no direction for a type that reads both ways, for a kept relation or while it is applied", () => {
    expect(open(suggested(60, { type: "same_as" }))).not.toContain("<fieldset");
    expect(open(suggested(62, { state: "kept" }))).not.toContain("<fieldset");
    expect(open(rel(64, { type: "extends", direction: "outgoing" }))).not.toContain("<fieldset");
    // A withdrawn relation the owner may still keep offers it too.
    const withdrawn = suggested(66, { state: "withdrawn", band: "apply", vetoSource: "typer" });
    expect(
      render(pageOf([], { withdrawn: { items: [withdrawn], total: 1 } }), {
        withdrawnOpen: true,
        openCard: withdrawn.id
      })
    ).toContain("<fieldset");
  });

  it("offers no direction on a legacy relation, which the server would not record, yet still offers Keep and Remove", () => {
    // A legacy row (no band) the explainer withdrew a moment ago, and one withdrawn earlier.
    const legacy = suggested(60, { state: "applied", band: null, direction: "outgoing" });
    const vetoed = open(legacy, { explanations: { [legacy.id]: { status: "vetoed" } } });
    expect(vetoed).not.toContain("<fieldset");
    expect(vetoed).toContain(">Keep<");
    expect(vetoed).toContain(">Remove<");
    const withdrawn = suggested(62, {
      state: "withdrawn",
      band: null,
      direction: "outgoing",
      vetoSource: "explainer"
    });
    const html = render(pageOf([], { withdrawn: { items: [withdrawn], total: 1 } }), {
      withdrawnOpen: true,
      openCard: withdrawn.id
    });
    expect(html).not.toContain("<fieldset");
    expect(html).toContain(">Keep<");
  });

  it("stops answering the choice while a verdict is saved, without disabling it", () => {
    const relation = suggested(60);
    const saving = open(relation, { reviews: { [relation.id]: { status: "pending" } } });
    expect(saving).not.toContain('disabled=""');
    // Two buttons and three radios say they do not answer.
    expect(saving.match(/aria-disabled="true"/g)).toHaveLength(5);
  });

  it("says it in every language with no raw key", () => {
    for (const code of supportedLanguageCodes) {
      const t = createTranslator(code);
      for (const key of [
        "notePage.linkedStance",
        "notePage.card.directionOwner",
        "notePage.card.directionDecider",
        "notePage.card.direction.legend",
        "notePage.card.direction.none",
        "notePage.card.direction.otherSubject",
        "notePage.card.direction.otherObject",
        "notePage.card.direction.hint",
        "knowledge.relations.linked"
      ] as const) {
        expect(t(key), `${code} ${key}`).not.toBe(key);
        expect(t(key), `${code} ${key}`).not.toContain("[[missing");
      }
      expect(t("notePage.linkedStance"), code).toContain("{type}");
      expect(t("knowledge.relations.linked"), code).toContain("{type}");
      for (const relation of [
        suggested(60),
        suggested(62, { direction: "outgoing", directionSource: "owner" }),
        suggested(64, { direction: "incoming", directionSource: "decider" })
      ]) {
        const html = render(pageOf([relation]), { openCard: relation.id }, t);
        expect(html, `${code} ${relation.id}`).not.toContain("[[missing");
        expect(html, `${code} ${relation.id}`).not.toMatch(/notePage\.[a-zA-Z.]+/);
        expect(html, `${code} ${relation.id}`).not.toMatch(/\{[a-z]+\}/);
      }
      // The owner's sentence reads in each language, one way and then the other.
      const [, thisToOther, otherToThis] = radios(
        render(pageOf([suggested(66)]), { openCard: fixtureId(66) }, t)
      );
      expect(thisToOther!.label, code).not.toBe(otherToThis!.label);
      expect(thisToOther!.label, code).toContain(t("notePage.card.direction.otherObject"));
      expect(otherToThis!.label, code).toContain(t("notePage.card.direction.otherSubject"));
    }
  });
});

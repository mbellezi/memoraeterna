import type { NotePage } from "@app/domain";

import { fixtureId, notePage, relationItem } from "../../components/note-page/note-page-fixtures";
import type { ScreenModule } from "../surfaces";
import { Component } from "./note.panel";
import { located, PanelStackScreen, placePath } from "./panel-screen-parts";

export const surface = "note";

const top = fixtureId(1);
const previous = fixtureId(2);

const topAddress = `memora://note/${top}`;
const previousAddress = `memora://note/${previous}`;

const alsoIn = [{ kind: "topic" as const, id: fixtureId(7), title: "Fermented foods" }];

/** The note of design record 17 (the fermentation library), in English: content, not chrome. */
function page(id: string): NotePage {
  const base = notePage();
  const first = id === top;
  const title = first
    ? "Lactic acid inhibits pathogens by lowering the pH"
    : "Temperature controls the final acidity";
  return {
    ...base,
    note: {
      ...base.note,
      id,
      title,
      ideaStatement: title,
      bodyMarkdown: first
        ? [
            "When lactic acid bacteria consume the sugars of a food, the lactic acid they produce brings the pH down to about 4. ",
            "At that acidity most of the bacteria that spoil food or cause disease cannot multiply.\n\n",
            "That is why sauerkraut, yoghurt and pickled vegetables keep for weeks outside the fridge: the fermentation itself builds the barrier that protects the food.\n\n",
            "The barrier is not absolute. Acid-resistant spores survive, which is why badly sealed preserves can still spoil."
          ].join("")
        : "A cooler ferment ends less acid and more aromatic.",
      generationModel: "Local AI"
    },
    evidence: {
      total: 2,
      items: [
        {
          ...base.evidence.items[0]!,
          sourceTitle: "Food microbiology, ch. 3",
          excerpt:
            "…a pH below 4.2 the growth of common pathogens is practically inhibited, which explains the stability of fermented vegetables…",
          page: 47
        },
        {
          ...base.evidence.items[0]!,
          chunkId: fixtureId(43),
          primary: false,
          sourceTitle: "Preserves and salting in the 19th century",
          excerpt: "“Salted cabbage crossed the winter in cellars, with no ice and no spoilage.”",
          page: 112
        }
      ]
    },
    relations: {
      total: 4,
      items: [
        relationItem({
          id: fixtureId(60),
          type: "supports",
          band: "apply",
          probability: 0.92,
          other: {
            ...relationItem().other,
            title: "Salt and acidity preserved food before ice",
            ideaStatement: "In the 19th century, salt and acidity preserved food without ice.",
            sourceTitle: "Preserves and salting in the 19th century"
          }
        }),
        relationItem({
          id: fixtureId(64),
          type: "extends",
          other: {
            ...relationItem().other,
            id: fixtureId(65),
            title: "Temperature controls the final acidity",
            ideaStatement: "Temperature controls the final acidity.",
            sourceTitle: "Food microbiology, ch. 3"
          }
        }),
        relationItem({
          id: fixtureId(66),
          type: "depends_on",
          other: {
            ...relationItem().other,
            id: fixtureId(67),
            title: "Lactic bacteria tolerate an acid medium",
            ideaStatement: "Lactic bacteria tolerate an acid medium.",
            sourceTitle: "Food microbiology, ch. 3"
          }
        }),
        relationItem({
          id: fixtureId(68),
          type: "supports",
          state: "suggested",
          band: "suggest",
          probability: 0.7,
          other: {
            ...relationItem().other,
            id: fixtureId(69),
            title: "Kefir inhibits Salmonella in lab tests",
            ideaStatement: "Kefir inhibits Salmonella in laboratory tests.",
            sourceTitle: "Fermented milks"
          }
        })
      ]
    },
    placement: located("note", id, title, { alsoIn })
  };
}

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "notes.page": ({ noteId }: { noteId: string }) => page(noteId),
    "notes.relations": { items: [], total: 0 },
    "objects.locate": ({ address }: { address: string }) =>
      located(
        "note",
        address.slice(-36),
        address.endsWith(top) ? "Lactic acid inhibits pathogens by lowering the pH" : "Note",
        {
          alsoIn: address.endsWith(top) ? alsoIn : []
        }
      ),
    "viewHistory.record": null,
    "knowledge.reviewNote": null
  },
  // A note that is gone: merged into another or removed.
  empty: {
    "notes.page": null,
    "notes.relations": { items: [], total: 0 },
    "objects.locate": ({ address }: { address: string }) =>
      located("note", address.slice(-36), "Note", { path: placePath.slice(0, 2) }),
    "viewHistory.record": null
  }
};

export function render() {
  return (
    <PanelStackScreen
      surface={surface}
      kind="note"
      Component={Component}
      previous={{ address: previousAddress, title: "Temperature controls the final acidity" }}
      top={{ address: topAddress, title: "Lactic acid inhibits pathogens by lowering the pH" }}
    />
  );
}

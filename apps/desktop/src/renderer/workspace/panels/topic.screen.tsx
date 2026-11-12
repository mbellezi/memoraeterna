import type { TopicPage } from "@app/domain";

import {
  centralNote,
  topicFixtureId,
  topicPage
} from "../../components/topic-page/topic-page-fixtures";
import type { ScreenModule } from "../surfaces";
import { located, PanelStackScreen, placePath } from "./panel-screen-parts";
import { Component } from "./topic.panel";

export const surface = "topic";

// Ids as `placePath` has them: Fermentation (5) sits under Microbiology; Lactic fermentation (6) is
// one of its subtopics, so the previous panel lists the row that opened the top one.
const topId = topicFixtureId(6);
const previousId = topicFixtureId(5);
const topAddress = `memora://topic/${topId}`;
const previousAddress = `memora://topic/${previousId}`;

/** The fermentation library of design record 17, in English: content, not chrome. */
function page(id: string): TopicPage {
  const base = topicPage();
  const top = id === topId;
  const title = top ? "Lactic fermentation" : "Fermentation";
  const notes = [
    "Lactic acid inhibits pathogens by lowering the pH",
    "Kefir gathers bacteria and yeasts in one colony",
    "Kombucha gets more acid every day of fermentation",
    "Lactic bacteria tolerate an acid medium"
  ];
  return {
    ...base,
    topic: {
      ...base.topic,
      id,
      title,
      children: top ? 0 : 2,
      description: null,
      aliases: [],
      items: top ? 18 : 32
    },
    path: [
      ...placePath.map(({ id: pathId, title: pathTitle }) => ({
        id: pathId,
        title: pathTitle === "" ? null : pathTitle
      })),
      ...(top ? [{ id: topId, title }] : [])
    ],
    counts: { notes: top ? 18 : 32, sources: top ? 2 : 3, subtopics: top ? 0 : 2 },
    subtopics: top
      ? []
      : [
          { id: topId, title: "Lactic fermentation", items: 18, description: null, health: "good" },
          {
            id: topicFixtureId(7),
            title: "Alcoholic fermentation",
            items: 9,
            description: null,
            health: "good"
          }
        ],
    centralNotes: notes.map((text, index) =>
      centralNote({
        id: topicFixtureId(100 + index),
        title: text,
        idea: text,
        sourceId: topicFixtureId(200),
        sourceTitle: "Food microbiology, ch. 3"
      })
    ),
    moreNotes: top ? 14 : 28,
    sources: [
      {
        id: topicFixtureId(200),
        title: "Food microbiology, ch. 3",
        subtitle: "Textbook, English",
        noteCount: top ? 12 : 20
      },
      {
        id: topicFixtureId(201),
        title: "Preserves and salting in the 19th century",
        subtitle: "Book, English",
        noteCount: top ? 6 : 12
      }
    ],
    relatedTopics: [
      { id: topicFixtureId(20), title: "Salting and curing", relationCount: 8 },
      { id: topicFixtureId(21), title: "Food safety", relationCount: 3 }
    ],
    lastChange: null,
    overview: {
      status: "ready",
      stale: false,
      paragraphs: [
        {
          text: [
            "Lactic bacteria turn sugars into lactic acid and, with that, preserve food [1]. ",
            "It is the base of yoghurt, sauerkraut, kefir and brine pickles [2]. ",
            "The acidity alone is not enough: salt and the lack of oxygen complete the barrier [3]."
          ].join(""),
          citations: [1, 2, 3]
        }
      ],
      citations: [1, 2, 3].map((n) => ({
        n,
        chunkId: topicFixtureId(500 + n),
        sourceSpanId: topicFixtureId(510 + n),
        noteId: topicFixtureId(99 + n),
        sourceId: topicFixtureId(200),
        sourceTitle: "Food microbiology, ch. 3",
        excerpt: "…a pH below 4.2 the growth of common pathogens is practically inhibited…",
        available: true
      })),
      evidence: { used: 6, total: 18 },
      writtenAt: "2026-11-11T23:50:00.000Z",
      model: "Qwen3 14B",
      language: "en",
      support: { status: "verified", unsupported: [], sentences: { checked: 3, supported: 3 } }
    }
  } as TopicPage;
}

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "topics.page": ({ id }: { id: string }) => page(id),
    "topics.notes": { items: [], nextCursor: null },
    "objects.locate": ({ address }: { address: string }) =>
      address.endsWith(topId)
        ? located("topic", topId, "Lactic fermentation", {
            path: [...placePath, { kind: "topic", id: topId, title: "Lactic fermentation" }]
          })
        : located("topic", previousId, "Fermentation"),
    "viewHistory.record": null,
    "topics.overview": { status: "absent", canWrite: false },
    "topics.cancelOverview": false
  },
  // A topic that is gone: merged into another or removed.
  empty: {
    "topics.page": null,
    "topics.notes": { items: [], nextCursor: null },
    "objects.locate": ({ address }: { address: string }) =>
      located("topic", address.slice(-36), "Fermentation"),
    "viewHistory.record": null
  }
};

export function render() {
  return (
    <PanelStackScreen
      surface={surface}
      kind="topic"
      Component={Component}
      previous={{ address: previousAddress, title: "Fermentation" }}
      top={{ address: topAddress, title: "Lactic fermentation" }}
    />
  );
}

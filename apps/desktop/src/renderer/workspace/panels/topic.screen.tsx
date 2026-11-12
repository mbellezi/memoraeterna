import type { TopicPage } from "@app/domain";

import {
  centralNote,
  topicFixtureId,
  topicPage
} from "../../components/topic-page/topic-page-fixtures";
import type { ScreenModule } from "../surfaces";
import { located, PanelStackScreen } from "./panel-screen-parts";
import { Component } from "./topic.panel";

export const surface = "topic";

const topId = topicFixtureId(3);
const previousId = topicFixtureId(2);
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
      { id: topicFixtureId(1), title: null },
      { id: previousId, title: "Fermentation" },
      ...(top ? [{ id: topId, title }] : [])
    ].slice(0, top ? 3 : 2),
    counts: { notes: top ? 18 : 32, sources: top ? 2 : 3, subtopics: top ? 0 : 2 },
    subtopics: top ? [] : base.subtopics,
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
      model: "Local AI",
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
      located(
        "topic",
        address.slice(-36),
        address.endsWith(topId) ? "Lactic fermentation" : "Fermentation"
      ),
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

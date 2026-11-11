import { createTranslator } from "@app/i18n";

import type { ScreenModule } from "../../workspace/surfaces";
import { topicFixtureId, topicPage } from "./topic-page-fixtures";
import { TopicPage } from "./TopicPage";

export const surface = "topic-page";

const t = createTranslator("en");
const noop = () => undefined;

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "topics.page": topicPage(),
    "topics.notes": { items: [], nextCursor: null },
    "objects.locate": null,
    "viewHistory.record": null
  },
  empty: {
    // A topic that holds nothing yet: no notes, sources, subtopics or neighbours.
    "topics.page": topicPage({
      topic: { ...topicPage().topic, items: 0, directItems: 0, children: 0, newThisWeek: 0 },
      counts: { notes: 0, sources: 0, subtopics: 0 },
      subtopics: [],
      centralNotes: [],
      moreNotes: 0,
      sources: [],
      relatedTopics: [],
      lastChange: null
    }),
    "topics.notes": { items: [], nextCursor: null },
    "objects.locate": null,
    "viewHistory.record": null
  }
};

export function render() {
  return <TopicPage topicId={topicFixtureId(3)} active t={t} onNavigate={noop} onClose={noop} />;
}

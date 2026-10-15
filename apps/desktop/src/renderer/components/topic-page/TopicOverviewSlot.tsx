import type { TopicOverviewState } from "@app/domain";
import type { Translator } from "@app/i18n";

import type { TopicPageActions } from "./topic-page-model";

export interface TopicOverviewSlotProps {
  t: Translator;
  topic: { id: string; title: string };
  /** What the page read: no overview yet, one being written, one ready or a failure. */
  overview: TopicOverviewState;
  /** False while the host view is hidden: the slot loads nothing and holds nothing open. */
  active: boolean;
  actions: TopicPageActions;
}

/**
 * Where the lazy overview of the topic appears, between the header and the map of content. It is
 * empty until the overview task fills it; that task changes this file only, and the page already
 * passes everything an overview needs.
 */
export function TopicOverviewSlot(props: TopicOverviewSlotProps): null {
  void props;
  return null;
}

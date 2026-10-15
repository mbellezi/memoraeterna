import type { Translator } from "@app/i18n";

import type { TopicPageActions } from "./topic-page-model";

export interface TopicAskSlotProps {
  t: Translator;
  topic: { id: string; title: string };
  /** False while the host view is hidden: the slot loads nothing and holds nothing open. */
  active: boolean;
  actions: TopicPageActions;
}

/**
 * Where "Ask about this topic" appears, at the end of the side column. It is empty until the Ask
 * task fills it; that task changes this file only.
 */
export function TopicAskSlot(props: TopicAskSlotProps): null {
  void props;
  return null;
}

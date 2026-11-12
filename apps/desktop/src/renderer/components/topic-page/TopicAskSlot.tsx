import { useId } from "react";
import { MessageCircle } from "lucide-react";
import type { Translator } from "@app/i18n";

import { useObjectLinkContext, type ObjectOpen } from "../../workspace/ObjectLink";
import { formatView } from "../../workspace/route";
import { Button } from "../ui/button";
import type { TopicPageActions } from "./topic-page-model";

export interface TopicAskSlotProps {
  t: Translator;
  topic: { id: string; title: string };
  /**
   * What the side column still passes (the slot used to keep a dialog open and open the cited
   * source through the page's actions). The Ask panel does both now, so the slot reads neither.
   */
  active?: boolean;
  actions?: TopicPageActions;
}

/** The address of an Ask about the topic and its subtopics: the Ask panel with the topic as its scope. */
export function askAboutTopicAddress(topicId: string): string {
  return formatView({ view: "ask", scope: { kind: "topic", id: topicId } });
}

export interface TopicAskViewProps {
  t: Translator;
  topic: { id: string; title: string };
  /** Opens the Ask panel beside the page; absent where nothing can open a panel. */
  onOpen: ObjectOpen | undefined;
}

/**
 * "Ask about this topic": a button in the side column that opens the Ask panel beside the page, with
 * the topic and its subtopics as its scope (the panel writes the scope, takes the words and streams
 * the answer with citations that carry their passage and span). The slot loads nothing and holds
 * nothing open: the answer lives in its own panel and its own stored Question. Where the page is not
 * inside a panel (nothing can open one), the slot is not drawn rather than drawn dead.
 */
export function TopicAskView({ t, topic, onOpen }: TopicAskViewProps) {
  const headingId = useId();
  if (!onOpen) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-sm font-semibold text-secondary-foreground">
        {t("topics.page.ask.heading")}
      </h2>
      <p className="text-sm text-secondary-foreground">{t("topics.page.ask.hint")}</p>
      <Button
        type="button"
        className="self-start"
        onClick={(event) =>
          onOpen(askAboutTopicAddress(topic.id), event.altKey ? { replace: true } : undefined)
        }
      >
        <MessageCircle aria-hidden="true" />
        {t("topics.page.ask.button")}
      </Button>
    </section>
  );
}

/** The slot at the end of the side column: the page's panel opens the Ask beside it. */
export function TopicAskSlot(props: TopicAskSlotProps) {
  const context = useObjectLinkContext();
  return <TopicAskView t={props.t} topic={props.topic} onOpen={context?.onOpen} />;
}

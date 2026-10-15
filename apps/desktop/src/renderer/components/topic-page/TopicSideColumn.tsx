import { useId } from "react";
import type { TopicPage } from "@app/domain";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph } from "../glyphs";
import { RelationStanceLabel } from "../RelationStanceLabel";
import { TopicAskSlot } from "./TopicAskSlot";
import {
  isRootPage,
  relationsLabel,
  stanceRows,
  topicTitle,
  type TopicPageActions
} from "./topic-page-model";

const heading = "text-sm font-semibold text-secondary-foreground";

export interface TopicSideColumnProps {
  t: Translator;
  page: TopicPage;
  active: boolean;
  actions: TopicPageActions;
}

/** Neighbouring topics, the relations of the topic's notes and the place of "Ask about this topic". */
export function TopicSideColumn({ t, page, active, actions }: TopicSideColumnProps) {
  const relatedId = useId();
  const stancesId = useId();
  const stances = stanceRows(page.relationStances);
  return (
    <aside
      aria-label={t("topics.page.sideLabel")}
      className="flex min-w-0 flex-col gap-6 empty:hidden"
    >
      {page.relatedTopics.length > 0 ? (
        <section aria-labelledby={relatedId} className="flex flex-col gap-1">
          <h2 id={relatedId} className={heading}>
            {t("topics.page.side.related")}
          </h2>
          <ul className="-mx-3 flex flex-col">
            {page.relatedTopics.map((topic) => (
              <li key={topic.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-foreground hover:bg-surface-hover"
                  onClick={() => actions.openTopic(topic.id)}
                >
                  <ObjectKindGlyph kind="topic" className="text-object-topic" />
                  <span className="sr-only">{t("objects.kinds.topic")}: </span>
                  <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
                    {topicTitle(t, topic, false)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {relationsLabel(t, topic.relationCount)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {stances.length > 0 ? (
        <section aria-labelledby={stancesId} className="flex flex-col gap-1">
          <h2 id={stancesId} className={heading}>
            {t("topics.page.side.stances")}
          </h2>
          <ul className="flex flex-col">
            {stances.map((row) => (
              <li key={row.type} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                <RelationStanceLabel type={row.type} t={t} />
                <span className="text-secondary-foreground tabular-nums">
                  {new Intl.NumberFormat(t.locale).format(row.count)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <TopicAskSlot
        t={t}
        topic={{ id: page.topic.id, title: topicTitle(t, page.topic, isRootPage(page)) }}
        active={active}
        actions={actions}
      />
    </aside>
  );
}

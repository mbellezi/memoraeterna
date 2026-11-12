import { Fragment, type Ref } from "react";
import type { InboxItem } from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import type { InboxItemAction } from "./inbox-state";
import { keyOf } from "./inbox-state";
import { kindIcon, RiskMark } from "./inbox-marks";
import { ageText, itemSubject, itemTitle, kindLabels, riskLabels } from "./inbox-model";

export interface InboxListProps {
  t: Translator;
  items: readonly InboxItem[];
  selectedKey: string | null;
  actions: Readonly<Record<string, InboxItemAction>>;
  /** The time ages are measured to (a number, so the list renders the same twice). */
  now: number;
  /** Prefix of the option IDs: the list names its selected option with `aria-activedescendant`. */
  idPrefix: string;
  listRef: Ref<HTMLUListElement>;
  hasMore: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
  onSelect: (key: string) => void;
  onLoadMore: () => void;
}

export const optionId = (prefix: string, index: number): string => `${prefix}-option-${index}`;

/**
 * The open items as a listbox with one tab stop: arrows (and `j`, `k`) move the selection, which
 * the detail follows. The list is ordered by risk, so a header with the risk's glyph and word opens
 * each run of items (a screen reader hears the risk in each option instead); an item says its kind
 * and how long ago it arose, its title and what it is about. Nothing here is an ID. The keyboard
 * ring is drawn inside the selected row, so no parent can clip it.
 */
export function InboxList({
  t,
  items,
  selectedKey,
  actions,
  now,
  idPrefix,
  listRef,
  hasMore,
  loadingMore,
  moreFailed,
  onSelect,
  onLoadMore
}: InboxListProps) {
  const selectedIndex = items.findIndex((item) => keyOf(item) === selectedKey);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
      <ul
        ref={listRef}
        role="listbox"
        tabIndex={0}
        aria-label={t("inbox.list.label")}
        aria-activedescendant={selectedIndex >= 0 ? optionId(idPrefix, selectedIndex) : undefined}
        className={cn(
          "group flex flex-col rounded-lg border border-border-strong bg-surface",
          selectedIndex >= 0
            ? "focus-visible:outline-none"
            : "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        )}
      >
        {items.map((item, index) => {
          const key = keyOf(item);
          const selected = key === selectedKey;
          const Icon = kindIcon[item.kind];
          const pending = actions[key]?.status === "pending";
          const firstOfRisk = index === 0 || items[index - 1]!.risk !== item.risk;
          return (
            <Fragment key={key}>
              {firstOfRisk ? (
                <li
                  role="presentation"
                  aria-hidden="true"
                  className="flex items-center border-b border-border bg-soft px-3 py-1.5 first:rounded-t-lg"
                >
                  <RiskMark t={t} risk={item.risk} />
                </li>
              ) : null}
              <li
                id={optionId(idPrefix, index)}
                role="option"
                aria-selected={selected}
                aria-current={selected ? "true" : undefined}
                aria-busy={pending || undefined}
                onClick={() => onSelect(key)}
                className={cn(
                  "flex cursor-pointer flex-col gap-1 border-b border-border px-3 py-2.5 last:border-b-0",
                  selected
                    ? "bg-accent-soft [box-shadow:inset_3px_0_0_0_var(--accent)] group-focus-visible:outline-2 group-focus-visible:-outline-offset-2 group-focus-visible:outline-accent"
                    : "hover:bg-surface-hover",
                  pending && "opacity-60"
                )}
              >
                <span className="sr-only">{t(riskLabels[item.risk])}</span>
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                  <span className="inline-flex items-center gap-1.5 text-xs text-secondary-foreground">
                    <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                    {t(kindLabels[item.kind])}
                  </span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {ageText(t, item.at, now)}
                  </span>
                </div>
                <p className="text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                  {itemTitle(t, item)}
                </p>
                <p className="text-xs text-secondary-foreground [overflow-wrap:anywhere]">
                  {itemSubject(t, item)}
                </p>
              </li>
            </Fragment>
          );
        })}
      </ul>
      {hasMore ? (
        <div className="flex flex-col items-start gap-1">
          <Button type="button" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? t("inbox.states.loadingMore") : t("inbox.states.loadMore")}
          </Button>
          {moreFailed ? (
            <p role="alert" className="text-xs text-danger">
              {t("inbox.states.moreFailed")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

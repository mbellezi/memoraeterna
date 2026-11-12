import { useId, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Keyboard } from "lucide-react";
import type { ChangeSetRisk, InboxKind, InboxObject, InboxVerb } from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { ErrorState } from "../ui/error-state";
import { InboxDetail, UndoBanner } from "./InboxDetail";
import { KeyBar, KeySheet } from "./InboxKeys";
import { InboxList } from "./InboxList";
import { InboxLoading } from "./InboxLoading";
import { keyRows } from "./inbox-keys";
import { kindIcon } from "./inbox-marks";
import { kindLabels, kindOrder, riskLabels } from "./inbox-model";
import { selectedItem, type InboxState } from "./inbox-state";

export interface InboxViewProps {
  t: Translator;
  state: InboxState;
  /** Prefix of the list's option IDs (`aria-activedescendant`). */
  idPrefix: string;
  /** An object the detail tried to open could not be located. */
  openFailed: boolean;
  /** The screen itself holds the focus when the list is not there (empty, loading, failed). */
  rootRef?: Ref<HTMLDivElement>;
  listRef: Ref<HTMLUListElement>;
  detailRef: Ref<HTMLElement>;
  /** The keyboard of the whole screen (the host maps keys to the controller and moves the focus). */
  onKey: (event: KeyboardEvent<HTMLElement>) => void;
  onRetry: () => void;
  onFilter: (filter: { kind?: InboxKind | null; risk?: ChangeSetRisk | null }) => void;
  onSelect: (key: string) => void;
  onLoadMore: () => void;
  onVerb: (verb: InboxVerb) => void;
  onUndo: () => void;
  onHideUndo: () => void;
  onToggleHelp: () => void;
  onRetryDiff: () => void;
  onOpenObject: (object: InboxObject) => void;
  onOpenSettings: () => void;
  /**
   * The Inbox is the previous panel of a stack (design record §8): its item list alone, the item
   * that opened the panel beside it marked.
   */
  compact?: boolean;
  /** The item list's width in px (design record §3: 360, or 300 in the compact tier). */
  listWidth?: number;
  /**
   * The destination's 40 px key bar at the foot of the screen (design record §7.4), which also
   * opens the key sheet; without it a "Keyboard shortcuts" button in the header does.
   */
  keyBar?: boolean;
}

const riskFilters: readonly ChangeSetRisk[] = ["high", "medium", "low"];

/**
 * The Inbox screen: filters with their counts, the open items by risk and age, the selected item's
 * detail, an Undo for the last verb and the keyboard help. It covers loading, empty, error and
 * ready states, and every refusal stays visible as text; the controller owns the state.
 */
export function InboxView({ rootRef, ...props }: InboxViewProps) {
  const { t, state } = props;
  const helpId = useId();
  const item = selectedItem(state);
  const counts = state.counts;
  // A kind with nothing waiting is not offered, unless it is the one being shown.
  const offeredKinds = kindOrder.filter(
    (kind) => (counts?.byKind[kind] ?? 0) > 0 || state.filter.kind === kind
  );
  const empty = state.load.status === "ready" && state.items.length === 0;
  const rows = keyRows(item);
  const filtered = state.filter.kind !== null || state.filter.risk !== null;
  // Nothing waits and no filter is set, or the read failed: nothing to filter and no key to press.
  const idle = (empty && !filtered) || state.load.status === "error";
  // Many kinds make a second row of chips: past five they fold into the "Tipo" select at any width.
  const kindsAsSelect = offeredKinds.length > 5;
  if (props.compact)
    return (
      <div
        ref={rootRef}
        tabIndex={-1}
        aria-label={t("inbox.title")}
        role="region"
        className="flex h-full min-h-0 flex-col gap-2 outline-none"
        onKeyDown={props.onKey}
      >
        {state.load.status === "loading" ? (
          <InboxLoading t={t} compact listWidth={props.listWidth ?? 240} />
        ) : state.load.status === "error" ? (
          <ErrorState
            t={t}
            message={t("inbox.states.error")}
            kept={t("inbox.states.errorKept")}
            retryLabel={t("shell.actions.retry")}
            onRetry={props.onRetry}
          />
        ) : empty ? (
          <div role="status">
            <EmptyState
              variant="compact"
              headline={t("inbox.states.empty.title")}
              className="[&>div]:text-xs"
            >
              {t("inbox.states.empty.body")}
            </EmptyState>
          </div>
        ) : (
          <InboxList
            t={t}
            items={state.items}
            selectedKey={state.selectedKey}
            actions={state.actions}
            now={state.readAt}
            idPrefix={props.idPrefix}
            listRef={props.listRef}
            hasMore={state.nextCursor !== null}
            loadingMore={state.loadingMore}
            moreFailed={state.moreFailed}
            onSelect={props.onSelect}
            onLoadMore={props.onLoadMore}
          />
        )}
      </div>
    );
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      aria-label={t("inbox.title")}
      role="region"
      className="flex h-full min-h-96 flex-col gap-3 outline-none"
      onKeyDown={props.onKey}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-sm text-secondary-foreground">
          {counts !== null && counts.total > 0
            ? counts.total === 1
              ? t("inbox.summaryOne")
              : t("inbox.summary", {
                  values: { count: new Intl.NumberFormat(t.locale).format(counts.total) }
                })
            : t("inbox.description")}
        </p>
        {/* The help floats over the screen, so opening it never pushes the list out of view. */}
        {props.keyBar ? null : (
          <div className="relative">
            <Button
              type="button"
              variant="ghost"
              aria-expanded={state.helpOpen}
              aria-controls={helpId}
              aria-keyshortcuts="?"
              onClick={props.onToggleHelp}
            >
              <Keyboard aria-hidden="true" />
              {t("inbox.keys.toggle")}
            </Button>
            {state.helpOpen ? (
              <KeySheet t={t} id={helpId} rows={rows} className="right-0 top-full mt-1" />
            ) : null}
          </div>
        )}
      </header>

      {idle ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {/* The kinds are chips from 1180 px; below it one "Tipo" select holds them, so the bar is one row. */}
          <div
            role="group"
            aria-label={t("inbox.filters.label")}
            className={cn(
              "flex min-w-0 flex-wrap items-center gap-2",
              kindsAsSelect ? "hidden" : "max-[1179px]:hidden"
            )}
          >
            <FilterChip
              pressed={state.filter.kind === null}
              label={t("inbox.filters.all")}
              count={counts?.total ?? null}
              t={t}
              onClick={() => props.onFilter({ kind: null })}
            />
            {offeredKinds.map((kind) => {
              const Icon = kindIcon[kind];
              return (
                <FilterChip
                  key={kind}
                  pressed={state.filter.kind === kind}
                  label={t(kindLabels[kind])}
                  count={counts?.byKind[kind] ?? 0}
                  icon={<Icon aria-hidden="true" />}
                  t={t}
                  onClick={() => props.onFilter({ kind })}
                />
              );
            })}
          </div>
          <label
            className={cn(
              "flex items-center gap-2 text-xs text-secondary-foreground",
              !kindsAsSelect && "min-[1180px]:hidden"
            )}
          >
            {t("inbox.filters.kind")}
            <select
              value={state.filter.kind ?? ""}
              onChange={(event) =>
                props.onFilter({ kind: (event.target.value || null) as InboxKind | null })
              }
              className={selectClass}
            >
              <option value="">
                {optionText(t("inbox.filters.all"), counts?.total ?? null, t.locale)}
              </option>
              {offeredKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {optionText(t(kindLabels[kind]), counts?.byKind[kind] ?? 0, t.locale)}
                </option>
              ))}
            </select>
          </label>
          <label className="ml-auto flex items-center gap-2 text-xs text-secondary-foreground">
            {t("inbox.filters.risk.label")}
            <select
              value={state.filter.risk ?? ""}
              onChange={(event) =>
                props.onFilter({ risk: (event.target.value || null) as ChangeSetRisk | null })
              }
              className={selectClass}
            >
              <option value="">{t("inbox.filters.risk.any")}</option>
              {riskFilters.map((risk) => (
                <option key={risk} value={risk}>
                  {t(riskLabels[risk])}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {state.undo ? (
        <UndoBanner t={t} undo={state.undo} onUndo={props.onUndo} onHide={props.onHideUndo} />
      ) : null}

      {props.openFailed ? (
        <p role="alert" className="text-xs text-danger">
          {t("inbox.detail.openFailed")}
        </p>
      ) : null}

      <p role="status" aria-live="polite" className="sr-only">
        {state.announcement ? t(state.announcement, { values: state.announcementParams }) : ""}
      </p>

      {state.load.status === "loading" ? (
        <InboxLoading t={t} compact={false} listWidth={props.listWidth ?? 320} />
      ) : state.load.status === "error" ? (
        <ErrorState
          t={t}
          message={t("inbox.states.error")}
          kept={t("inbox.states.errorKept")}
          retryLabel={t("shell.actions.retry")}
          onRetry={props.onRetry}
        />
      ) : empty ? (
        <div role="status" className="self-start">
          <EmptyState
            className="max-w-xl"
            headline={filtered ? t("inbox.states.emptyFiltered") : t("inbox.states.empty.title")}
          >
            {filtered ? null : t("inbox.states.empty.body")}
          </EmptyState>
        </div>
      ) : (
        <div
          className="grid min-h-0 flex-1 grid-cols-[var(--inbox-list-w)_minmax(0,1fr)] gap-4"
          style={{ "--inbox-list-w": `${props.listWidth ?? 320}px` } as CSSProperties}
        >
          <InboxList
            t={t}
            items={state.items}
            selectedKey={state.selectedKey}
            actions={state.actions}
            now={state.readAt}
            idPrefix={props.idPrefix}
            listRef={props.listRef}
            hasMore={state.nextCursor !== null}
            loadingMore={state.loadingMore}
            moreFailed={state.moreFailed}
            onSelect={props.onSelect}
            onLoadMore={props.onLoadMore}
          />
          <InboxDetail
            t={t}
            item={item}
            action={item ? state.actions[`${item.kind}:${item.id}`] : undefined}
            diff={item?.changeSet ? state.diffs[item.changeSet.id] : undefined}
            now={state.readAt}
            regionRef={props.detailRef}
            onVerb={props.onVerb}
            onOpenObject={props.onOpenObject}
            onOpenSettings={props.onOpenSettings}
            onRetryDiff={props.onRetryDiff}
          />
        </div>
      )}
      {props.keyBar && !idle ? (
        <div className="relative -mx-6 -mb-5 mt-auto max-[1179px]:-mx-4">
          {state.helpOpen ? (
            <KeySheet t={t} id={helpId} rows={rows} className="bottom-full right-6 mb-1" />
          ) : null}
          <KeyBar
            t={t}
            rows={rows}
            helpOpen={state.helpOpen}
            helpId={helpId}
            onToggleHelp={props.onToggleHelp}
          />
        </div>
      ) : null}
    </div>
  );
}

const selectClass =
  "min-h-[34px] rounded-lg border border-border-strong bg-surface px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** "Conexões sugeridas (2)": a select option cannot hold a styled count. */
const optionText = (label: string, count: number | null, locale: string): string =>
  count === null ? label : `${label} (${new Intl.NumberFormat(locale).format(count)})`;

function FilterChip({
  t,
  pressed,
  label,
  count,
  icon,
  onClick
}: {
  t: Translator;
  pressed: boolean;
  label: string;
  count: number | null;
  icon?: ReactNode;
  onClick: () => void;
}) {
  const shown = count === null ? null : new Intl.NumberFormat(t.locale).format(count);
  return (
    <Button
      type="button"
      aria-pressed={pressed}
      aria-label={
        shown === null ? label : t("inbox.filters.chip", { values: { kind: label, count: shown } })
      }
      onClick={onClick}
    >
      {icon}
      {label}
      {shown === null ? null : <span className="text-muted-foreground">{shown}</span>}
    </Button>
  );
}

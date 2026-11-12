import { useId, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { CircleCheck, Keyboard } from "lucide-react";
import type { ChangeSetRisk, InboxKind, InboxObject, InboxVerb } from "@app/domain";
import type { Translator } from "@app/i18n";

import { Button } from "../ui/button";
import { ErrorState } from "../ui/error-state";
import { SkeletonRows } from "../ui/skeleton";
import { InboxDetail, UndoBanner } from "./InboxDetail";
import { InboxList } from "./InboxList";
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
  const empty = state.load.status === "ready" && state.items.length === 0;
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
          <div role="status" aria-busy="true" className="flex flex-col gap-3">
            <p className="m-0 text-sm text-muted-foreground">{t("inbox.states.loading")}</p>
            <SkeletonRows rows={6} />
          </div>
        ) : state.load.status === "error" ? (
          <ErrorState
            t={t}
            message={t("inbox.states.error")}
            kept={t("inbox.states.errorKept")}
            retryLabel={t("shell.actions.retry")}
            onRetry={props.onRetry}
          />
        ) : empty ? (
          <div role="status" className="flex flex-col gap-1">
            <p className="m-0 text-sm font-medium text-foreground">
              {t("inbox.states.empty.title")}
            </p>
            <p className="m-0 text-xs text-muted-foreground">{t("inbox.states.empty.body")}</p>
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
        <p className="text-sm text-secondary-foreground">{t("inbox.description")}</p>
        {/* The help floats over the screen, so opening it never pushes the list out of view. */}
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
            <section
              id={helpId}
              aria-label={t("inbox.keys.title")}
              className="absolute right-0 top-full z-20 mt-1 flex w-80 max-w-[calc(100vw-3rem)] flex-col gap-2 rounded-lg border border-border-strong bg-surface p-3 shadow-lg"
            >
              <h2 className="text-xs font-semibold text-secondary-foreground">
                {t("inbox.keys.title")}
              </h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-foreground">
                {keyRows(item).map((row) => (
                  <div key={row.label} className="contents">
                    <dt className="flex gap-1">
                      {row.keys.map((key) => (
                        <kbd
                          key={key}
                          className="rounded-sm border border-border-strong bg-soft px-1.5 font-sans font-medium"
                        >
                          {key}
                        </kbd>
                      ))}
                    </dt>
                    <dd>{t(row.label)}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-muted-foreground">{t("inbox.keys.note")}</p>
              <p className="text-xs text-muted-foreground">{t("inbox.keys.money")}</p>
            </section>
          ) : null}
        </div>
      </header>

      <div
        role="group"
        aria-label={t("inbox.filters.label")}
        className="flex flex-wrap items-center gap-2"
      >
        <FilterChip
          pressed={state.filter.kind === null}
          label={t("inbox.filters.all")}
          count={counts?.total ?? null}
          t={t}
          onClick={() => props.onFilter({ kind: null })}
        />
        {kindOrder.map((kind) => {
          const count = counts?.byKind[kind] ?? 0;
          // A kind with nothing waiting is not offered, unless it is the one being shown.
          if (count === 0 && state.filter.kind !== kind) return null;
          const Icon = kindIcon[kind];
          return (
            <FilterChip
              key={kind}
              pressed={state.filter.kind === kind}
              label={t(kindLabels[kind])}
              count={count}
              icon={<Icon aria-hidden="true" />}
              t={t}
              onClick={() => props.onFilter({ kind })}
            />
          );
        })}
        <label className="ml-auto flex items-center gap-2 text-xs text-secondary-foreground">
          {t("inbox.filters.risk.label")}
          <select
            value={state.filter.risk ?? ""}
            onChange={(event) =>
              props.onFilter({ risk: (event.target.value || null) as ChangeSetRisk | null })
            }
            className="min-h-[34px] rounded-lg border border-border-strong bg-surface px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
        <div role="status" aria-busy="true" className="flex flex-col gap-3">
          <p className="m-0 text-sm text-muted-foreground">{t("inbox.states.loading")}</p>
          <SkeletonRows rows={6} />
        </div>
      ) : state.load.status === "error" ? (
        <ErrorState
          t={t}
          message={t("inbox.states.error")}
          kept={t("inbox.states.errorKept")}
          retryLabel={t("shell.actions.retry")}
          onRetry={props.onRetry}
        />
      ) : empty ? (
        <div
          role="status"
          className="flex flex-col items-center justify-center gap-1 rounded-lg border border-border bg-surface p-8 text-center"
        >
          <CircleCheck className="size-6 text-success" aria-hidden="true" />
          <p className="text-sm font-medium text-foreground">
            {state.filter.kind || state.filter.risk
              ? t("inbox.states.emptyFiltered")
              : t("inbox.states.empty.title")}
          </p>
          {state.filter.kind || state.filter.risk ? null : (
            <p className="max-w-md text-xs text-muted-foreground">{t("inbox.states.empty.body")}</p>
          )}
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
    </div>
  );
}

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

import { useId, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { CircleCheck, Keyboard, RefreshCw } from "lucide-react";
import type { ChangeSetRisk, InboxKind, InboxObject, InboxVerb } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { Button } from "../ui/button";
import { InboxDetail, UndoBanner } from "./InboxDetail";
import { InboxList } from "./InboxList";
import { kindIcon } from "./inbox-marks";
import { kindLabels, kindOrder, riskLabels, verbKeys } from "./inbox-model";
import { selectedItem, type InboxState } from "./inbox-state";

export interface InboxViewProps {
  t: Translator;
  state: InboxState;
  /** Prefix of the list's option IDs (`aria-activedescendant`). */
  idPrefix: string;
  /** An object the detail tried to open could not be located. */
  openFailed: boolean;
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
}

const riskFilters: readonly ChangeSetRisk[] = ["high", "medium", "low"];

const helpRows: ReadonlyArray<{ keys: readonly string[]; label: MessageKey }> = [
  { keys: ["J", "K"], label: "inbox.keys.move" },
  { keys: ["Enter"], label: "inbox.keys.open" },
  { keys: [verbKeys.apply], label: "inbox.keys.apply" },
  { keys: [verbKeys.dismiss], label: "inbox.keys.dismiss" },
  { keys: [verbKeys.retry], label: "inbox.keys.retry" },
  { keys: ["U"], label: "inbox.keys.undo" },
  { keys: ["?"], label: "inbox.keys.help" }
];

/**
 * The Inbox screen: filters with their counts, the open items by risk and age, the selected item's
 * detail, an Undo for the last verb and the keyboard help. It covers loading, empty, error and
 * ready states, and every refusal stays visible as text; the controller owns the state.
 */
export function InboxView(props: InboxViewProps) {
  const { t, state } = props;
  const helpId = useId();
  const item = selectedItem(state);
  const counts = state.counts;
  const empty = state.load.status === "ready" && state.items.length === 0;
  return (
    <div className="flex h-[calc(100vh-7rem)] min-h-96 flex-col gap-3" onKeyDown={props.onKey}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-secondary-foreground">{t("inbox.description")}</p>
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
      </header>

      {state.helpOpen ? (
        <section
          id={helpId}
          aria-label={t("inbox.keys.title")}
          className="flex flex-col gap-2 rounded-lg border border-border bg-soft p-3"
        >
          <h2 className="text-xs font-semibold text-secondary-foreground">
            {t("inbox.keys.title")}
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-foreground">
            {helpRows.map((row) => (
              <div key={row.label} className="contents">
                <dt className="flex gap-1">
                  {row.keys.map((key) => (
                    <kbd
                      key={key}
                      className="rounded-sm border border-border-strong bg-surface px-1.5 font-sans font-medium"
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
        <p role="status" className="text-sm text-muted-foreground">
          {t("inbox.states.loading")}
        </p>
      ) : state.load.status === "error" ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
          <p>{t("inbox.states.error")}</p>
          <Button type="button" onClick={props.onRetry}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
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
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)] gap-4">
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

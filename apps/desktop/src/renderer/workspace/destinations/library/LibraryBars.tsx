import { useId, type KeyboardEvent, type Ref } from "react";
import { Circle, Search, X } from "lucide-react";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { Kbd } from "../../../components/ui/kbd";
import { Skeleton } from "../../../components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import { cn } from "../../../lib/cn";
import type { LibraryRowStatus } from "../../../../shared/ipc-library";
import { densities, type Density } from "../../state";
import type { LibraryTab } from "../../route";
import {
  chipViews,
  orderKey,
  territoryShown,
  territoryViews,
  type LibraryFacets,
  type ResolvedSort,
  type StateChip
} from "./library-model";

/**
 * The parts around the table (design record §7.3): the header (title, tabs, count, density), the
 * filter field and the state chips, the territory bar and the foot with the keys. Each takes what it
 * shows and reports what the person did; none reads data.
 */

const number = (t: Translator, value: number) => new Intl.NumberFormat(t.locale).format(value);

/** "48 fontes", with its noun in the singular for one. */
export function sourcesCount(t: Translator, count: number): string {
  const one = count === 1;
  return t(one ? "libraryTable.count.sourcesOne" : "libraryTable.count.sourcesMany", {
    values: { count: number(t, count) }
  });
}

export function questionsCount(t: Translator, count: number): string {
  const one = count === 1;
  return t(one ? "libraryTable.count.questionsOne" : "libraryTable.count.questionsMany", {
    values: { count: number(t, count) }
  });
}

// ---------------------------------------------------------------------------
// The header

const tabIds: readonly LibraryTab[] = ["sources", "questions"];

function Tabs({
  t,
  tab,
  onTab,
  panelId
}: {
  t: Translator;
  tab: LibraryTab;
  onTab: (tab: LibraryTab) => void;
  panelId: string;
}) {
  const id = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabIds.length
        : event.key === "ArrowLeft"
          ? (index + tabIds.length - 1) % tabIds.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabIds.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    onTab(tabIds[next] as LibraryTab);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={t("libraryTable.tabs.label")}
      className="flex items-center gap-4"
    >
      {tabIds.map((id_, index) => {
        const current = tab === id_;
        return (
          <button
            key={id_}
            type="button"
            role="tab"
            id={`${id}-${id_}`}
            aria-selected={current}
            aria-controls={panelId}
            tabIndex={current ? 0 : -1}
            onClick={() => onTab(id_)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "-mb-px h-8 border-b-2 px-0.5 text-sm whitespace-nowrap outline-none",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              current
                ? "border-accent font-semibold text-foreground"
                : "border-transparent font-medium text-secondary-foreground hover:text-foreground"
            )}
          >
            {t(id_ === "sources" ? "libraryTable.tabs.sources" : "libraryTable.tabs.questions")}
          </button>
        );
      })}
    </div>
  );
}

export interface LibraryHeaderProps {
  t: Translator;
  tab: LibraryTab;
  onTab: (tab: LibraryTab) => void;
  panelId: string;
  /** "48 fontes"; empty while it is not known. */
  count: string;
  density: Density;
  onDensity: (density: Density) => void;
}

export function LibraryHeader({
  t,
  tab,
  onTab,
  panelId,
  count,
  density,
  onDensity
}: LibraryHeaderProps) {
  return (
    <header className="flex flex-none flex-wrap items-center gap-x-5 gap-y-2 px-8 pt-5 pb-3">
      <h2 className="m-0 font-reading text-xl font-semibold">{t("libraryTable.title")}</h2>
      <Tabs t={t} tab={tab} onTab={onTab} panelId={panelId} />
      <span className="text-sm text-muted-foreground">{count}</span>
      <span className="flex-1" />
      <ToggleGroup<Density>
        label={t("libraryTable.density.label")}
        value={density}
        onValueChange={onDensity}
      >
        {densities.map((value) => (
          <ToggleGroupItem key={value} value={value}>
            {t(
              value === "comfortable"
                ? "libraryTable.density.comfortable"
                : "libraryTable.density.compact"
            )}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </header>
  );
}

// ---------------------------------------------------------------------------
// The bar: the filter field and the state chips

export function FilterField({
  t,
  value,
  onChange,
  label,
  placeholder,
  inputRef,
  disabled = false
}: {
  t: Translator;
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Nothing to filter (the list could not be read): the field stays, dimmed and inert. */
  disabled?: boolean;
}) {
  return (
    <div
      // The whole field is the inactive control: its dimmed search glyph and "/" hint are parts of it,
      // exempt from the contrast bars like the input (WCAG 1.4.3 and 1.4.11), and the mark says so.
      {...(disabled ? { "data-disabled": "" } : {})}
      className={cn(
        "flex h-8 w-72 max-w-full items-center gap-2 rounded-lg border border-border-strong bg-surface px-2.5",
        "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent",
        disabled && "opacity-60"
      )}
    >
      <Search aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        role="searchbox"
        disabled={disabled}
        aria-label={label}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value !== "") {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
        className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      {value === "" ? (
        <Kbd aria-hidden="true">/</Kbd>
      ) : (
        <button
          type="button"
          aria-label={t("libraryTable.filter.clear")}
          onClick={() => onChange("")}
          className={cn(
            "inline-grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground",
            "hover:bg-surface-hover hover:text-foreground focus-visible:outline-2",
            "focus-visible:outline-offset-1 focus-visible:outline-accent"
          )}
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      )}
    </div>
  );
}

const chipWords = {
  all: "libraryTable.chips.all",
  processing: "libraryTable.chips.processing",
  needsYou: "libraryTable.chips.needsYou",
  storedOnly: "libraryTable.chips.storedOnly",
  failed: "libraryTable.chips.failed"
} as const;

export function StateChips({
  t,
  facets,
  status,
  onStatus
}: {
  t: Translator;
  facets: LibraryFacets | null;
  status: LibraryRowStatus | undefined;
  onStatus: (status: LibraryRowStatus | undefined) => void;
}) {
  // A deep link may name "ready", which has no chip: the bar then shows Todas.
  const chosen: StateChip = status !== undefined && status !== "ready" ? status : "all";
  return (
    <ToggleGroup<StateChip>
      label={t("libraryTable.chips.label")}
      value={chosen}
      onValueChange={(chip) => onStatus(chip === "all" ? undefined : chip)}
      className="max-w-full flex-wrap"
    >
      {chipViews(facets, status).map((chip) => (
        <ToggleGroupItem
          key={chip.id}
          value={chip.id}
          {...(chip.id === "storedOnly" ? { title: t("libraryTable.chips.storedOnlyHint") } : {})}
        >
          {t(chipWords[chip.id])}
          {chip.count === null ? null : (
            <span className="font-normal text-muted-foreground tabular-nums">
              {number(t, chip.count)}
            </span>
          )}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

// ---------------------------------------------------------------------------
// The territory bar

export function TerritoryBar({
  t,
  facets,
  loading,
  topic,
  onTopic,
  expanded,
  onExpand
}: {
  t: Translator;
  facets: LibraryFacets | null;
  /** The counts are being read: bars in the shape of the chips hold the place. */
  loading: boolean;
  topic: string | undefined;
  onTopic: (topic: string | undefined) => void;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
}) {
  const all = territoryViews(facets);
  const placed = all.filter((entry) => entry.id !== null);
  const unplaced = all.find((entry) => entry.id === null);
  const shown = expanded ? placed : placed.slice(0, territoryShown);
  if ((facets === null && !loading) || (facets !== null && all.length === 0)) return null;
  return (
    <div
      role="group"
      aria-label={t("libraryTable.territory.label")}
      className="grid min-h-6 flex-none grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 px-8 pb-3 text-xs text-muted-foreground"
    >
      <span className="inline-flex h-6 items-center">{t("libraryTable.territory.heading")}</span>
      {/* The chips wrap in their own column, so a second line starts under the first chip. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1">
        {facets === null
          ? [0, 1, 2, 3].map((index) => <Skeleton key={index} className="mx-1 h-3 w-24" />)
          : null}
        {shown.map((entry) => {
          const pressed = entry.id === topic;
          const title = entry.title === "" ? t("libraryTable.territory.untitled") : entry.title;
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={pressed}
              title={title}
              onClick={() => onTopic(pressed ? undefined : (entry.id ?? undefined))}
              className={cn(
                "inline-flex h-6 min-w-0 max-w-56 items-center gap-1 rounded-full px-2 text-xs",
                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                pressed
                  ? "bg-surface-selected text-foreground [box-shadow:inset_0_0_0_1px_var(--accent)]"
                  : "text-secondary-foreground hover:bg-surface-hover"
              )}
            >
              <ObjectKindGlyph
                kind="topic"
                size={12}
                className={cn("shrink-0", objectKindTextClass.topic)}
              />
              <span className="min-w-0 truncate">{title}</span>
              <b className="font-semibold text-foreground tabular-nums">{number(t, entry.count)}</b>
            </button>
          );
        })}
        {placed.length > territoryShown ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => onExpand(!expanded)}
            className={cn(
              "h-6 rounded-full px-2 text-xs text-accent hover:bg-surface-hover hover:text-accent-hover",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            )}
          >
            {expanded
              ? t("libraryTable.territory.fewer")
              : t("libraryTable.territory.more", { values: { count: number(t, placed.length) } })}
          </button>
        ) : null}
        {unplaced ? (
          <span className="inline-flex h-6 items-center gap-1 px-2 text-secondary-foreground">
            <Circle aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
            {t("libraryTable.place.none")}
            <b className="font-semibold text-foreground tabular-nums">
              {number(t, unplaced.count)}
            </b>
            {t(
              unplaced.count === 1
                ? "libraryTable.territory.sourceOne"
                : "libraryTable.territory.sourceMany"
            )}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The foot

export function LibraryFoot({
  t,
  count,
  sort
}: {
  t: Translator;
  /** "48 fontes"; empty while it is not known. */
  count: string;
  /** The order the rows come in; absent for a list whose order is fixed (the questions). */
  sort: ResolvedSort | null;
}) {
  const order = sort ? t(orderKey(sort)) : t("libraryTable.order.newest");
  return (
    <footer className="flex min-h-10 flex-none flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-8 py-1.5 text-xs text-secondary-foreground">
      <span className="inline-flex items-center gap-1">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> {t("libraryTable.keys.choose")}
      </span>
      <span className="inline-flex items-center gap-1">
        <Kbd>{t("libraryTable.keys.space")}</Kbd> {t("libraryTable.keys.peek")}
      </span>
      <span className="inline-flex items-center gap-1">
        <Kbd>↵</Kbd> {t("libraryTable.keys.open")}
      </span>
      <span className="flex-1" />
      <span className="text-muted-foreground">{[count, order].filter(Boolean).join(" · ")}</span>
    </footer>
  );
}

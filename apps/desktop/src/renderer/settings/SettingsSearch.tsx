import { ArrowDown, ArrowUp, CornerDownLeft, Search, X } from "lucide-react";
import { Fragment, type KeyboardEvent, type Ref } from "react";
import type { Translator } from "@app/i18n";

import type { SettingsMessages } from "../../shared/settings-search";
import type { SettingEntryV2 } from "../../shared/settings-registry";
import type { SettingHit } from "../../shared/settings-search";
import { Kbd } from "../components/ui/kbd";
import { cn } from "../lib/cn";
import { useOverflowLevel } from "../lib/use-overflow-level";
import { ChangedMarker } from "./ChangedMarker";
import { InlineAction } from "./InlineAction";
import {
  groupHits,
  groupLabelOf,
  helpOf,
  labelOf,
  labelParts,
  sectionMeta,
  valueText,
  type DescribeIndex,
  type SettingsSectionId
} from "./settings-model";

export type { SettingsMessages };

export interface SettingsSearchFieldProps {
  t: Translator;
  value: string;
  onChange: (value: string) => void;
  /** The values are on their way: the field waits, quietly. */
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** Down moves to the results, Enter opens the best, Escape clears. */
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** Where the results are, for assistive technology. */
  controls?: string | undefined;
}

/**
 * The search field of the section column (design record §7.6): the "Search: theme, budget…" line, a
 * ⌘F keycap while it is empty, a clear button once it is not, and the help line that says it finds
 * synonyms too. The field is focused when Settings opens.
 */
export function SettingsSearchField({
  t,
  value,
  onChange,
  disabled = false,
  inputRef,
  onKeyDown,
  controls
}: SettingsSearchFieldProps) {
  return (
    <div>
      <div
        className={cn(
          "flex h-8 items-center gap-2 rounded-md border bg-surface pl-2 pr-1 text-sm text-muted-foreground",
          "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent",
          disabled ? "border-border bg-soft" : "border-border-strong"
        )}
      >
        <Search aria-hidden="true" className="size-4 shrink-0" />
        <span className="relative h-[30px] min-w-0 flex-1">
          <input
            ref={inputRef}
            type="search"
            role="searchbox"
            value={value}
            disabled={disabled}
            aria-label={t("settingsShell.search.label")}
            aria-controls={controls}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            className="absolute inset-0 h-[30px] w-full min-w-0 border-0 bg-transparent p-0 text-sm text-foreground outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {value === "" ? <FieldPlaceholder t={t} /> : null}
        </span>
        {value !== "" ? (
          <button
            type="button"
            aria-label={t("settingsShell.search.clear")}
            onClick={() => onChange("")}
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-sm border-0 bg-transparent",
              "text-secondary-foreground hover:bg-surface-hover hover:text-foreground",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            )}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        ) : (
          <Kbd aria-hidden="true" className="mr-1">
            ⌘F
          </Kbd>
        )}
      </div>
      <p className="m-0 mb-3 ml-1 mt-1 text-xs text-muted-foreground [text-wrap:pretty]">
        {t("settingsShell.search.help")}
      </p>
    </div>
  );
}

/**
 * The field's hint. When "Search: theme, budget…" does not fit beside the ⌘F keycap (a long language
 * at the 960 px window), the shorter "Search…" stays; the words are never cut in the middle.
 */
function FieldPlaceholder({ t }: { t: Translator }) {
  const full = t("settingsShell.search.placeholder");
  const short = t("settingsShell.search.placeholderShort");
  const { box, content, level } = useOverflowLevel<HTMLSpanElement, HTMLSpanElement>(
    2,
    `${full}|${short}`
  );
  return (
    <span
      ref={box}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex items-center overflow-hidden text-left"
    >
      <span
        ref={content}
        data-fit="settings-search"
        data-fit-level={level}
        className="inline-block whitespace-nowrap"
      >
        {level === 0 ? full : short}
      </span>
    </span>
  );
}

/** A label with the parts the query matched underlined and in heavier weight. */
export function HitLabel({ label, ranges }: { label: string; ranges: SettingHit["labelRanges"] }) {
  return (
    <>
      {labelParts(label, ranges).map((part, index) =>
        part.hit ? (
          <u
            key={index}
            className="font-semibold text-foreground underline decoration-[1.5px] underline-offset-[3px]"
          >
            {part.text}
          </u>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        )
      )}
    </>
  );
}

export interface SettingsResultsProps {
  t: Translator;
  query: string;
  hits: readonly SettingHit[];
  registry: readonly SettingEntryV2[];
  index: DescribeIndex | null;
  /** The section the empty state offers to go back to. */
  current: SettingsSectionId;
  onOpen: (hit: SettingHit) => void;
  onClear: () => void;
  onSuggest: (query: string) => void;
  /** Where the list takes its arrows and its Escape from. */
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  id?: string;
}

const suggestions = [
  "settingsShell.search.exampleDark",
  "settingsShell.search.exampleBudget",
  "settingsShell.search.exampleObsidian",
  "settingsShell.search.examplePrivacy"
] as const;

/**
 * The results of a search (design record §7.6), grouped by section with the section of the best hit
 * first: "4 results for “language”", the keys that move through them, and for each hit the label
 * with the match underlined, "section › group", the help, the current value and, on the best, ↵.
 * Nothing found says so in one line and offers example words and the way back.
 */
export function SettingsResults({
  t,
  query,
  hits,
  registry,
  index,
  current,
  onOpen,
  onClear,
  onSuggest,
  onKeyDown,
  id
}: SettingsResultsProps) {
  if (hits.length === 0)
    return (
      <div id={id} onKeyDown={onKeyDown}>
        <h2 className="m-0 font-reading text-2xl font-semibold text-foreground [text-wrap:balance]">
          {t("settingsShell.search.label")}
        </h2>
        <div className="mt-6 grid max-w-[35rem] gap-2 rounded-lg border-[1.5px] border-dashed border-border-strong p-6">
          <p className="m-0 text-base font-semibold text-foreground [overflow-wrap:anywhere]">
            {t("settingsShell.search.emptyTitle", { values: { query: query.trim() } })}
          </p>
          <p className="m-0 text-sm text-secondary-foreground [text-wrap:pretty]">
            {t("settingsShell.search.emptyBody")}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {suggestions.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => onSuggest(t(key))}
                className={cn(
                  "inline-flex h-7 items-center rounded-full border border-border-strong bg-surface px-3",
                  "text-sm font-medium text-foreground hover:bg-surface-hover",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                )}
              >
                {t(key)}
              </button>
            ))}
          </div>
          <p className="m-0 pt-1 text-sm text-secondary-foreground">
            <InlineAction onClick={onClear}>{t("settingsShell.search.emptyClear")}</InlineAction>{" "}
            {t("settingsShell.search.emptyBack", {
              values: { section: t(sectionMeta[current].name) }
            })}
          </p>
        </div>
      </div>
    );

  const byId = new Map(registry.map((entry) => [entry.id, entry]));
  const groups = groupHits(hits);
  const best = hits[0];
  return (
    <div id={id} onKeyDown={onKeyDown}>
      <h2 className="m-0 font-reading text-2xl font-semibold text-foreground [overflow-wrap:anywhere] [text-wrap:balance]">
        {t(
          hits.length === 1
            ? "settingsShell.search.resultsOne"
            : "settingsShell.search.resultsMany",
          {
            values: { count: hits.length, query: query.trim() }
          }
        )}
      </h2>
      <p className="m-0 mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs leading-5 text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Kbd aria-hidden="true">
            <ArrowUp aria-hidden="true" className="size-3" />
          </Kbd>
          <Kbd aria-hidden="true">
            <ArrowDown aria-hidden="true" className="size-3" />
          </Kbd>
          {t("settingsShell.search.keysMove")}
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd aria-hidden="true">
            <CornerDownLeft aria-hidden="true" className="size-3" />
          </Kbd>
          {t("settingsShell.search.keysOpen")}
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd aria-hidden="true">esc</Kbd>
          {t("settingsShell.search.keysClear")}
        </span>
      </p>
      {groups.map((group) => (
        <section key={group.section} className="mt-6">
          <h3 className="m-0 mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
            {t(sectionMeta[group.section].name)}
            <span className="font-normal text-muted-foreground tabular-nums">
              {group.hits.length}
            </span>
          </h3>
          <ul className="m-0 list-none p-0">
            {group.hits.map((hit) => {
              const entry = byId.get(hit.id);
              if (!entry) return null;
              const description = index?.get(hit.id);
              const value = valueText(t, entry, description);
              const isBest = hit === best;
              const label = labelOf(t, entry);
              return (
                <li key={hit.id}>
                  <button
                    type="button"
                    data-result={hit.id}
                    onClick={() => onOpen(hit)}
                    className={cn(
                      "-mx-4 grid w-[calc(100%+2rem)] grid-cols-[minmax(0,1fr)_auto] gap-x-6 rounded-md border-0 px-4 py-3 text-left",
                      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                      isBest
                        ? "bg-surface-selected [box-shadow:inset_2px_0_0_var(--accent)]"
                        : "bg-transparent hover:bg-surface-hover"
                    )}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-base font-medium leading-5 text-foreground">
                      <span className="[overflow-wrap:anywhere]">
                        <HitLabel label={label} ranges={hit.labelRanges} />
                      </span>
                      {description?.changed ? <ChangedMarker t={t} /> : null}
                    </span>
                    <span className="col-start-1 text-xs leading-5 text-muted-foreground">
                      {t(sectionMeta[hit.section].name)} › {groupLabelOf(t, hit.section, hit.group)}
                    </span>
                    <span className="col-start-1 line-clamp-2 max-w-[32.5rem] text-sm text-secondary-foreground [text-wrap:pretty]">
                      {helpOf(t, entry)}
                    </span>
                    <span className="col-start-2 row-span-3 row-start-1 flex max-w-60 items-center gap-2 self-center whitespace-nowrap text-sm text-secondary-foreground">
                      {value !== null ? <span className="truncate">{value}</span> : null}
                      {isBest ? (
                        <Kbd aria-hidden="true">
                          <CornerDownLeft aria-hidden="true" className="size-3" />
                        </Kbd>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

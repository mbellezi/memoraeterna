import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type KeyboardEvent
} from "react";
import { ChevronDown } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";

import { settingsRegistryV2, type SettingEntryV2 } from "../../shared/settings-registry";
import { searchSettings, type SettingHit } from "../../shared/settings-search";
import { Button } from "../components/ui/button";
import { ErrorState } from "../components/ui/error-state";
import { LoadingState, Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/cn";
import { GenericSection } from "./GenericSection";
import { InlineAction } from "./InlineAction";
import { SectionNav } from "./SectionNav";
import { SettingsContext, type SettingsContextValue } from "./settings-context";
import {
  changedCounts,
  changedIn,
  entryForAddress,
  hitCounts,
  labelOf,
  resetNeedsConfirm,
  sectionMeta,
  settingSelector,
  settingsState,
  type SettingsSectionId
} from "./settings-model";
import { settingsStoreOf, type SettingsStore } from "./settings-store";
import { useSettingsTarget } from "./settings-target";
import { sectionRegistry, type SectionRegistry } from "./sections-registry";
import { SettingsResults, SettingsSearchField } from "./SettingsSearch";

/** How long a row a link or a result took the person to stays lit. */
export const highlightMs = 2000;

export interface SettingsSurfaceProps {
  t: Translator;
  /**
   * Shown. Settings stays mounted while another place is on screen (its section, search and scroll
   * stay), but a hidden Settings reads nothing, listens to nothing and keeps its words to itself.
   */
  active?: boolean;
  /** The id the frame reports: "settings", or a section's own surface (`settings-general`). */
  surface?: string;
  initialSection?: SettingsSectionId;
  /** A search the surface starts with (the screens tool's "nothing found" state). */
  initialQuery?: string;
  /** The sections that have their own body; the others show the registry's rows read-only. */
  sections?: SectionRegistry;
  registry?: readonly SettingEntryV2[];
  /** The old Settings, still reachable from here until T166 removes it. */
  onOpenClassic?: () => void;
}

function useSettingsStore(enabled: boolean) {
  const store: SettingsStore = settingsStoreOf(
    typeof window === "undefined" ? undefined : window.app
  );
  useEffect(() => (enabled ? store.retain() : undefined), [store, enabled]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, snapshot };
}

/**
 * Settings v2 (design record §7.6, docs/f5-decisions.md D17): the seven-section column with its
 * search, and the content at a reading width. One frame reports `data-surface` and `data-state`:
 * loading while the saved values are read, error when they could not be (one sentence, what is kept,
 * one retry), empty when a search finds nothing, success otherwise. The search field takes focus when
 * Settings is shown; `memora://settings/<section>#<setting>` scrolls to the row, focuses it and
 * lights it for 2 s. Sections register by file (`sections-registry.ts`); one without a file of its
 * own shows the registry's rows read-only.
 */
export function SettingsSurface({
  t,
  active = true,
  surface = "settings",
  initialSection = "general",
  initialQuery = "",
  sections = sectionRegistry,
  registry = settingsRegistryV2,
  onOpenClassic
}: SettingsSurfaceProps) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  const [section, setSection] = useState<SettingsSectionId>(initialSection);
  const [query, setQuery] = useState(initialQuery);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [pendingRow, setPendingRow] = useState<string | null>(null);

  const { store, snapshot } = useSettingsStore(active && visited);
  const read = snapshot.read;
  const index = read.status === "ready" ? read.index : null;

  const hits = useMemo(
    () => searchSettings(query, t.locale, registry),
    [query, t.locale, registry]
  );
  const state = settingsState({ load: read.status, query, hits: hits.length });
  const searching = query.trim() !== "";

  const inputRef = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const resultsId = useId();

  // A request (an address, a result of another place) is answered once, when Settings is shown: the
  // section changes and the row is asked for. State adjusted while rendering, not in an effect.
  const target = useSettingsTarget();
  const [answered, setAnswered] = useState(0);
  if (active && target !== null && target.token > answered) {
    setAnswered(target.token);
    const entry = target.setting ? entryForAddress(target.setting, registry) : null;
    const next = entry?.section ?? target.section;
    if (next) {
      setSection(next);
      setQuery("");
    }
    if (entry) setPendingRow(entry.id);
  }

  // Focus: the search field each time Settings is shown, unless a request is taking a row. The field
  // waits, disabled, while the first read is on its way and a browser does not focus a disabled
  // field, so the wish stays until the field can take it (once per time shown).
  const fieldWaits = read.status === "loading" && !searching;
  const wantsFocus = useRef(false);
  useEffect(() => {
    wantsFocus.current = active && pendingRow === null;
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps -- once per time shown
  useEffect(() => {
    if (!wantsFocus.current || fieldWaits) return;
    wantsFocus.current = false;
    inputRef.current?.focus();
  }, [active, fieldWaits]);

  // A row asked for: scroll to it, focus it and light it, once the row is on screen.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    if (pendingRow === null || !active) return;
    const row = scroller.current?.querySelector<HTMLElement>(settingSelector(pendingRow));
    if (!row) return;
    row.scrollIntoView?.({ block: "center" });
    row.focus({ preventScroll: true });
    setHighlighted(pendingRow);
    setPendingRow(null);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHighlighted(null), highlightMs);
  }, [pendingRow, active, section, query, read.status]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  // ⌘F finds in Settings.
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);

  const chooseSection = (next: SettingsSectionId) => {
    setQuery("");
    setSection(next);
    if (scroller.current) scroller.current.scrollTop = 0;
  };

  const openHit = (hit: SettingHit) => {
    setQuery("");
    setSection(hit.section);
    setPendingRow(hit.id);
  };

  const clearSearch = useCallback(() => {
    setQuery("");
    inputRef.current?.focus();
  }, []);

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && hits.length > 0) {
      event.preventDefault();
      scroller.current?.querySelector<HTMLElement>("[data-result]")?.focus();
    } else if (event.key === "Enter" && hits[0]) {
      event.preventDefault();
      openHit(hits[0]);
    } else if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      clearSearch();
    }
  };

  const onResultsKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      clearSearch();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-result]")];
    const at = rows.findIndex((row) => row === document.activeElement);
    if (at === -1) return;
    event.preventDefault();
    if (event.key === "ArrowUp" && at === 0) inputRef.current?.focus();
    else
      rows[
        Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))
      ]?.focus();
  };

  const context = useMemo<SettingsContextValue>(
    () => ({
      t,
      section,
      describe: (id) => index?.get(id),
      read: read.status,
      active,
      rowState: (id) => snapshot.rows[id] ?? "idle",
      highlighted,
      reset: (id, confirmed) => store.reset(id, confirmed)
    }),
    [t, section, index, read.status, active, snapshot.rows, highlighted, store]
  );

  if (!visited) return null;

  const changed = index ? changedIn(section, index, registry) : null;
  const counts = index ? changedCounts(index, registry) : null;
  const Body = sections[section]?.Section ?? GenericSection;
  const columns = "grid-cols-[248px_minmax(0,1fr)] min-[1180px]:grid-cols-[288px_minmax(0,1fr)]";

  return (
    <div
      data-surface={surface}
      data-state={state}
      hidden={!active}
      className={cn("grid h-full min-h-0 bg-background text-foreground", columns)}
    >
      <div className="flex min-h-0 flex-col overflow-auto border-r border-border bg-background py-5 pl-6 pr-4">
        <h2 className="m-0 mb-3 font-reading text-xl font-semibold text-foreground">
          {t("settingsShell.title")}
        </h2>
        <SettingsSearchField
          t={t}
          value={query}
          onChange={setQuery}
          disabled={fieldWaits}
          inputRef={inputRef}
          onKeyDown={onSearchKeyDown}
          controls={searching ? resultsId : undefined}
        />
        <SectionNav
          t={t}
          current={section}
          onSelect={chooseSection}
          changed={counts}
          hits={searching ? hitCounts(hits) : null}
        />
        <div className="mx-2 mt-auto grid gap-2 pt-4 text-xs text-muted-foreground">
          <p className="m-0 [text-wrap:pretty]">{t("settingsShell.navFoot")}</p>
          {onOpenClassic ? (
            <InlineAction onClick={onOpenClassic} size="xs">
              {t("settingsShell.classic.open")}
            </InlineAction>
          ) : null}
        </div>
      </div>

      <div
        ref={scroller}
        className="min-h-0 overflow-auto bg-surface [scroll-padding-block:1.5rem]"
      >
        <div className="max-w-[45rem] px-10 pb-16 pt-6">
          {searching ? (
            <SettingsResults
              t={t}
              id={resultsId}
              query={query}
              hits={hits}
              registry={registry}
              index={index}
              current={section}
              onOpen={openHit}
              onClear={clearSearch}
              onSuggest={(word) => {
                setQuery(word);
                inputRef.current?.focus();
              }}
              onKeyDown={onResultsKeyDown}
            />
          ) : (
            <SettingsContext.Provider value={context}>
              <h2
                ref={titleRef}
                tabIndex={-1}
                className="m-0 font-reading text-2xl font-semibold text-foreground outline-none [text-wrap:balance]"
              >
                {t(sectionMeta[section].name)}
              </h2>
              {read.status === "loading" ? (
                <SettingsSkeleton t={t} Bars={sections[section]?.Skeleton} />
              ) : read.status === "error" ? (
                <ErrorState
                  t={t}
                  className="mt-6"
                  message={t("settingsShell.states.errorTitle")}
                  kept={t("settingsShell.states.errorKept")}
                  retryLabel={t("shell.actions.retry")}
                  onRetry={() => store.retry()}
                />
              ) : (
                <>
                  <SectionSummary
                    t={t}
                    entries={changed ?? []}
                    label={(entry) => labelOf(t, entry)}
                    onJump={(entry) => setPendingRow(entry.id)}
                    onRestoreAll={(ids) => store.restoreAll(ids)}
                  />
                  <Body />
                </>
              )}
            </SettingsContext.Provider>
          )}
        </div>
      </div>
    </div>
  );
}

/** The bars of a section while its values are read: the title's line, a group and some rows. */
function SettingsSkeleton({ t, Bars }: { t: Translator; Bars?: ComponentType | undefined }) {
  const row = (key: string, label: string, help: string, control: string) => (
    <div
      key={key}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 border-b border-border py-4"
    >
      <Skeleton className={cn("h-3.5", label)} />
      <Skeleton className={cn("row-span-2 h-8 rounded-md", control)} />
      <Skeleton className={cn("h-3 max-w-full", help)} />
    </div>
  );
  return (
    <LoadingState t={t} className="mt-4 max-w-[45rem]">
      <div>
        <Skeleton className="mt-1 h-3 w-44" />
        {Bars ? (
          <Bars />
        ) : (
          <>
            <Skeleton className="mt-8 h-3 w-24" />
            {row("a", "w-44", "w-80", "w-44")}
            {row("b", "w-32", "w-72", "w-44")}
            {row("c", "w-44", "w-60", "w-44")}
            <Skeleton className="mt-10 h-3 w-28" />
            {row("d", "w-40", "w-64", "w-28")}
            {row("e", "w-36", "w-72", "w-28")}
          </>
        )}
      </div>
    </LoadingState>
  );
}

/**
 * Under the section's title: how many of its settings differ from their default, which ones (a list
 * that opens in place), and "Restore all", which asks once, in the line, before it writes anything.
 * A setting that deletes something the person gave (a stored key) is never restored from here: it
 * has its own confirmed step in its row, so it is left as it was and counted, like a setting that
 * waits for a step the person confirms. A reset that failed is told apart from those.
 */
function SectionSummary({
  t,
  entries,
  label,
  onJump,
  onRestoreAll
}: {
  t: Translator;
  entries: readonly SettingEntryV2[];
  label: (entry: SettingEntryV2) => string;
  onJump: (entry: SettingEntryV2) => void;
  onRestoreAll: (
    ids: readonly string[]
  ) => Promise<{ done: number; pending: number; failed: number }>;
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(false);
  const [left, setLeft] = useState({ pending: 0, failed: 0 });
  const listId = useId();
  const count = entries.length;
  const restorable = entries.filter((entry) => !resetNeedsConfirm(entry));
  const askCount = restorable.length;

  const plural = (n: number, one: MessageKey, many: MessageKey) =>
    t(n === 1 ? one : many, { values: { count: n } });
  const notes = [
    left.pending > 0
      ? plural(
          left.pending,
          "settingsShell.section.restoreSkippedOne",
          "settingsShell.section.restoreSkippedMany"
        )
      : null,
    left.failed > 0
      ? plural(
          left.failed,
          "settingsShell.section.restoreFailedOne",
          "settingsShell.section.restoreFailedMany"
        )
      : null
  ].filter((note): note is string => note !== null);

  if (count === 0)
    return (
      <p className="m-0 mt-1 text-sm text-secondary-foreground">
        {notes.length > 0 ? notes.join(" ") : t("settingsShell.section.allDefault")}
      </p>
    );

  const run = async () => {
    setWorking(true);
    const tally = await onRestoreAll(restorable.map((entry) => entry.id));
    setWorking(false);
    setAsking(false);
    setLeft({ pending: tally.pending + (count - askCount), failed: tally.failed });
  };

  return (
    <div className="mt-1 text-sm text-secondary-foreground">
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 leading-5">
        {asking ? (
          <>
            <span className="text-foreground">
              {plural(
                askCount,
                "settingsShell.section.restoreAskOne",
                "settingsShell.section.restoreAskMany"
              )}
            </span>
            <Button variant="secondary" disabled={working} onClick={() => void run()}>
              {working
                ? t("settingsShell.row.resetting")
                : t("settingsShell.section.restoreConfirm")}
            </Button>
            <Button variant="ghost" disabled={working} onClick={() => setAsking(false)}>
              {t("shell.actions.cancel")}
            </Button>
          </>
        ) : (
          <>
            <InlineAction
              aria-expanded={open}
              aria-controls={listId}
              aria-label={`${plural(
                count,
                "settingsShell.section.changedOne",
                "settingsShell.section.changedMany"
              )}. ${t("settingsShell.section.listLabel")}`}
              onClick={() => setOpen((value) => !value)}
            >
              {plural(
                count,
                "settingsShell.section.changedOne",
                "settingsShell.section.changedMany"
              )}
              <ChevronDown
                aria-hidden="true"
                className={cn("transition-transform", open && "rotate-180")}
              />
            </InlineAction>
            <span>{t("settingsShell.section.inSection")}</span>
            {askCount > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <InlineAction onClick={() => setAsking(true)}>
                  {t("settingsShell.section.restoreAll")}
                </InlineAction>
              </>
            ) : null}
          </>
        )}
      </p>
      {notes.length > 0 && !asking ? (
        <p role="status" className="m-0 mt-1 text-xs text-muted-foreground">
          {notes.join(" ")}
        </p>
      ) : null}
      {open && !asking ? (
        <ul
          id={listId}
          className="m-0 mt-2 grid list-none gap-0.5 border-l-2 border-border py-1 pl-3"
        >
          {entries.map((entry) => (
            <li key={entry.id}>
              <InlineAction onClick={() => onJump(entry)}>{label(entry)}</InlineAction>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  Columns3,
  House,
  Inbox,
  LayoutDashboard,
  Library,
  Plus,
  Search,
  Settings,
  SunMoon
} from "lucide-react";
import type { ObjectKind, ObjectResolved } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";
import type { LucideIcon } from "lucide-react";

import { ObjectKindGlyph, objectKindTextClass } from "../../components/glyphs";
import { Button } from "../../components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "../../components/ui/command";
import { ErrorState } from "../../components/ui/error-state";
import { Kbd } from "../../components/ui/kbd";
import { fadeOut, popSurface } from "../../components/ui/popover";
import { LoadingState, Skeleton, skeletonDelayMs } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { markKey } from "../../lib/omni-marks";
import { useOmni } from "../../lib/use-omni";
import { useOverflowLevel } from "../../lib/use-overflow-level";
import { PlaceText, useObjectPreview } from "../ObjectLink";
import { countKey, kindWordKeys, placeOf, previewCounts, titleOf } from "../ObjectLinkModel";
import type { PreviewBatcher } from "../preview-batcher";
import type { WorkspaceState } from "../state";
import { resolveCommands } from "./commands";
import { markPieces, queryTerms } from "./highlight";
import {
  activate,
  buildPalette,
  moreEffect,
  omniParamsFor,
  paletteKey,
  parsePaletteQuery,
  prefixChars,
  reconcileSelection,
  recentLimit,
  searchAllEffect,
  withPrefix,
  type GroupId,
  type PaletteEffect,
  type PaletteGroup,
  type PaletteRow,
  type PrefixChar,
  type RecentEntry
} from "./palette-model";
import { useResolved } from "./use-resolved";

/**
 * Cmd-K (design record §11, D13, spec 3.5): cmdk inside a modal Radix dialog. The scrim covers the
 * window, focus goes to the input and comes back on Esc. The box takes a prefix (`>` actions, `?`
 * ask, `#` topics, `@` entities) and otherwise searches everything through `search.omni` in quick
 * mode, one request at a time (`useOmni`). Rows are grouped (best result, topics, notes, sources
 * and entities, questions, then "Fazer"), matches are underlined wherever they occur, and the
 * highlighted row's object shows in the pane at the right.
 *
 * ↵ opens beside, ⌥↵ opens in the focused panel, ⇧↵ opens the search results panel, ⌘Y peeks
 * (quick-look reads the row's `data-quick-look` and the input's active descendant), Space types a
 * space and Tab walks input, chips, "mostrar mais" and the preview.
 */

export interface PaletteProps {
  t: Translator;
  /** The workspace, for the commands that depend on it (hoist, reopen). */
  state: WorkspaceState;
  /** What the palette does with a chosen row: open an address or run a command. */
  onEffect: (effect: PaletteEffect) => void;
  onClose: () => void;
  /** The box's first text (a prefix typed by a shortcut, or a screen's query). */
  initialQuery?: string;
  /** Render in place instead of in a portal (tests and screens). */
  portal?: boolean;
  /** Tests and screens: the batcher the rows' places are read through. */
  batcher?: PreviewBatcher;
  /** Tests and screens: the reader of recents and pins. */
  recents?: () => Promise<readonly RecentEntry[]>;
}

/** `window.app.viewHistory`: the opened objects, with the pinned ones besides the recent ones. */
async function readRecents(): Promise<RecentEntry[]> {
  const history = typeof window === "undefined" ? undefined : window.app?.viewHistory;
  if (!history) return [];
  const entries = await history.list({ limit: recentLimit });
  return entries.map((entry) => ({
    address: entry.address,
    kind: entry.kind,
    title: entry.title,
    pinned: entry.pinned
  }));
}

function useRecents(read: PaletteProps["recents"]): readonly RecentEntry[] {
  const [recents, setRecents] = useState<readonly RecentEntry[]>([]);
  useEffect(() => {
    let live = true;
    // A history that cannot be read leaves the empty box without recents; nothing else changes.
    (read ?? readRecents)().then(
      (entries) => live && setRecents(entries),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [read]);
  return recents;
}

// ---------------------------------------------------------------------------------------------
// Pieces

const groupKeys: Record<GroupId, MessageKey> = {
  best: "palette.groups.best",
  topic: "palette.groups.topic",
  note: "palette.groups.note",
  sourceEntity: "palette.groups.sourceEntity",
  entity: "palette.groups.entity",
  question: "palette.groups.question",
  recent: "palette.groups.recent",
  pinned: "palette.groups.pinned",
  do: "palette.groups.do"
};

const prefixCopy: Record<PrefixChar, { word: MessageKey; label: MessageKey }> = {
  ">": { word: "palette.prefixes.actions", label: "palette.prefixes.actionsLabel" },
  "?": { word: "palette.prefixes.ask", label: "palette.prefixes.askLabel" },
  "#": { word: "palette.prefixes.topics", label: "palette.prefixes.topicsLabel" },
  "@": { word: "palette.prefixes.entities", label: "palette.prefixes.entitiesLabel" }
};

/**
 * The glyph a command wears in the "Fazer" group. Every action row has the 16 px slot, drawn or
 * empty, so all the titles share one text edge with the rows above (a command with no glyph of
 * its own leaves the slot empty).
 */
const commandGlyphs: Record<string, LucideIcon> = {
  "add-source": Plus,
  "go-home": House,
  "go-explore": Columns3,
  "go-library": Library,
  "go-inbox": Inbox,
  "go-map": LayoutDashboard,
  "go-settings": Settings,
  theme: SunMoon
};

/** Underline and weight, never a colour (design record §11). */
function Marked({ text, terms }: { text: string; terms: readonly string[] }) {
  return (
    <>
      {markPieces(text, terms).map((piece, index) =>
        piece.marked ? (
          <mark
            key={index}
            className="bg-transparent font-semibold text-inherit underline decoration-1 underline-offset-[3px]"
          >
            {piece.text}
          </mark>
        ) : (
          <span key={index}>{piece.text}</span>
        )
      )}
    </>
  );
}

/** The place of a result as crumbs of words, "Ciências da vida › Microbiologia", marked. */
function PlaceLine({
  t,
  item,
  terms
}: {
  t: Translator;
  item: ObjectResolved | undefined;
  terms: readonly string[];
}) {
  const crumbs = item ? placeOf(item) : [];
  if (crumbs.length === 0) return null;
  const separator = " › ";
  return (
    <span className="min-w-0 truncate text-sm text-secondary-foreground">
      {crumbs.map((crumb, index) => (
        <span key={`${crumb.id}-${index}`}>
          {index > 0 ? separator : null}
          <Marked
            text={crumb.title === "" ? t("panelFrame.ribbon.untitled") : crumb.title}
            terms={terms}
          />
        </span>
      ))}
    </span>
  );
}

/** "Tópico · 32 itens": the kind and the count that suits it. */
export function rowMeta(t: Translator, kind: ObjectKind, item: ObjectResolved | undefined): string {
  const word = t(kindWordKeys[kind]);
  const counts = item?.counts ?? {};
  const count = (name: string): number => counts[name] ?? 0;
  const pick = (one: MessageKey, many: MessageKey, value: number) =>
    value > 0 ? t(value === 1 ? one : many, { values: { count: value } }) : null;
  const detail =
    kind === "topic"
      ? pick("palette.meta.itemsOne", "palette.meta.itemsMany", count("notes"))
      : kind === "source" || kind === "entity"
        ? pick("palette.meta.notesOne", "palette.meta.notesMany", count("notes"))
        : kind === "note"
          ? pick("palette.meta.sourcesOne", "palette.meta.sourcesMany", count("sources"))
          : null;
  return detail ? `${word} · ${detail}` : word;
}

function Row({
  t,
  row,
  terms,
  resolved,
  onChoose
}: {
  t: Translator;
  row: PaletteRow;
  terms: readonly string[];
  resolved: ReadonlyMap<string, ObjectResolved>;
  onChoose: (row: PaletteRow) => void;
}) {
  if (row.type === "action") {
    const Glyph = commandGlyphs[row.commandId];
    return (
      <CommandItem value={row.id} data-palette-row="action" onSelect={() => onChoose(row)}>
        {Glyph ? (
          <Glyph aria-hidden="true" className="text-muted-foreground" />
        ) : (
          <span aria-hidden="true" className="size-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">
          <Marked text={row.label} terms={terms} />
        </span>
        {row.shortcut ? (
          <Kbd className="ml-auto shrink-0" aria-hidden="true">
            {row.shortcut}
          </Kbd>
        ) : null}
      </CommandItem>
    );
  }
  if (row.type === "ask") {
    return (
      <CommandItem value={row.id} data-palette-row="ask" onSelect={() => onChoose(row)}>
        <ObjectKindGlyph kind="question" size={16} className={objectKindTextClass.question} />
        <span className="min-w-0 flex-1 truncate" title={row.question}>
          {t("palette.rows.ask", { values: { question: row.question } })}
        </span>
        <Kbd className="ml-auto shrink-0" aria-hidden="true">
          ↵
        </Kbd>
      </CommandItem>
    );
  }
  const item = resolved.get(row.address);
  const kind = row.kind;
  const title = row.title.trim() === "" ? t(kindWordKeys[kind]) : row.title;
  // A row whose match is only in its text shows the passage line as well (design record §11).
  const titleMatches = markPieces(title, terms).some((piece) => piece.marked);
  const snippet = row.type === "result" && row.snippet && !titleMatches ? row.snippet : null;
  return (
    <CommandItem
      value={row.id}
      data-palette-row={row.type}
      data-quick-look={row.address}
      onSelect={() => onChoose(row)}
      className="items-start"
    >
      <ObjectKindGlyph
        kind={kind}
        size={16}
        className={cn(objectKindTextClass[kind], "mt-[3px]")}
      />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-baseline justify-between gap-3">
          <span className="min-w-0 truncate" title={title}>
            <Marked text={title} terms={terms} />
          </span>
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {rowMeta(t, kind, item)}
          </span>
        </span>
        <PlaceLine t={t} item={item} terms={terms} />
        {snippet ? (
          <span className="min-w-0 truncate text-sm text-secondary-foreground">
            <span className="text-muted-foreground">{t("palette.meta.snippet")} </span>
            “<Marked text={snippet} terms={terms} />”
          </span>
        ) : null}
      </span>
    </CommandItem>
  );
}

function GroupHeader({
  t,
  group,
  id,
  onMore
}: {
  t: Translator;
  group: PaletteGroup;
  id: string;
  onMore: () => void;
}) {
  const showCount = group.id !== "best" && group.id !== "do" && group.count > 0;
  return (
    <div
      role="presentation"
      className="flex items-center justify-between gap-2 px-3 pb-1 pt-3 text-xs font-semibold text-secondary-foreground"
    >
      <span id={id}>
        {t(groupKeys[group.id])}
        {showCount ? (
          <span className="ml-1.5 font-normal text-muted-foreground">{group.count}</span>
        ) : null}
      </span>
      {group.hidden > 0 && group.moreKinds ? (
        <button
          type="button"
          onClick={onMore}
          className={cn(
            "rounded-sm px-1 text-xs font-medium text-accent hover:text-accent-hover",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          )}
        >
          {t("palette.groups.showMore", { values: { count: group.hidden } })}
        </button>
      ) : null}
    </div>
  );
}

/** Skeleton rows in the shape of result rows: kind glyph, a title and a place line. */
function RowSkeletons({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid gap-1 px-1 pt-3" data-palette-skeleton="">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-[52px] items-start gap-3 px-3 py-2">
          <Skeleton className="mt-[3px] size-4 shrink-0 rounded-sm" />
          <div className="grid min-w-0 flex-1 gap-2">
            <Skeleton className={index % 2 === 0 ? "w-3/5" : "w-2/5"} />
            <Skeleton className="w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The highlighted object at the right: kind, title, place, summary and counts. */
function PreviewPane({
  t,
  address,
  loading,
  batcher
}: {
  t: Translator;
  address: string | null;
  /** The search has not answered: the column keeps its place with the shape of a preview. */
  loading: boolean;
  batcher?: PreviewBatcher;
}) {
  const preview = useObjectPreview(address ?? "", address !== null, batcher);
  const body = (() => {
    if (address === null && !loading) return null;
    const { state } = preview;
    if (address === null || state.status === "loading")
      return (
        <LoadingState t={t} className="gap-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
          <div className="grid gap-2 pt-2">
            <Skeleton className="w-full" />
            <Skeleton className="w-full" />
            <Skeleton className="w-3/4" />
          </div>
        </LoadingState>
      );
    if (state.status === "error")
      return (
        <div className="grid gap-2 text-sm text-secondary-foreground [text-wrap:pretty]">
          <p className="m-0 font-medium text-foreground">{t("preview.card.error")}</p>
          <p className="m-0">{t("preview.card.errorKept")}</p>
          <div>
            <Button onClick={preview.retry}>{t("shell.actions.retry")}</Button>
          </div>
        </div>
      );
    if (state.status === "missing")
      return <p className="m-0 text-sm text-secondary-foreground">{t("preview.card.missing")}</p>;
    const { item } = state;
    const kind = item.kind;
    const place = placeOf(item);
    const counts = previewCounts(item).map((entry) =>
      t(countKey(entry), { values: { count: entry.count } })
    );
    return (
      <div aria-busy={preview.current ? undefined : true} className="grid min-w-0 gap-3">
        <p className="m-0 flex items-center gap-2 text-sm text-secondary-foreground">
          <ObjectKindGlyph kind={kind} size={16} className={objectKindTextClass[kind]} />
          <span className="font-medium">{t(kindWordKeys[kind])}</span>
        </p>
        <h3 className="m-0 font-reading text-lg font-semibold leading-snug [overflow-wrap:anywhere] [text-wrap:balance]">
          {titleOf(item, t(kindWordKeys[kind]))}
        </h3>
        {place.length > 0 ? (
          <p className="m-0 flex items-start gap-1.5 text-sm leading-5 text-secondary-foreground [text-wrap:pretty]">
            <ObjectKindGlyph kind="topic" size={14} className="mt-[3px] text-object-topic" />
            <PlaceText t={t} path={place} />
          </p>
        ) : null}
        {item.preview.trim() === "" ? (
          <p className="m-0 text-sm text-secondary-foreground [text-wrap:pretty]">
            {t("preview.card.empty")}
          </p>
        ) : (
          <p className="m-0 font-reading text-base leading-relaxed text-secondary-foreground [text-wrap:pretty] [overflow-wrap:anywhere]">
            {item.preview}
          </p>
        )}
        {counts.length > 0 ? (
          <p className="m-0 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            {counts.map((part, index) => (
              <span key={index} className="inline-flex gap-2">
                {index > 0 ? <span aria-hidden="true">·</span> : null}
                {part}
              </span>
            ))}
          </p>
        ) : null}
      </div>
    );
  })();
  return (
    <aside
      tabIndex={0}
      aria-label={t("preview.card.label")}
      data-palette-preview=""
      className={cn(
        "w-72 shrink-0 overflow-y-auto overscroll-contain border-l border-border bg-background p-5",
        "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      )}
    >
      {body}
    </aside>
  );
}

function FootKeys({ t, count }: { t: Translator; count: ReactNode }) {
  const labels = [
    t("palette.foot.choose"),
    t("palette.foot.beside"),
    t("palette.foot.here"),
    t("palette.foot.all"),
    t("palette.foot.peek"),
    t("palette.foot.shortBeside"),
    t("palette.foot.shortHere"),
    t("palette.foot.shortAll")
  ].join("|");
  // Fullest form first; a form that does not fit drops a whole clause or shortens, never a word.
  const { box, content, level } = useOverflowLevel<HTMLDivElement, HTMLDivElement>(3, labels);
  const items: Array<{ keys: string[]; label: string }> =
    level === 0
      ? [
          { keys: ["↑", "↓"], label: t("palette.foot.choose") },
          { keys: ["↵"], label: t("palette.foot.beside") },
          { keys: ["⌥↵"], label: t("palette.foot.here") },
          { keys: ["⇧↵"], label: t("palette.foot.all") },
          { keys: ["⌘Y"], label: t("palette.foot.peek") }
        ]
      : level === 1
        ? [
            { keys: ["↵"], label: t("palette.foot.beside") },
            { keys: ["⌥↵"], label: t("palette.foot.here") },
            { keys: ["⇧↵"], label: t("palette.foot.all") },
            { keys: ["⌘Y"], label: t("palette.foot.peek") }
          ]
        : [
            { keys: ["↵"], label: t("palette.foot.shortBeside") },
            { keys: ["⌥↵"], label: t("palette.foot.shortHere") },
            { keys: ["⇧↵"], label: t("palette.foot.shortAll") },
            { keys: ["⌘Y"], label: t("palette.foot.peek") }
          ];
  return (
    <div
      aria-label={t("palette.foot.label")}
      className="flex items-center justify-between gap-4 border-t border-border px-5 py-2 text-xs text-secondary-foreground"
    >
      <div ref={box} className="min-w-0 flex-1 overflow-hidden">
        <div
          ref={content}
          data-fit="palette-foot"
          data-fit-level={level}
          className="inline-flex w-max items-center gap-x-4 whitespace-nowrap"
        >
          {items.map((item) => (
            <span key={item.keys.join("")} className="inline-flex items-center gap-1.5">
              <span className="inline-flex gap-1">
                {item.keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </span>
              <span>{item.label}</span>
            </span>
          ))}
        </div>
      </div>
      {count ? <span className="shrink-0 whitespace-nowrap tabular-nums">{count}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The palette

export function Palette({
  t,
  state,
  onEffect,
  onClose,
  initialQuery = "",
  portal = true,
  batcher,
  recents: readRecentsFrom
}: PaletteProps) {
  const [raw, setRaw] = useState(initialQuery);
  const [selected, setSelected] = useState<string | null>(null);
  const inputId = useId();
  const clickedWith = useRef({ alt: false });

  const parsed = parsePaletteQuery(raw);
  const params = omniParamsFor(parsed);
  const omni = useOmni(params, { instrument: true });
  const history = useRecents(readRecentsFrom);

  // An answer to another mode's question (the box changed from everything to `#`) is not shown.
  const sameKinds = (a?: readonly ObjectKind[], b?: readonly ObjectKind[]) =>
    (a ?? []).join() === (b ?? []).join();
  const relevant =
    params !== null && omni.answered !== null && sameKinds(omni.answered.kinds, params.kinds);
  const items = relevant ? omni.items : [];
  const searching = params !== null && omni.status === "loading";
  const failed = params !== null && omni.status === "error";
  const settled = params === null || omni.status === "ready";

  const commands = resolveCommands(t, state);
  const view = buildPalette({ parsed, items, settled, recents: history, commands });
  const active = reconcileSelection(selected, view.rows);
  const activeRow = view.rows.find((row) => row.id === active) ?? null;

  const resolved = useResolved(
    view.rows.flatMap((row) =>
      row.type === "result" || row.type === "recent" ? [row.address] : []
    ),
    batcher
  );
  const terms = queryTerms(parsed.text);
  const slow = useSlowSearch(searching);

  const dataState: "loading" | "empty" | "error" | "success" = failed
    ? "error"
    : searching && items.length === 0
      ? "loading"
      : view.empty
        ? "empty"
        : "success";

  const choose = (effect: PaletteEffect | null) => {
    if (effect === null) return;
    onEffect(effect);
    onClose();
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const action = paletteKey(event.nativeEvent);
    if (action === null) return;
    // Enter is the palette's: cmdk would select the row without the modifiers.
    event.preventDefault();
    if (action.type === "searchAll") choose(searchAllEffect(parsed));
    else if (activeRow) choose(activate(activeRow, action.how));
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const native = event.nativeEvent;
    const edits =
      event.key === "Backspace" ||
      event.key === "Delete" ||
      (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey);
    if (edits && !native.isComposing) markKey(native.timeStamp, raw);
  };

  const focusInput = () => document.getElementById(inputId)?.focus();
  const toggleChip = (prefix: PrefixChar) => {
    setRaw(withPrefix(raw, parsed.prefix === prefix ? null : prefix));
    setSelected(null);
    focusInput();
  };

  // While a query is typed in the everything, topics or entities mode the list region keeps one
  // height and the preview column keeps its place in every state, so the dialog does not change
  // shape between loading, nothing found, a failure and the results.
  const stable =
    parsed.text !== "" &&
    (parsed.mode === "all" || parsed.mode === "topics" || parsed.mode === "entities");
  const objectRows = view.rows.some((row) => row.type === "result" || row.type === "recent");
  const showPane = parsed.mode === "all" || parsed.mode === "topics" || parsed.mode === "entities";
  const paneAddress =
    activeRow && (activeRow.type === "result" || activeRow.type === "recent")
      ? activeRow.address
      : null;

  const total = settled && params !== null ? omni.items.length : null;
  const count =
    total !== null && total > 0 && relevant && omni.tookMs !== null
      ? t(total === 1 ? "palette.foot.resultsOne" : "palette.foot.resultsMany", {
          values: { count: total, ms: omni.tookMs }
        })
      : null;

  const renderGroup = (group: PaletteGroup) => (
    <GroupBlock
      key={group.id}
      t={t}
      group={group}
      terms={terms}
      resolved={resolved}
      onMore={() => choose(moreEffect(group, parsed))}
      onChoose={(row) => choose(activate(row, clickedWith.current.alt ? "here" : "beside"))}
    />
  );
  // "Fazer" is always last, below the skeleton rows of a search that has not answered.
  const listGroups = view.groups.filter((group) => group.id !== "do");
  const doGroup = view.groups.find((group) => group.id === "do");

  const body = (
    <div data-surface="palette" data-state={dataState} className="flex min-h-0 flex-1 flex-col">
      <Command
        shouldFilter={false}
        loop
        label={t("palette.label")}
        value={active ?? ""}
        onValueChange={(value) => setSelected(value)}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 rounded-xl"
      >
        <div className="relative flex h-14 shrink-0 items-center border-b border-border">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-5 size-[18px] text-muted-foreground"
          />
          <CommandInput
            id={inputId}
            value={raw}
            onValueChange={(next) => {
              setRaw(next);
              setSelected(null);
            }}
            onKeyDown={onInputKeyDown}
            placeholder={t("palette.placeholder")}
            autoComplete="off"
            spellCheck={false}
            style={{
              paddingInlineStart: "var(--space-12)",
              paddingInlineEnd: "var(--space-16)"
            }}
          />
          <Kbd className="absolute right-5" aria-hidden="true">
            Esc
          </Kbd>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-5 py-2.5 text-sm">
          <span className="text-secondary-foreground">{t("palette.prefixes.label")}</span>
          {prefixChars.map((prefix) => (
            <Button
              key={prefix}
              variant="chip"
              size="sm"
              aria-pressed={parsed.prefix === prefix}
              aria-label={t(prefixCopy[prefix].label)}
              onClick={() => toggleChip(prefix)}
            >
              <span aria-hidden="true">
                {prefix} {t(prefixCopy[prefix].word)}
              </span>
            </Button>
          ))}
          <span className="ml-auto text-secondary-foreground [text-wrap:pretty]">
            {t("palette.prefixes.none")}
          </span>
        </div>
        <div
          className={cn(
            "flex min-w-0",
            stable
              ? "h-[min(34rem,calc(100vh-15rem))] shrink-0"
              : "min-h-80 max-h-[min(34rem,calc(100vh-15rem))] flex-1"
          )}
        >
          <CommandList
            aria-label={t("palette.listLabel")}
            onClickCapture={(event) => {
              clickedWith.current = { alt: event.altKey };
            }}
            className="min-w-0 flex-1"
          >
            {failed ? (
              <div className="px-3 pt-3">
                <ErrorState
                  t={t}
                  message={t("palette.states.error")}
                  kept={t("palette.states.errorKept")}
                  retryLabel={t("shell.actions.retry")}
                  onRetry={omni.retry}
                />
              </div>
            ) : null}
            {view.empty ? (
              <p className="m-0 px-3 pb-1 pt-4 text-sm text-secondary-foreground [text-wrap:pretty]">
                {t("palette.states.noResult", { values: { query: parsed.text } })}
              </p>
            ) : null}
            {parsed.mode === "actions" && view.rows.length === 0 ? (
              <p className="m-0 px-3 py-5 text-center text-sm text-secondary-foreground [text-wrap:pretty]">
                {t("palette.states.noCommand", { values: { query: parsed.text } })}
              </p>
            ) : null}
            {parsed.mode === "ask" && parsed.text === "" ? (
              <p className="m-0 px-3 py-5 text-sm text-secondary-foreground [text-wrap:pretty]">
                {t("palette.states.askHint")}
              </p>
            ) : null}
            {listGroups.map(renderGroup)}
            {searching && (items.length === 0 || slow) ? (
              <LoadingState t={t} {...(items.length === 0 ? {} : { delayMs: 0 })} className="gap-0">
                <RowSkeletons rows={items.length === 0 ? 3 : 2} />
              </LoadingState>
            ) : null}
            {doGroup ? renderGroup(doGroup) : null}
          </CommandList>
          {showPane && (objectRows || paneAddress !== null || stable) ? (
            <PreviewPane
              t={t}
              address={paneAddress}
              loading={dataState === "loading"}
              {...(batcher ? { batcher } : {})}
            />
          ) : null}
        </div>
        <FootKeys t={t} count={count} />
      </Command>
    </div>
  );

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      {portal ? (
        <DialogPrimitive.Portal>
          <PaletteSurface t={t}>{body}</PaletteSurface>
        </DialogPrimitive.Portal>
      ) : (
        <PaletteSurface t={t}>{body}</PaletteSurface>
      )}
    </DialogPrimitive.Root>
  );
}

/** Slow means the search has taken longer than 150 ms: only then do skeleton rows join the list. */
function useSlowSearch(searching: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!searching) return undefined;
    const timer = setTimeout(() => setSlow(true), skeletonDelayMs);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [searching]);
  return searching && slow;
}

function GroupBlock({
  t,
  group,
  terms,
  resolved,
  onMore,
  onChoose
}: {
  t: Translator;
  group: PaletteGroup;
  terms: readonly string[];
  resolved: ReadonlyMap<string, ObjectResolved>;
  onMore: () => void;
  onChoose: (row: PaletteRow) => void;
}) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} data-palette-group={group.id}>
      <GroupHeader t={t} group={group} id={headingId} onMore={onMore} />
      {group.rows.map((row) => (
        <Row key={row.id} t={t} row={row} terms={terms} resolved={resolved} onChoose={onChoose} />
      ))}
    </div>
  );
}

function PaletteSurface({ t, children }: { t: Translator; children: ReactNode }) {
  return (
    <>
      <DialogPrimitive.Overlay
        className={cn(
          "fixed inset-0 z-40 bg-[var(--scrim)]",
          "data-[state=open]:animate-[ui-fade-in_var(--motion-base)_var(--ease-out)_both]",
          fadeOut
        )}
      />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          // Focus goes to the input with the caret at the end: a prefix typed for the person
          // (or a query) is continued, never selected and overwritten by the next key.
          event.preventDefault();
          const input = (event.currentTarget as HTMLElement | null)?.querySelector("input");
          if (input) {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          }
        }}
        onInteractOutside={(event) => {
          // A peek over the palette (⌘Y) is a layer of its own: a click in it is not a click away.
          const target = event.target as Element | null;
          if (target?.closest?.("[data-non-modal]")) event.preventDefault();
        }}
        className={cn(
          "fixed left-1/2 top-18 flex w-[min(800px,calc(100%-var(--space-16)))] -translate-x-1/2 flex-col overflow-hidden",
          "max-h-[calc(100vh-var(--space-12)-var(--space-12))]",
          popSurface
        )}
      >
        <DialogPrimitive.Title className="sr-only">{t("palette.label")}</DialogPrimitive.Title>
        {children}
      </DialogPrimitive.Content>
    </>
  );
}

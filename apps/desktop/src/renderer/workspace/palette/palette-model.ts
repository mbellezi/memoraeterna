import type { ObjectKind } from "@app/domain";

import type { SearchOmniItem } from "../../../shared/ipc-search";
import type { OmniParams } from "../../lib/use-omni";
import type { DestinationId } from "../destinations";
import { formatView, routeLimits } from "../route";
import type { WorkspaceAction, WorkspaceState } from "../state";
import { matchCommands, type ResolvedCommand } from "./commands";
import { foldText } from "./highlight";

/**
 * Cmd-K's rules (design record §11, D13, spec 3.5, amendments A4 and S8) as plain functions: what a
 * prefix means, which rows the palette lists for a query and in which groups, what a key does and
 * where an opened row goes. No React, no DOM: the view only draws what this says.
 */

// ---------------------------------------------------------------------------------------------
// The query and its prefix

export const prefixModes = {
  ">": "actions",
  "?": "ask",
  "#": "topics",
  "@": "entities"
} as const;
export type PrefixChar = keyof typeof prefixModes;
export type PaletteMode = "all" | (typeof prefixModes)[PrefixChar];
export const prefixChars = Object.keys(prefixModes) as PrefixChar[];

export interface ParsedQuery {
  mode: PaletteMode;
  prefix: PrefixChar | null;
  /** What follows the prefix, trimmed: the words searched, the command looked for, the question. */
  text: string;
}

const isPrefix = (value: string | undefined): value is PrefixChar =>
  value !== undefined && Object.hasOwn(prefixModes, value);

/** A prefix character at the very start of the box changes the mode; anywhere else it is a letter. */
export function parsePaletteQuery(raw: string): ParsedQuery {
  const first = raw[0];
  if (isPrefix(first))
    return { mode: prefixModes[first], prefix: first, text: raw.slice(1).trim() };
  return { mode: "all", prefix: null, text: raw.trim() };
}

/** The box's text after a chip: the prefix swapped for `prefix`, or taken off for null. */
export function withPrefix(raw: string, prefix: PrefixChar | null): string {
  const { text } = parsePaletteQuery(raw);
  if (prefix === null) return text;
  return text === "" ? `${prefix} ` : `${prefix} ${text}`;
}

/** The longest text `search.omni` takes. */
export const omniQueryMax = 200;
/** What Cmd-K asks for: enough rows for three per group and the counts of "mostrar mais". */
export const quickLimit = 30;

/** The kinds a mode narrows the search to. */
export function modeKinds(mode: PaletteMode): ObjectKind[] | undefined {
  if (mode === "topics") return ["topic"];
  if (mode === "entities") return ["entity"];
  return undefined;
}

/** What to ask `search.omni`, or null when the box asks nothing of it (empty, `>` or `?`). */
export function omniParamsFor(parsed: ParsedQuery): OmniParams | null {
  if (parsed.text === "" || parsed.mode === "actions" || parsed.mode === "ask") return null;
  const kinds = modeKinds(parsed.mode);
  return {
    query: parsed.text.slice(0, omniQueryMax),
    mode: "quick",
    limit: quickLimit,
    ...(kinds ? { kinds } : {})
  };
}

// ---------------------------------------------------------------------------------------------
// The rows

/** A recent or pinned object, as the view history lists it. */
export interface RecentEntry {
  address: string;
  kind: ObjectKind;
  title: string;
  pinned: boolean;
}

export type PaletteRow =
  | {
      type: "result";
      id: string;
      address: string;
      kind: ObjectKind;
      title: string;
      snippet?: string;
    }
  | {
      type: "recent";
      id: string;
      address: string;
      kind: ObjectKind;
      title: string;
      pinned: boolean;
    }
  | { type: "action"; id: string; commandId: string; label: string; shortcut?: string }
  | { type: "ask"; id: string; question: string };

export type GroupId =
  "best" | "topic" | "note" | "sourceEntity" | "entity" | "question" | "recent" | "pinned" | "do";

export interface PaletteGroup {
  id: GroupId;
  rows: PaletteRow[];
  /** The rows of the group's kinds the search returned, shown or not. */
  count: number;
  /** How many of them "mostrar mais" opens; 0 when the group shows them all. */
  hidden: number;
  /** The kinds "mostrar mais" filters the results panel to. */
  moreKinds?: ObjectKind[];
}

export interface PaletteView {
  groups: PaletteGroup[];
  /** Every row, in the order the keys walk them. */
  rows: PaletteRow[];
  /** The query asked and the search answered with nothing: "Nada com “x”.". */
  empty: boolean;
}

/** Rows of one group a query shows before "mostrar mais". */
export const groupLimit = 3;
/** Commands the "Fazer" group shows beside a search. */
const actionLimit = 3;

const groupOfKind: Record<ObjectKind, Exclude<GroupId, "best" | "recent" | "pinned" | "do">> = {
  topic: "topic",
  note: "note",
  source: "sourceEntity",
  entity: "sourceEntity",
  question: "question"
};
const groupOrder = ["topic", "note", "sourceEntity", "question"] as const;
const groupKinds: Record<(typeof groupOrder)[number], ObjectKind[]> = {
  topic: ["topic"],
  note: ["note"],
  sourceEntity: ["source", "entity"],
  question: ["question"]
};

const resultRow = (item: SearchOmniItem): PaletteRow => ({
  type: "result",
  id: `result:${item.address}`,
  address: item.address,
  kind: item.kind,
  title: item.title,
  ...(item.snippet ? { snippet: item.snippet } : {})
});

const recentRow = (entry: RecentEntry): PaletteRow => ({
  type: "recent",
  id: `recent:${entry.address}`,
  address: entry.address,
  kind: entry.kind,
  title: entry.title,
  pinned: entry.pinned
});

const actionRow = (command: ResolvedCommand): PaletteRow => ({
  type: "action",
  id: `action:${command.id}`,
  commandId: command.id,
  label: command.label,
  ...(command.shortcut ? { shortcut: command.shortcut } : {})
});

const askRow = (question: string): PaletteRow => ({ type: "ask", id: "ask", question });

const group = (id: GroupId, rows: PaletteRow[], count = rows.length): PaletteGroup => ({
  id,
  rows,
  count,
  hidden: Math.max(0, count - rows.length)
});

/** How many recents the empty box lists. */
export const recentLimit = 5;

/** The recents and pins whose title holds the typed character, for a one-character box. */
function recentsFor(recents: readonly RecentEntry[], text: string): RecentEntry[] {
  const folded = foldText(text);
  return recents.filter((entry) => folded === "" || foldText(entry.title).includes(folded));
}

export interface BuildInput {
  parsed: ParsedQuery;
  /** What `search.omni` answered for the query on screen. */
  items: readonly SearchOmniItem[];
  /** The answer is in for the query on screen (an empty `items` then means nothing was found). */
  settled: boolean;
  recents: readonly RecentEntry[];
  commands: readonly ResolvedCommand[];
}

/** The groups for a box, in the order of the design record. */
export function buildPalette(input: BuildInput): PaletteView {
  const { parsed, items, settled, recents, commands } = input;
  const groups: PaletteGroup[] = [];

  if (parsed.mode === "actions") {
    const found = matchCommands(commands, parsed.text);
    if (found.length > 0) groups.push(group("do", found.map(actionRow)));
  } else if (parsed.mode === "ask") {
    if (parsed.text !== "") groups.push(group("do", [askRow(parsed.text)]));
  } else if (parsed.mode === "topics" || parsed.mode === "entities") {
    const id = parsed.mode === "topics" ? "topic" : "entity";
    if (items.length > 0) groups.push(group(id, items.map(resultRow)));
  } else if (parsed.text === "") {
    // The empty box: where the person was, what they pinned, and a few things to do.
    const pinned = recents.filter((entry) => entry.pinned);
    const recent = recents.filter((entry) => !entry.pinned).slice(0, recentLimit);
    if (recent.length > 0) groups.push(group("recent", recent.map(recentRow)));
    if (pinned.length > 0) groups.push(group("pinned", pinned.map(recentRow)));
    const suggested = commands.filter((command) => command.suggested);
    if (suggested.length > 0) groups.push(group("do", suggested.map(actionRow)));
  } else {
    // A one-character box also offers the recents and pins that hold the character.
    if (foldText(parsed.text).length <= 1) {
      const near = recentsFor(recents, parsed.text);
      const pinned = near.filter((entry) => entry.pinned);
      const recent = near.filter((entry) => !entry.pinned).slice(0, recentLimit);
      if (recent.length > 0) groups.push(group("recent", recent.map(recentRow)));
      if (pinned.length > 0) groups.push(group("pinned", pinned.map(recentRow)));
    }
    const [best, ...rest] = items;
    if (best) groups.push(group("best", [resultRow(best)]));
    for (const id of groupOrder) {
      const kinds = groupKinds[id];
      const own = rest.filter((item) => groupOfKind[item.kind] === id);
      if (own.length === 0) continue;
      const shown = own.slice(0, groupLimit).map(resultRow);
      groups.push({ ...group(id, shown, own.length), moreKinds: kinds });
    }
    const doing: PaletteRow[] = [askRow(parsed.text)];
    const found = parsed.text.length >= 2 ? matchCommands(commands, parsed.text) : [];
    doing.push(...found.slice(0, actionLimit).map(actionRow));
    // Nothing found: the way forward is to ask, or to add something that could hold the answer.
    const empty = settled && items.length === 0;
    if (empty && !found.some((command) => command.id === "add-source")) {
      const add = commands.find((command) => command.id === "add-source");
      if (add) doing.push(actionRow(add));
    }
    groups.push(group("do", doing));
  }

  const rows = groups.flatMap((entry) => entry.rows);
  const searches = parsed.mode === "all" || parsed.mode === "topics" || parsed.mode === "entities";
  return { groups, rows, empty: searches && parsed.text !== "" && settled && items.length === 0 };
}

/** The id of the row selected after the rows changed: the one that was, when it is still there. */
export function reconcileSelection(
  selected: string | null,
  rows: readonly PaletteRow[]
): string | null {
  if (selected !== null && rows.some((row) => row.id === selected)) return selected;
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Keys and what they do

/** How a row opens: beside the focused panel (↵), or in it (⌥↵, "abrir neste painel"). */
export type OpenHow = "beside" | "here";

export type PaletteKeyAction =
  | { type: "activate"; how: OpenHow }
  /** ⇧↵: the search results panel with the query. */
  | { type: "searchAll" };

/** The part of a keyboard event the palette's keys read. */
export interface PaletteKeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

/**
 * ↵ opens beside, ⌥↵ opens in the focused panel, ⇧↵ opens the results panel. Any other Enter
 * (with ⌘ or Ctrl) is not the palette's and is left to the list. Arrows, Home and End are the
 * list's own; Space types a space; ⌘Y is quick-look's.
 */
export function paletteKey(event: PaletteKeyInput): PaletteKeyAction | null {
  if (event.isComposing || event.key !== "Enter") return null;
  if (event.metaKey || event.ctrlKey) return null;
  if (event.shiftKey && !event.altKey) return { type: "searchAll" };
  if (event.altKey && !event.shiftKey) return { type: "activate", how: "here" };
  if (!event.altKey && !event.shiftKey) return { type: "activate", how: "beside" };
  return null;
}

/** What a chosen row does: open an address, or run a command. */
export type PaletteEffect =
  { type: "open"; address: string; replace: boolean } | { type: "run"; commandId: string };

/**
 * The Question panel's address for a typed question. A question longer than the address accepts is
 * cut (never refused: a refused address would throw out of the key handler and open nothing).
 */
export function askAddress(question: string): string {
  let text = question.slice(0, routeLimits.maxTextLength);
  for (;;) {
    // Never end on half a surrogate pair.
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
    try {
      return formatView({ view: "ask", question: text });
    } catch (error) {
      // `formatView` throws on an address the parser would refuse (too long once encoded).
      if (text.length <= 1) throw error;
      text = text.slice(0, Math.floor(text.length * 0.8));
    }
  }
}

export function activate(row: PaletteRow, how: OpenHow): PaletteEffect {
  const replace = how === "here";
  switch (row.type) {
    case "result":
    case "recent":
      return { type: "open", address: row.address, replace };
    case "action":
      return { type: "run", commandId: row.commandId };
    case "ask":
      // In `?` mode the Question panel streams the answer (D14).
      return {
        type: "open",
        address: askAddress(row.question),
        replace
      };
  }
}

/** The search results panel for a query, optionally of some kinds. */
export function searchEffect(text: string, kinds?: readonly ObjectKind[]): PaletteEffect | null {
  const query = text.slice(0, omniQueryMax).trim();
  if (query === "") return null;
  const address = formatView({
    view: "search",
    query,
    ...(kinds && kinds.length > 0 ? { kinds: [...kinds] } : {})
  });
  return { type: "open", address, replace: false };
}

/** ⇧↵: the results panel for the box, narrowed to the kind its prefix names; null where it has no meaning. */
export function searchAllEffect(parsed: ParsedQuery): PaletteEffect | null {
  if (parsed.mode === "actions" || parsed.mode === "ask") return null;
  return searchEffect(parsed.text, modeKinds(parsed.mode));
}

/** "mostrar mais (n)" of a group: the results panel filtered to the group's kinds. */
export function moreEffect(entry: PaletteGroup, parsed: ParsedQuery): PaletteEffect | null {
  if (!entry.moreKinds || entry.hidden === 0) return null;
  return searchEffect(parsed.text, entry.moreKinds);
}

/**
 * The workspace actions that open `address` the way the palette does: right of the focused panel
 * of the destination on screen (replacing it for "here"), and onto Explore's stack from Settings,
 * which has no stack of its own.
 */
export function openActions(
  state: WorkspaceState,
  address: string,
  replace: boolean
): WorkspaceAction[] {
  const destination: DestinationId =
    state.destination === "settings" ? "explore" : state.destination;
  const actions: WorkspaceAction[] = [];
  if (state.destination === "settings") actions.push({ type: "go", destination });
  const stack = state.stacks[destination];
  actions.push({
    type: "open",
    address,
    from: stack.focus,
    mode: replace ? "replace" : "push"
  });
  return actions;
}

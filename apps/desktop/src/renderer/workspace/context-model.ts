import {
  confidenceBand,
  formatObjectAddress,
  parseObjectAddress,
  routesToInbox,
  type BacklinkVia,
  type NotePageEvidence,
  type NotePageRelation,
  type ObjectBacklink,
  type ObjectKind,
  type RelationConfidenceWord,
  type SourceRelationView
} from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { relationTypeView, stances, type Stance } from "../lib/relation-stance";
import { contextTabIds, type ContextTabId, type WorkspaceState } from "./state";

/**
 * The context panel's rules, apart from React (design record §5.6; D31 as amended by A2, A3, A5
 * and D33): which tabs show and which sit under "Mais", which object is in focus, how a note's
 * relations group by stance, how a page of backlinks groups by `via`, and how a source's passages
 * group by what cites them. Pure: no window, no clock.
 */

// ---------------------------------------------------------------------------
// The focused object

/** The object the context panel follows: the focused panel's, anchor left out. */
export interface FocusedObject {
  kind: ObjectKind;
  id: string;
  /** `memora://<kind>/<id>`, canonical, with no anchor. */
  address: string;
}

/** The object of an address, or null for a view address (search, ask, import) or text that is none. */
export function objectOfAddress(address: string): FocusedObject | null {
  const parsed = parseObjectAddress(address);
  if (!parsed) return null;
  return {
    kind: parsed.kind,
    id: parsed.id,
    address: formatObjectAddress({ kind: parsed.kind, id: parsed.id })
  };
}

/**
 * The object in the focused panel of the destination on screen. The root surface (focus -1), a view
 * panel and Settings have none: the context panel then says nothing is in focus.
 */
export function focusedObject(
  state: Pick<WorkspaceState, "destination" | "stacks">
): FocusedObject | null {
  if (state.destination === "settings") return null;
  const stack = state.stacks[state.destination];
  const panel = stack.panels[stack.focus];
  if (!panel) return null;
  return objectOfAddress(panel.history[panel.index] ?? "");
}

// ---------------------------------------------------------------------------
// Tabs (priority+)

/** The tabs the row shows before any other, in A5's order; the rest sit under "Mais". */
export const shownTabIds: readonly ContextTabId[] = ["connections", "evidence", "ask"];

/** How many tabs the row may show: three, then fewer when the words do not fit the panel. */
export const tabSlots = { full: 3, narrow: 2, least: 1 } as const;

export interface TabRow {
  /** Drawn in the row, in A5's order; always holds the selected tab. */
  visible: ContextTabId[];
  /** Under "Mais", in A5's order. */
  more: ContextTabId[];
}

/**
 * The row for the tabs that exist (`available`, any order) with `active` selected. The shown tabs
 * take the slots; a selected tab that is not among them takes the last slot (design record §5.6:
 * "a chosen Mais tab takes the third slot"), so the selected tab is always visible. With fewer
 * shown tabs than slots (a tab that is not built yet), the selected one is added instead.
 */
export function tabRow(
  available: readonly ContextTabId[],
  active: ContextTabId,
  slots: number = tabSlots.full
): TabRow {
  const exists = (tab: ContextTabId) => available.includes(tab);
  const room = Math.max(1, Math.floor(slots));
  let visible = shownTabIds.filter(exists).slice(0, room);
  if (exists(active) && !visible.includes(active)) {
    visible =
      visible.length >= room ? [...visible.slice(0, room - 1), active] : [...visible, active];
  }
  const inOrder = (list: readonly ContextTabId[]) =>
    contextTabIds.filter((tab) => list.includes(tab));
  const shown = inOrder(visible);
  return { visible: shown, more: inOrder(available).filter((tab) => !shown.includes(tab)) };
}

/** The tab to show: the one asked for when it exists, else the first that does. */
export function resolveTab(
  requested: ContextTabId,
  available: readonly ContextTabId[]
): ContextTabId {
  if (available.includes(requested)) return requested;
  return contextTabIds.find((tab) => available.includes(tab)) ?? requested;
}

/** The tab an arrow key, Home or End moves to along the visible tabs; null for any other key. */
export function tabForKey(
  visible: readonly ContextTabId[],
  active: ContextTabId,
  key: string
): ContextTabId | null {
  if (visible.length === 0) return null;
  const at = Math.max(0, visible.indexOf(active));
  if (key === "Home") return visible[0] ?? null;
  if (key === "End") return visible.at(-1) ?? null;
  if (key === "ArrowRight") return visible[(at + 1) % visible.length] ?? null;
  if (key === "ArrowLeft") return visible[(at - 1 + visible.length) % visible.length] ?? null;
  return null;
}

export const tabLabelKeys: Readonly<Record<ContextTabId, MessageKey>> = {
  connections: "contextPanel.tabs.connections",
  evidence: "contextPanel.tabs.evidence",
  ask: "contextPanel.tabs.ask",
  mentions: "contextPanel.tabs.mentions",
  graph: "contextPanel.tabs.graph",
  history: "contextPanel.tabs.history"
};

/** The Option-digit that selects a tab (A5): its place in the order. */
export const tabShortcut = (tab: ContextTabId): string => `⌥${contextTabIds.indexOf(tab) + 1}`;

// ---------------------------------------------------------------------------
// Counted nouns

const nouns = {
  connections: ["contextPanel.count.connectionsOne", "contextPanel.count.connectionsOther"],
  suggestions: ["contextPanel.count.suggestionsOne", "contextPanel.count.suggestionsOther"],
  passages: ["contextPanel.count.passagesOne", "contextPanel.count.passagesOther"],
  mentions: ["contextPanel.count.mentionsOne", "contextPanel.count.mentionsOther"],
  notes: ["contextPanel.count.notesOne", "contextPanel.count.notesOther"],
  questions: ["contextPanel.count.questionsOne", "contextPanel.count.questionsOther"],
  sources: ["contextPanel.count.sourcesOne", "contextPanel.count.sourcesOther"]
} as const satisfies Record<string, readonly [MessageKey, MessageKey]>;
export type CountNoun = keyof typeof nouns;

/** "5 conexões": the number is bound to its noun by a no-break space, in the locale's plural. */
export function countText(t: Translator, noun: CountNoun, count: number): string {
  const [one, other] = nouns[noun];
  const key = new Intl.PluralRules(t.locale).select(count) === "one" ? one : other;
  return t(key, { values: { count: new Intl.NumberFormat(t.locale).format(count) } });
}

// ---------------------------------------------------------------------------
// Connections of a note

/**
 * How a relation reads from the open note: `out` (this note is the subject: "esta nota estende"),
 * `in` (the other is: "estendem esta nota"), `linked` (a directed type nobody gave a direction:
 * only linked, decision 31b) or `mutual` (a type that reads both ways).
 */
export type RelationRole = "in" | "out" | "linked" | "mutual";

export function relationRole(relation: Pick<NotePageRelation, "type" | "direction">): RelationRole {
  if (!relationTypeView(relation.type).directed) return "mutual";
  if (relation.direction === "unknown") return "linked";
  return relation.direction === "incoming" ? "in" : "out";
}

/** The heading of a group of shown relations: design record §5.6, one per stance and role. */
const groupHeadings: Readonly<
  Record<Stance, Readonly<Partial<Record<RelationRole, MessageKey>>> & { fallback: MessageKey }>
> = {
  supports: {
    in: "contextPanel.connections.groups.supportsIn",
    out: "contextPanel.connections.groups.supportsOut",
    linked: "contextPanel.connections.groups.supportsLinked",
    fallback: "contextPanel.connections.groups.supportsLinked"
  },
  contradicts: {
    fallback: "contextPanel.connections.groups.contradicts"
  },
  extends: {
    in: "contextPanel.connections.groups.extendsIn",
    out: "contextPanel.connections.groups.extendsOut",
    linked: "contextPanel.connections.groups.extendsLinked",
    fallback: "contextPanel.connections.groups.extendsLinked"
  },
  depends_on: {
    in: "contextPanel.connections.groups.dependsOnIn",
    out: "contextPanel.connections.groups.dependsOnOut",
    linked: "contextPanel.connections.groups.dependsOnLinked",
    fallback: "contextPanel.connections.groups.dependsOnLinked"
  },
  example_of: {
    in: "contextPanel.connections.groups.exampleOfIn",
    out: "contextPanel.connections.groups.exampleOfOut",
    linked: "contextPanel.connections.groups.exampleOfLinked",
    fallback: "contextPanel.connections.groups.exampleOfLinked"
  },
  related: {
    in: "contextPanel.connections.groups.relatedIn",
    out: "contextPanel.connections.groups.relatedOut",
    fallback: "contextPanel.connections.groups.relatedMutual"
  }
};

export const groupHeadingKey = (stance: Stance, role: RelationRole): MessageKey => {
  const headings = groupHeadings[stance];
  return headings[role] ?? headings.fallback;
};

/** One relation as a row of the Connections list. */
export interface ConnectionRow {
  /** The relation's ID: the row's key and what Keep and Remove act on. */
  id: string;
  /** The other note's address. */
  address: string;
  title: string;
  type: string;
  stance: Stance;
  role: RelationRole;
  state: NotePageRelation["state"];
  probability: number | null;
  /** The word for the probability; "unknown" when there is none (never a number made up). */
  confidence: RelationConfidenceWord;
  /** A suggestion the Inbox also holds (D33): its inline box says so. */
  routesToInbox: boolean;
  /** Direction, for the suggestion's sentence. */
  direction: NotePageRelation["direction"];
  directionSource: NotePageRelation["directionSource"];
}

export function connectionRow(relation: NotePageRelation): ConnectionRow {
  const view = relationTypeView(relation.type);
  return {
    id: relation.id,
    address: formatObjectAddress({ kind: "note", id: relation.other.id }),
    title: relation.other.title,
    type: relation.type,
    stance: view.stance,
    role: relationRole(relation),
    state: relation.state,
    probability: relation.probability,
    confidence: confidenceBand(relation.probability),
    routesToInbox: routesToInbox({ stance: relation.type, probability: relation.probability }),
    direction: relation.direction,
    directionSource: relation.directionSource
  };
}

export interface ConnectionGroup {
  /** `<stance>:<role>`, the group's key. */
  key: string;
  stance: Stance;
  role: RelationRole;
  headingKey: MessageKey;
  /** The first row's type, for the heading's glyph (a stance has one glyph). */
  rows: ConnectionRow[];
}

/**
 * The shown relations as groups by stance (in the legend's order, then by role, with the server's
 * order inside a group) and the suggestions apart, each in its own dashed box. Confidence never
 * hides or reorders a row (D11); it is only a word.
 */
export function groupConnections(relations: readonly NotePageRelation[]): {
  groups: ConnectionGroup[];
  suggestions: ConnectionRow[];
} {
  const roleOrder: RelationRole[] = ["in", "out", "mutual", "linked"];
  const groups = new Map<string, ConnectionGroup>();
  const suggestions: ConnectionRow[] = [];
  for (const relation of relations) {
    const row = connectionRow(relation);
    if (row.state === "suggested") {
      suggestions.push(row);
      continue;
    }
    // Directed relations nobody gave a direction (and symmetric ones) share one heading per stance.
    const key = `${row.stance}:${groupHeadingKey(row.stance, row.role)}`;
    const group = groups.get(key) ?? {
      key,
      stance: row.stance,
      role: row.role,
      headingKey: groupHeadingKey(row.stance, row.role),
      rows: []
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort(
    (a, b) =>
      stances.indexOf(a.stance) - stances.indexOf(b.stance) ||
      roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role)
  );
  return { groups: ordered, suggestions };
}

/** The numbers of the heading's description: shown connections and suggestions apart. */
export function connectionCounts(relations: readonly Pick<NotePageRelation, "state">[]): {
  connections: number;
  suggestions: number;
} {
  const suggestions = relations.filter((relation) => relation.state === "suggested").length;
  return { connections: relations.length - suggestions, suggestions };
}

const confidenceKeys: Readonly<Record<RelationConfidenceWord, MessageKey>> = {
  high: "contextPanel.connections.meta.confidenceHigh",
  medium: "contextPanel.connections.meta.confidenceMedium",
  low: "contextPanel.connections.meta.confidenceLow",
  unknown: "contextPanel.connections.meta.confidenceUnknown"
};

export const confidenceKey = (word: RelationConfidenceWord): MessageKey => confidenceKeys[word];

/**
 * The meta line of a row as message keys (who decided, how sure, and for a suggestion what to do
 * next). A kept relation says the person kept it; an automatic one the Gardener and, when the
 * decider calibrated a probability, the word for it. A suggestion always has a word, and "unknown"
 * when there is no probability (Q37); it says "também na Caixa de entrada" when the Inbox holds it
 * too (D33) and "decida quando quiser" when it only lives here.
 */
export function connectionMeta(row: ConnectionRow): MessageKey[] {
  if (row.state === "suggested")
    return [
      "contextPanel.connections.meta.gardenerSuggested",
      confidenceKeys[row.confidence],
      row.routesToInbox
        ? "contextPanel.connections.meta.alsoInInbox"
        : "contextPanel.connections.meta.decideWhenever"
    ];
  if (row.state === "kept") return ["contextPanel.connections.meta.byYou"];
  const parts: MessageKey[] = ["contextPanel.connections.meta.gardener"];
  if (row.probability !== null) parts.push(confidenceKeys[row.confidence]);
  return parts;
}

/** The key a suggestion's box answers to: `a` keeps, Backspace removes (D34); no modifier, no field. */
export function suggestionVerdict(event: {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): "keep" | "remove" | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "a" || event.key === "A") return "keep";
  return event.key === "Backspace" ? "remove" : null;
}

/** A source's relation as a row of its Connections list: the other source and how it is linked. */
export interface SourceConnectionRow {
  id: string;
  address: string;
  title: string;
  type: string;
  stance: Stance;
  state: "suggested" | "kept" | "applied";
  confidence: RelationConfidenceWord;
}

export function sourceConnectionRow(
  relation: Pick<
    SourceRelationView,
    | "id"
    | "sourceItemId"
    | "targetSourceItemId"
    | "sourceTitle"
    | "targetTitle"
    | "relationType"
    | "confidence"
    | "suggested"
    | "status"
  >,
  thisId: string
): SourceConnectionRow {
  const other =
    relation.sourceItemId === thisId
      ? { id: relation.targetSourceItemId, title: relation.targetTitle }
      : { id: relation.sourceItemId, title: relation.sourceTitle };
  return {
    id: relation.id,
    address: formatObjectAddress({ kind: "source", id: other.id }),
    title: other.title,
    type: relation.relationType,
    stance: relationTypeView(relation.relationType).stance,
    state:
      relation.status === "accepted"
        ? "kept"
        : relation.status === "pending_review" && relation.suggested
          ? "suggested"
          : "applied",
    confidence: confidenceBand(relation.confidence)
  };
}

/** Relations of a page appended to the ones read before, each relation once. */
export function appendRelations(
  current: readonly NotePageRelation[],
  page: readonly NotePageRelation[]
): NotePageRelation[] {
  const seen = new Set(current.map((relation) => relation.id));
  return [...current, ...page.filter((relation) => !seen.has(relation.id))];
}

/** How many relations the first read asks for, and each further page. */
export const connectionPageSize = 20;

// ---------------------------------------------------------------------------
// Backlinks

/** What Connections of a source keeps of a backlinks page, and what Mentions and Evidence keep. */
export const connectionVias: readonly BacklinkVia[] = ["relation", "source_relation"];
export const mentionVias: readonly BacklinkVia[] = [
  "mention",
  "overview_citation",
  "question_citation"
];

/** Backlinks the tabs read per request; the repository's own bound is 50. */
export const backlinkPageSize = 50;
/** The most requests one tab page makes while it skips the arms it does not show. */
export const backlinkSkipPages = 6;

export function appendBacklinks(
  current: readonly ObjectBacklink[],
  page: readonly ObjectBacklink[]
): ObjectBacklink[] {
  const key = (item: ObjectBacklink) => `${item.via}|${item.from}|${item.anchor ?? ""}`;
  const seen = new Set(current.map(key));
  return [...current, ...page.filter((item) => !seen.has(key(item)))];
}

export interface BacklinkGroup {
  via: BacklinkVia;
  items: ObjectBacklink[];
}

/** The items of the `vias` asked for, grouped in the order of `vias` (empty groups left out). */
export function groupBacklinks(
  items: readonly ObjectBacklink[],
  vias: readonly BacklinkVia[]
): BacklinkGroup[] {
  return vias
    .map((via) => ({ via, items: items.filter((item) => item.via === via) }))
    .filter((group) => group.items.length > 0);
}

/**
 * Whether a tab keeps reading pages: backlinks come ordered by arm, so the arm a tab shows may lie
 * after pages of another one. It keeps reading while it has fewer than a page of what it shows and
 * there is more, up to `backlinkSkipPages` requests.
 */
export function readsMoreBacklinks(input: {
  found: number;
  hasNext: boolean;
  requests: number;
}): boolean {
  return input.hasNext && input.found < connectionPageSize && input.requests < backlinkSkipPages;
}

// ---------------------------------------------------------------------------
// Passages of a source

/** A passage of a source that something cites: what cites it, and the text when a note carries it. */
export interface PassageEntry {
  /** `passage=<chunk id>`, the anchor of the passage's address. */
  anchor: string;
  snippet: string | null;
  notes: number;
  questions: number;
}

/**
 * The backlinks of a source as the passages they point at: the notes resting on a passage and the
 * questions citing it are counted together. A question that cites the source without naming a
 * passage is counted apart.
 */
export function groupPassages(items: readonly ObjectBacklink[]): {
  passages: PassageEntry[];
  unanchored: number;
} {
  const passages = new Map<string, PassageEntry>();
  let unanchored = 0;
  for (const item of items) {
    if (item.via !== "evidence" && item.via !== "question_citation") continue;
    if (!item.anchor) {
      unanchored += 1;
      continue;
    }
    const entry = passages.get(item.anchor) ?? {
      anchor: item.anchor,
      snippet: null,
      notes: 0,
      questions: 0
    };
    if (item.via === "evidence") {
      entry.notes += 1;
      entry.snippet ??= item.snippet ?? null;
    } else entry.questions += 1;
    passages.set(item.anchor, entry);
  }
  return { passages: [...passages.values()], unanchored };
}

/** The address of a passage of a source (`memora://source/<id>#passage=<chunk>`), or the source. */
export function passageAddress(sourceId: string, anchor: string | null): string {
  const parsed = anchor ? parseObjectAddress(`memora://source/${sourceId}#${anchor}`) : null;
  return formatObjectAddress({
    kind: "source",
    id: sourceId,
    ...(parsed?.anchor ? { anchor: parsed.anchor } : {})
  });
}

// ---------------------------------------------------------------------------
// Evidence of a note, an answer and a topic

/**
 * Where a passage behind a note opens: its source at the passage while the passage is current, the
 * source alone when the passage belongs to an earlier version, and nowhere when the source is gone
 * (only its retained snapshot survives).
 */
export function notePassageTarget(
  item: Pick<NotePageEvidence, "sourceItemId" | "chunkId" | "current" | "sourceAvailable">
): string | null {
  if (!item.sourceAvailable) return null;
  return formatObjectAddress({
    kind: "source",
    id: item.sourceItemId,
    ...(item.current ? { anchor: { passage: item.chunkId } } : {})
  });
}

/** One citation of an answer, once per number: where it opens and whether it can be trusted. */
export interface AnswerCitation {
  number: number;
  /** The cited object with its anchor; null when the target is gone. */
  address: string | null;
  unavailable: boolean;
  stale: boolean;
}

/**
 * The citations of the latest answer version, in the order of their numbers, each number once (a
 * number cited in two paragraphs is one source). The answer's own markers are these numbers.
 */
export function answerCitations(
  answers: readonly {
    paragraphs: readonly {
      citations: readonly {
        ordinal: number;
        address: string | null;
        anchor?:
          | Partial<Record<"passage" | "span" | "section" | "relation", string | undefined>>
          | undefined;
        unavailable: boolean;
        stale: boolean;
      }[];
    }[];
  }[]
): AnswerCitation[] {
  const latest = answers.at(-1);
  if (!latest) return [];
  const byNumber = new Map<number, AnswerCitation>();
  for (const paragraph of latest.paragraphs) {
    for (const citation of paragraph.citations) {
      if (byNumber.has(citation.ordinal)) continue;
      const base = citation.address ? parseObjectAddress(citation.address) : null;
      const anchor = Object.fromEntries(
        Object.entries(citation.anchor ?? {}).filter(([, value]) => typeof value === "string")
      );
      byNumber.set(citation.ordinal, {
        number: citation.ordinal,
        address: base
          ? formatObjectAddress({
              kind: base.kind,
              id: base.id,
              ...(Object.keys(anchor).length > 0 ? { anchor } : {})
            })
          : null,
        unavailable: citation.unavailable,
        stale: citation.stale
      });
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

// ---------------------------------------------------------------------------
// Places

/** Crumbs of a path line: the whole path when it is short, else "…" and the last two. */
export function pathCrumbs(titles: readonly string[]): { folded: boolean; titles: string[] } {
  if (titles.length <= 2) return { folded: false, titles: [...titles] };
  return { folded: true, titles: titles.slice(-2) };
}

/** What the strip says top to bottom, as parts: "Contexto", the tab and, when known, a count. */
export function stripParts(tabName: string, count: number | null): string[] {
  return count === null ? [tabName] : [tabName, String(count)];
}

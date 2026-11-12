import {
  parseObjectAddress,
  type AskScope,
  type ChangeSetRisk,
  type InboxItem,
  type ObjectKind,
  type ObjectResolved
} from "@app/domain";

import type {
  HomeArrival,
  HomeDigest,
  HomeGardenerChange,
  HomeInboxRow,
  HomeQuestion,
  HomeShape
} from "../../../../shared/ipc-home";
import { reduce, type PanelAddress, type WorkspaceAction, type WorkspaceState } from "../../state";

/**
 * What Home says, as pure functions of the digest (design record §7.1; `home.digest`, T130). Each
 * clause of the briefing is true only when its count is, every list is bounded by the digest, and
 * nothing here reads the clock or the language: the view passes `now` and the translator.
 */

/** What Home reads besides the digest. */
export interface HomeData {
  digest: HomeDigest;
  /**
   * The sources that are still generating notes (`library.rows`, status processing): how many and
   * which. Null when that read failed, so the briefing then says nothing about generating.
   */
  generating: { total: number; ids: readonly string[] } | null;
  /** Notes so far and the estimate of a generating source that arrived (`library.sourceProgress`). */
  progress: Readonly<Record<string, { done: number; estimate: number | null }>>;
  /** Titles of the topics the recent questions were asked in, by topic id (a topic that is gone has none). */
  topicTitles: Readonly<Record<string, string>>;
  /** `lastHomeOpenAt` the digest was read since; null when Home was never opened (a week back). */
  lastVisit: string | null;
  /** When the data was read: relative days and times are worded from it, never from a timer. */
  readAt: number;
}

/** First run: the library holds no source. A calm day: nothing arrived, changed or waits. */
export type HomeMode = "firstRun" | "calm" | "brief";

export function homeMode(data: HomeData): HomeMode {
  const { digest, generating } = data;
  if (digest.firstRun) return "firstRun";
  const quiet =
    digest.new.sources.total === 0 &&
    digest.new.notes.total === 0 &&
    digest.gardener.count === 0 &&
    digest.inbox.total === 0 &&
    (generating?.total ?? 0) === 0;
  return quiet ? "calm" : "brief";
}

// ---------------------------------------------------------------------------
// The briefing

export type BriefingClause =
  | { id: "arrivals"; sources: number; notes: number }
  /** Notes arrived for sources that came earlier (a source finishing its notes). */
  | { id: "notesOnly"; notes: number }
  | { id: "placement"; placed: number; unplaced: number }
  | { id: "generating"; count: number }
  | { id: "gardener"; count: number }
  | { id: "decisions"; count: number; top: InboxItem | null };

/**
 * The clauses that are true, in the order the sentence reads. Arrivals need a source or a note,
 * the placement needs arrived notes, the Jardineiro needs a change and the decisions need an open
 * item; a count of zero drops its clause.
 */
export function briefingClauses(data: HomeData): BriefingClause[] {
  const { digest, generating } = data;
  const clauses: BriefingClause[] = [];
  const sources = digest.new.sources.total;
  const notes = digest.new.notes.total;
  if (sources > 0) clauses.push({ id: "arrivals", sources, notes });
  else if (notes > 0) clauses.push({ id: "notesOnly", notes });
  if (notes > 0)
    clauses.push({
      id: "placement",
      placed: digest.new.notes.placed,
      unplaced: digest.new.notes.unplaced
    });
  if (generating && generating.total > 0)
    clauses.push({ id: "generating", count: generating.total });
  if (digest.gardener.count > 0) clauses.push({ id: "gardener", count: digest.gardener.count });
  if (digest.inbox.total > 0)
    clauses.push({
      id: "decisions",
      count: digest.inbox.total,
      top: digest.inbox.top.find((row) => row.item !== null)?.item ?? null
    });
  return clauses;
}

/** `One` or `Other`: the plural form the message tables carry (the locale's own rule). */
export function pluralForm(locale: string, count: number): "One" | "Other" {
  return new Intl.PluralRules(locale).select(count) === "one" ? "One" : "Other";
}

export type GreetingPart = "morning" | "afternoon" | "evening";

/** The greeting by the hour of the local day. */
export function greetingPart(hour: number): GreetingPart {
  if (hour < 12) return "morning";
  return hour < 18 ? "afternoon" : "evening";
}

// ---------------------------------------------------------------------------
// Times

/** The calendar day difference between two instants, in the local time zone. */
export function dayDistance(at: Date, now: Date): number {
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate());
  return Math.round((start(now).getTime() - start(at).getTime()) / 86_400_000);
}

/**
 * The day and month as the person's language says them without filler words or points: "3 nov" for
 * pt-BR, "Nov 3" for English. The one short date of the app (Home, Histórico, Perguntar).
 */
export function shortDate(locale: string, at: Date): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" })
    .formatToParts(at)
    .filter((part) => part.type === "day" || part.type === "month")
    .map((part) => part.value.replace(/\.$/u, ""))
    .join("\u00a0");
}

export interface WhenParts {
  /** Null for today: the time stands alone ("09:12"). */
  day: string | null;
  time: string;
}

/**
 * "09:12" today, "ontem, 22:38" yesterday and "3 nov, 18:20" before: the day as the locale words it
 * (`numeric: "auto"` gives yesterday and the day before), the time of day always.
 */
export function whenParts(locale: string, at: Date, now: Date): WhenParts {
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(at);
  const distance = dayDistance(at, now);
  if (distance <= 0) return { day: null, time };
  const day =
    distance <= 2
      ? new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-distance, "day")
      : shortDate(locale, at);
  return { day, time };
}

/** "Quarta-feira, 11 de novembro": the weekday and the date, first letter in capitals. */
export function dateLine(locale: string, now: Date): string {
  const text = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(now);
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

// ---------------------------------------------------------------------------
// Retomar

export interface ResumeEntry {
  address: PanelAddress;
  kind: ObjectKind;
  title: string;
  openedAt: string;
}

/** The trail that Retomar offers: the three latest objects that still exist, oldest first. */
export const resumeLimit = 3;

export function resumeTrail(digest: HomeDigest): ResumeEntry[] {
  return digest.continue
    .filter((entry) => entry.summary !== null)
    .slice(0, resumeLimit)
    .map((entry) => ({
      address: entry.address,
      kind: entry.kind,
      title: entry.title,
      openedAt: entry.openedAt
    }))
    .reverse();
}

/**
 * What Retomar does to the workspace: go to Explore and push the trail's objects one right of the
 * other, oldest first, so the newest ends up on top. Each push is placed from the focus the
 * previous one left, which the reducer decides (an address already open is focused, not pushed
 * again), so the actions are computed over the reducer from `workspace`.
 */
export function resumeActions(
  workspace: WorkspaceState,
  addresses: readonly PanelAddress[]
): WorkspaceAction[] {
  const actions: WorkspaceAction[] = [{ type: "go", destination: "explore" }];
  let state = reduce(workspace, actions[0] as WorkspaceAction);
  for (const address of addresses) {
    const action: WorkspaceAction = {
      type: "open",
      address,
      from: state.stacks.explore.focus,
      mode: "push"
    };
    actions.push(action);
    state = reduce(state, action);
  }
  return actions;
}

/** Enter resumes only from Home itself: not in a field, a button or a link, and not with a modifier. */
export function isResumeKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  target: { tagName?: string; isContentEditable?: boolean } | null;
}): boolean {
  if (event.key !== "Enter" || event.defaultPrevented) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const tag = event.target?.tagName?.toLowerCase() ?? "";
  if (event.target?.isContentEditable) return false;
  return !["input", "textarea", "select", "button", "a", "summary"].includes(tag);
}

// ---------------------------------------------------------------------------
// The Shape strip

export interface ShapeSegment {
  id: string;
  title: string | null;
  notes: number;
  tooBig: boolean;
  /** Share of the notes in the roots drawn (0..1): the segment's width. */
  share: number;
}

/**
 * How many topics are too big, anywhere in the tree: `outOfBounds` counts every live topic whose
 * health is a violation, not only the roots the strip draws (a root that is too big is among them;
 * the roots' own count is the floor should the two reads disagree for a moment).
 */
export function tooBigTopics(shape: HomeShape): number {
  const roots = shape.roots.filter((root) => root.health === "violation").length;
  return Math.max(shape.outOfBounds, roots);
}

export function shapeSegments(shape: HomeShape): ShapeSegment[] {
  const total = shape.roots.reduce((sum, root) => sum + root.notes, 0);
  return shape.roots.map((root) => {
    const share = total > 0 ? root.notes / total : 1 / Math.max(1, shape.roots.length);
    return {
      id: root.id,
      title: root.title,
      notes: root.notes,
      tooBig: root.health === "violation",
      share
    };
  });
}

// ---------------------------------------------------------------------------
// The columns

const riskRank: Readonly<Record<ChangeSetRisk, number>> = { high: 0, medium: 1, low: 2 };

/** The Inbox rows Home shows: the digest's (by risk, then age), kept in that order. */
export function needRows(rows: readonly HomeInboxRow[]): HomeInboxRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => riskRank[a.row.risk] - riskRank[b.row.risk] || a.index - b.index)
    .map(({ row }) => row);
}

export interface ArrivalRow {
  address: string;
  id: string | null;
  title: string;
  notes: number | null;
  createdAt: string;
  /** The topics above it, root first (the tree's untitled root left out). */
  crumbs: string[];
  generating: boolean;
  progress: { done: number; estimate: number | null } | null;
}

/** The topics of an arrival's path as titles, without the tree's own untitled root. */
export function pathTitles(object: ObjectResolved): string[] {
  const path = object.path ?? [];
  return path
    .filter((ref, index) => ref.kind === "topic" && !(index === 0 && ref.title === ""))
    .map((ref) => ref.title)
    .filter((title) => title !== "");
}

export function arrivalRows(data: HomeData): ArrivalRow[] {
  const generating = new Set(data.generating?.ids ?? []);
  return data.digest.new.sources.items.map((arrival: HomeArrival) => {
    const id = parseObjectAddress(arrival.object.address)?.id ?? null;
    return {
      address: arrival.object.address,
      id,
      title: arrival.object.title,
      notes: arrival.object.counts?.notes ?? null,
      createdAt: arrival.createdAt,
      crumbs: pathTitles(arrival.object),
      generating: id !== null && generating.has(id),
      progress: id === null ? null : (data.progress[id] ?? null)
    };
  });
}

/** The crumbs a row shows: at most the last three, with a leading ellipsis when the path is longer. */
export function foldCrumbs(
  crumbs: readonly string[],
  max = 3
): { folded: boolean; shown: string[] } {
  if (crumbs.length <= max) return { folded: false, shown: [...crumbs] };
  return { folded: true, shown: crumbs.slice(crumbs.length - (max - 1)) };
}

export type QuestionScopeView =
  | { kind: "library" }
  | { kind: "topic"; title: string | null }
  | { kind: "sources"; count: number };

/** A question's scope as the row words it; a topic carries its title when it is known. */
export function questionScope(
  scope: AskScope,
  topicTitles: Readonly<Record<string, string>> = {}
): QuestionScopeView {
  if (scope.kind === "sources") return { kind: "sources", count: scope.sourceIds.length };
  if (scope.kind === "topic") {
    const title = topicTitles[scope.topicId];
    return { kind: "topic", title: title === undefined || title === "" ? null : title };
  }
  return { kind: "library" };
}

/** The topics the recent questions were asked in: what the store resolves into titles. */
export function questionTopicIds(questions: readonly HomeQuestion[]): string[] {
  const ids = new Set<string>();
  for (const question of questions)
    if (question.scope.kind === "topic") ids.add(question.scope.topicId);
  return [...ids];
}

export const gardenerRowLimit = 3;

export function gardenerRows(changes: readonly HomeGardenerChange[]): HomeGardenerChange[] {
  return changes.slice(0, gardenerRowLimit);
}

export function questionRows(questions: readonly HomeQuestion[]): HomeQuestion[] {
  return [...questions];
}

// ---------------------------------------------------------------------------
// The grid

export type HomeArea = "need" | "gard" | "arr" | "back";

/**
 * The rows of `grid-template-areas`. Wide (design record §3): `need gard arr` over `need gard back`,
 * the third column holding two sections; compact (960-1179 px): `need arr` over `gard back`. A
 * section that is not shown leaves no gap: the others close up, and a section left alone on its row
 * takes the whole row.
 */
export function columnAreas(visible: readonly HomeArea[], compact: boolean): string[][] {
  const has = (area: HomeArea) => visible.includes(area);
  if (compact) {
    const order = (["need", "arr", "gard", "back"] as const).filter(has);
    const rows: string[][] = [];
    for (let index = 0; index < order.length; index += 2) {
      const first = order[index] as HomeArea;
      const second = order[index + 1];
      rows.push(second ? [first, second] : [first, first]);
    }
    return rows;
  }
  const right = (["arr", "back"] as const).filter(has);
  const columns: HomeArea[][] = [];
  if (has("need")) columns.push(["need"]);
  if (has("gard")) columns.push(["gard"]);
  if (right.length > 0) columns.push(right);
  const height = Math.max(1, ...columns.map((column) => column.length));
  return Array.from({ length: height }, (_, row) =>
    columns.map(
      (column) => (column.length === 1 ? column[0] : (column[row] ?? column[0])) as string
    )
  );
}

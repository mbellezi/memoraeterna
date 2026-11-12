import type { Translator } from "@app/i18n";

import { relationTypeView, type Stance } from "../../../../lib/relation-stance";
import {
  branchEdgeDescription,
  type BranchCursorItem,
  type BranchModel,
  type BranchOutside
} from "./branch-model";

/**
 * The Map › Grafo's table alternative as data (F5 D19, design record 7.5): "Mesmas conexões em
 * tabela" lists the relations the canvas draws, one row each, and stays in step with it. The rows,
 * the page they are shown by, the keyboard, the selection both ways and the lists around the table
 * (the topics outside the branch, the lines between groups, the notices) are decided here with no
 * DOM, so the tests and the components read the same answers.
 */

export interface RelationRow {
  /** The relation's ID: the same one the canvas selects. */
  id: string;
  /** The note a row's first cell names, and the one its third cell names. */
  first: { id: string; title: string };
  second: { id: string; title: string };
  type: string;
  stance: Stance;
  suggested: boolean;
  /** The row's sentence, for the row's accessible name. */
  sentence: string;
}

/** Rows shown before "Mostrar mais": a page of a long branch costs what a page costs. */
export const tablePageSize = 60;
/** Rows a PageUp or PageDown moves by. */
export const tablePageStep = 8;

/**
 * One row per drawn relation, the most connected first (the sum of its two notes' connections), then
 * by the title of its first note, so the order is the same on every read of the same branch.
 */
export function buildRelationRows(model: BranchModel, t: Translator): RelationRow[] {
  const notes = new Map(model.nodes.map((node) => [node.id, node]));
  const titleOf = (id: string) => notes.get(id)?.title ?? "";
  const weight = (id: string) => notes.get(id)?.degree ?? 0;
  const reach = new Map(model.edges.map((edge) => [edge.id, weight(edge.a) + weight(edge.b)]));
  return model.edges
    .map((edge): RelationRow => ({
      id: edge.id,
      first: { id: edge.a, title: titleOf(edge.a) },
      second: { id: edge.b, title: titleOf(edge.b) },
      type: edge.type,
      stance: relationTypeView(edge.type).stance,
      suggested: edge.suggested,
      sentence: branchEdgeDescription(edge, titleOf, t)
    }))
    .sort(
      (left, right) =>
        (reach.get(right.id) ?? 0) - (reach.get(left.id) ?? 0) ||
        left.first.title.localeCompare(right.first.title) ||
        left.id.localeCompare(right.id)
    );
}

/**
 * How many rows to draw: the page asked for, grown to take in the selected row. A relation picked
 * on the canvas that sits past the page is never hidden from the table that mirrors it.
 */
export function visibleRowCount(
  rows: readonly RelationRow[],
  selectedId: string | null,
  limit: number
): number {
  const at = selectedId === null ? -1 : rows.findIndex((row) => row.id === selectedId);
  const needed = at < 0 ? 0 : at + 1;
  return Math.min(rows.length, Math.max(limit, Math.ceil(needed / tablePageSize) * tablePageSize));
}

export interface TableSync {
  /** The row of the relation selected on the canvas; none when a note or nothing is. */
  selectedRowId: string | null;
  /** The rows of the relations of the note selected on the canvas. */
  connectedRowIds: ReadonlySet<string>;
  /** The row to scroll into view: the selected one, else the first of the note's. */
  revealRowId: string | null;
}

const noSync: TableSync = { selectedRowId: null, connectedRowIds: new Set(), revealRowId: null };

/**
 * What the table shows for the canvas's selection: a relation is the selected row; a note marks
 * every row it takes part in (it is not one row, so none is "selected"); nothing marks nothing.
 */
export function tableSync(
  rows: readonly RelationRow[],
  selected: BranchCursorItem | null
): TableSync {
  if (!selected) return noSync;
  if (selected.type === "edge") {
    const row = rows.find((entry) => entry.id === selected.id);
    return row
      ? { selectedRowId: row.id, connectedRowIds: new Set(), revealRowId: row.id }
      : noSync;
  }
  const connected = rows.filter(
    (row) => row.first.id === selected.id || row.second.id === selected.id
  );
  return {
    selectedRowId: null,
    connectedRowIds: new Set(connected.map((row) => row.id)),
    revealRowId: connected[0]?.id ?? null
  };
}

/** What the canvas should select when a row is chosen: the relation, or nothing if it already is. */
export function selectionFromRow(
  rowId: string,
  selected: BranchCursorItem | null
): BranchCursorItem | null {
  return selected?.type === "edge" && selected.id === rowId ? null : { type: "edge", id: rowId };
}

/** The row a key moves to (arrows, Home, End, the page keys), or null for a key that does not move. */
export function moveRow(count: number, current: number | null, key: string): number | null {
  if (count === 0) return null;
  const last = count - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  const step =
    key === "ArrowDown"
      ? 1
      : key === "ArrowUp"
        ? -1
        : key === "PageDown"
          ? tablePageStep
          : key === "PageUp"
            ? -tablePageStep
            : 0;
  if (step === 0) return null;
  if (current === null) return step > 0 ? 0 : last;
  return Math.min(last, Math.max(0, current + step));
}

/** The row that holds the keyboard's tab stop: the selected one, else the first. */
export function tabStopRow(rows: readonly RelationRow[], selectedId: string | null): number {
  if (rows.length === 0) return -1;
  const at = selectedId === null ? -1 : rows.findIndex((row) => row.id === selectedId);
  return at < 0 ? 0 : at;
}

/** One line between two topic groups, as the zoomed-out canvas draws it. */
export interface GroupLink {
  key: string;
  first: string;
  second: string;
  weight: number;
}

/** The group-to-group lines, heaviest first: the table's twin of the canvas's group view. */
export function groupLinks(model: BranchModel): GroupLink[] {
  const titles = new Map(model.groups.map((group) => [group.id, group.legendLabel]));
  return model.superEdges
    .filter((edge) => titles.has(edge.a) && titles.has(edge.b))
    .map((edge) => ({
      key: `${edge.a}|${edge.b}`,
      first: titles.get(edge.a) ?? "",
      second: titles.get(edge.b) ?? "",
      weight: edge.weight
    }))
    .sort(
      (left, right) =>
        right.weight - left.weight ||
        left.first.localeCompare(right.first) ||
        left.second.localeCompare(right.second)
    );
}

/** The topics outside the branch, most connected first (the read already orders them). */
export function outsideTopics(model: BranchModel): BranchOutside[] {
  return [...model.outside].sort(
    (left, right) => right.edgeCount - left.edgeCount || left.title.localeCompare(right.title)
  );
}

export type BranchNotice = "truncated" | "groupLines";

/**
 * What the read left out, in the order the person should be told. `truncated` is the read's own flag
 * (notes or relations past the limits). The read's two lists are capped without setting it, so a
 * list at its cap is a notice of its own: the group lines (heaviest kept) here, and the outside
 * topics in their list, which names its own cap (`outsideCapped`).
 */
export function branchNotices(model: BranchModel): BranchNotice[] {
  const notices: BranchNotice[] = [];
  if (model.truncated) notices.push("truncated");
  if (model.superEdgesCapped) notices.push("groupLines");
  return notices;
}

/** What a scroll box shows of itself: the geometry `revealWithin` reads. */
export interface ScrollBox {
  scrollTop: number;
  clientTop: number;
  clientHeight: number;
  getBoundingClientRect(): { top: number };
}

/**
 * Brings a row into a scroll box by moving that box alone: `scrollIntoView` would also scroll every
 * ancestor, and below 1180 px the page itself, away from the canvas a choice was just made on.
 * `covered` is the height a sticky header hides at the top of the box.
 */
export function revealWithin(
  box: ScrollBox,
  row: { getBoundingClientRect(): { top: number; bottom: number } },
  covered = 0
): void {
  const rect = row.getBoundingClientRect();
  const top = box.getBoundingClientRect().top + box.clientTop;
  const visibleTop = top + covered;
  const visibleBottom = top + box.clientHeight;
  if (rect.top < visibleTop) box.scrollTop -= visibleTop - rect.top;
  else if (rect.bottom > visibleBottom) box.scrollTop += rect.bottom - visibleBottom;
}

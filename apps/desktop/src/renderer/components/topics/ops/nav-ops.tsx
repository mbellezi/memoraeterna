import { FolderInput, FolderPlus, Pencil, Pin, PinOff } from "lucide-react";
import type { Translator } from "@app/i18n";

import type { LeafRow, NavRow, PlaceEntry, PlaceRow, TopicRow } from "../topic-navigation";
import type { MenuAnchor, MenuItem } from "./FloatingMenu";

/**
 * What the navigator's rows need to rename a topic in place and to open a row's actions (docs
 * F2 T26). Absent, the rows are read-only, as they were before.
 */
export interface NavRowOps {
  /** The key of the row being renamed in place. */
  renamingKey: string | null;
  /** The last rename was refused. */
  invalid: boolean;
  busy: boolean;
  /** The topics, notes and sources the view history pins, as `itemIdentity` keys. */
  pinnedItems: ReadonlySet<string>;
  onStartRename: (row: TopicRow) => void;
  onCommitRename: (row: TopicRow, title: string) => void;
  onCancelRename: () => void;
  /** Opens the actions of a row at a point (a click, or the lower left of the row). */
  onOpenMenu: (row: ActionRow, anchor: MenuAnchor) => void;
}

/** Rows that have actions: a topic of the tree, a leaf (a note or a source), and Pinned or Recents. */
export type ActionRow = TopicRow | LeafRow | PlaceRow;

export function actionRowOf(row: NavRow): ActionRow | null {
  return row.type === "topic" || row.type === "leaf" || row.type === "place" ? row : null;
}

/** How the view history tells one object from another. */
export const itemIdentity = (kind: string, id: string): string => `${kind}:${id}`;

/**
 * What the view history pins, from the Pinned list: topics, notes and sources. A topic is also
 * protected only when `topics.management` says so (D28); a topic in this set that is not protected
 * is pinned in the history alone.
 */
export function pinnedItemKeys(pinned: readonly PlaceEntry[]): ReadonlySet<string> {
  return new Set(pinned.map((place) => itemIdentity(place.kind, place.id)));
}

/**
 * Whether the row is pinned: a topic when it is protected (`topics.management`, D28) or the history
 * pins it; a note or a source when the history pins it.
 */
export function isPinnedRow(row: ActionRow, pinnedItems: ReadonlySet<string>): boolean {
  switch (row.type) {
    case "topic":
      return (
        row.node.management === "pinned" || pinnedItems.has(itemIdentity("topic", row.node.id))
      );
    case "place":
      return row.place.pinned || row.place.management === "pinned";
    case "leaf":
      return pinnedItems.has(itemIdentity(row.leaf.kind, row.leaf.id));
  }
}

/**
 * What pinning or unpinning a row does (D28). A topic pin is both effects in one change-set
 * (`topics.mutate`); unpinning a topic that is pinned in the history without being protected has
 * only the history pin to remove, and a note or a source has nothing else to touch.
 */
export type PinPlan =
  | { via: "topic"; topic: { id: string; title: string | null }; pinned: boolean }
  | {
      via: "history";
      kind: "topic" | "note" | "source";
      id: string;
      title: string;
      pinned: boolean;
    };

/** The plan to pin a row that is not pinned and to unpin one that is; `untitled` names what has none. */
export function pinPlanOf(
  row: ActionRow,
  pinnedItems: ReadonlySet<string>,
  untitled: string
): PinPlan {
  const pinned = !isPinnedRow(row, pinnedItems);
  switch (row.type) {
    case "topic": {
      const { node } = row;
      // Protected: both effects. Not protected: pinning protects it, unpinning has only the history.
      if (pinned || node.management === "pinned") {
        return { via: "topic", topic: { id: node.id, title: node.title }, pinned };
      }
      return { via: "history", kind: "topic", id: node.id, title: node.title ?? untitled, pinned };
    }
    case "leaf":
      return {
        via: "history",
        kind: row.leaf.kind,
        id: row.leaf.id,
        title: row.leaf.title === "" ? untitled : row.leaf.title,
        pinned
      };
    case "place": {
      const { place } = row;
      if (place.kind === "topic") {
        // Protected: both effects. Not protected: pinning protects it, unpinning has only the history.
        if (pinned || place.management === "pinned") {
          return { via: "topic", topic: { id: place.id, title: place.title }, pinned };
        }
        return {
          via: "history",
          kind: "topic",
          id: place.id,
          title: place.title ?? untitled,
          pinned
        };
      }
      return {
        via: "history",
        kind: place.kind,
        id: place.id,
        title: place.title ?? untitled,
        pinned
      };
    }
  }
}

export interface MenuActions {
  rename: () => void;
  create: () => void;
  move: () => void;
  togglePin: () => void;
}

/**
 * The actions of a row. A topic of the tree can be renamed, given a subtopic, moved and pinned;
 * every other row (a topic in Pinned or Recents, a note, a source) can be pinned or unpinned, which
 * is what the Pinned list is for.
 */
export function topicMenuItems(
  t: Translator,
  row: ActionRow,
  actions: MenuActions,
  busy: boolean,
  pinnedItems: ReadonlySet<string>
): MenuItem[] {
  const pinned = isPinnedRow(row, pinnedItems);
  const pin: MenuItem = {
    id: "pin",
    label: t(pinned ? "topics.ops.actions.unpin" : "topics.ops.actions.pin"),
    icon: pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />,
    disabled: busy,
    onSelect: actions.togglePin
  };
  if (row.type !== "topic") return [pin];
  return [
    {
      id: "rename",
      label: t("topics.ops.actions.rename"),
      icon: <Pencil aria-hidden="true" />,
      disabled: busy,
      onSelect: actions.rename
    },
    {
      id: "create",
      label: t("topics.ops.actions.create"),
      icon: <FolderPlus aria-hidden="true" />,
      disabled: busy,
      onSelect: actions.create
    },
    {
      id: "move",
      label: t("topics.ops.actions.move"),
      icon: <FolderInput aria-hidden="true" />,
      disabled: busy,
      onSelect: actions.move
    },
    pin
  ];
}

/** The name of a row's button and menu: topic actions for a topic, item actions for the rest. */
export function actionsLabelKey(
  row: ActionRow
): "topics.ops.actions.more" | "topics.ops.actions.itemActions" {
  const topic = row.type === "topic" || (row.type === "place" && row.place.kind === "topic");
  return topic ? "topics.ops.actions.more" : "topics.ops.actions.itemActions";
}

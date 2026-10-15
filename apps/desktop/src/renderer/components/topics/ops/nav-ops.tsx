import { FolderInput, FolderPlus, Pencil, Pin, PinOff } from "lucide-react";
import type { Translator } from "@app/i18n";

import type { NavRow, PlaceRow, TopicRow } from "../topic-navigation";
import type { MenuAnchor, MenuItem } from "./FloatingMenu";

/**
 * What the navigator's rows need to rename a topic in place and to open a topic's actions (docs
 * F2 T26). Absent, the rows are read-only, as they were before.
 */
export interface NavRowOps {
  /** The key of the row being renamed in place. */
  renamingKey: string | null;
  /** The last rename was refused. */
  invalid: boolean;
  busy: boolean;
  onStartRename: (row: TopicRow) => void;
  onCommitRename: (row: TopicRow, title: string) => void;
  onCancelRename: () => void;
  /** Opens the actions of a row at a point (a click, or the lower left of the row). */
  onOpenMenu: (row: TopicRow | PlaceRow, anchor: MenuAnchor) => void;
}

/** Rows that have actions: a topic of the tree, and a topic in Pinned or Recents. */
export function actionRowOf(row: NavRow): TopicRow | PlaceRow | null {
  if (row.type === "topic") return row;
  if (row.type === "place" && row.place.kind === "topic") return row;
  return null;
}

export function isPinnedRow(row: TopicRow | PlaceRow): boolean {
  return row.type === "topic"
    ? row.node.management === "pinned"
    : row.place.management === "pinned" || row.place.pinned;
}

export interface MenuActions {
  rename: () => void;
  create: () => void;
  move: () => void;
  togglePin: () => void;
}

/**
 * The actions of a row. A topic of the tree can be renamed, given a subtopic, moved and pinned; a
 * topic in Pinned or Recents can be pinned or unpinned, which is what that list is for.
 */
export function topicMenuItems(
  t: Translator,
  row: TopicRow | PlaceRow,
  actions: MenuActions,
  busy: boolean
): MenuItem[] {
  const pinned = isPinnedRow(row);
  const pin: MenuItem = {
    id: "pin",
    label: t(pinned ? "topics.ops.actions.unpin" : "topics.ops.actions.pin"),
    icon: pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />,
    disabled: busy,
    onSelect: actions.togglePin
  };
  if (row.type === "place") return [pin];
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

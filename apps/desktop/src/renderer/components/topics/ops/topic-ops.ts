import { topicLimits } from "@app/domain";
import type { TopicNodeSummary } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { viewHistoryBounds } from "../../../../shared/view-history";

/**
 * The vocabulary of the human structure operations (docs F2 T26), without React: how a failure
 * reads, what a title may be, and what a quick-undo notice says. The controller and the views use it.
 */

/** The failures the topic handlers report, as the message each one has (`topics.errors.*`). */
const handlerErrors: Record<string, MessageKey> = {
  "topics.errors.stale": "topics.errors.stale",
  "topics.errors.cycle": "topics.errors.cycle",
  "topics.errors.duplicateTitle": "topics.errors.duplicateTitle",
  "topics.errors.notFound": "topics.errors.notFound",
  "topics.errors.protected": "topics.errors.protected",
  "topics.errors.depthCap": "topics.errors.depthCap",
  "topics.errors.invalid": "topics.errors.invalid",
  "topics.errors.unavailable": "topics.errors.unavailable",
  "errors.viewHistory.pinLimit": "viewHistory.pinLimit"
};

/** The key an error carries across the process boundary (Electron wraps the message), or null. */
export function errorKeyOf(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error);
  return /(?:topics\.errors|errors\.viewHistory)\.[A-Za-z]+/u.exec(text)?.[0] ?? null;
}

/** What a failed operation tells the person; an unknown failure is a plain "try again". */
export function failureMessage(error: unknown): MessageKey {
  const key = errorKeyOf(error);
  return (key && handlerErrors[key]) || "topics.ops.errors.failed";
}

/** A refusal as the person reads it; the limits it names are the real ones. */
export function opsErrorText(t: Translator, key: MessageKey): string {
  const count =
    key === "viewHistory.pinLimit" ? viewHistoryBounds.pinMax : topicLimits.titleMaxLength;
  return t(key, { values: { count } });
}

/** A change that left the tree as it was (the same name again) is not a failure. */
export function isUnchanged(error: unknown): boolean {
  return errorKeyOf(error) === "topics.errors.unchanged";
}

export type TitleCheck = { ok: true; title: string } | { ok: false; reason: "empty" | "tooLong" };

/** A name is one trimmed line of 1 to 120 characters (the database check counts characters). */
export function checkTitle(raw: string): TitleCheck {
  const title = raw.replace(/\s+/gu, " ").trim();
  if (title.length === 0) return { ok: false, reason: "empty" };
  if (Array.from(title).length > topicLimits.titleMaxLength)
    return { ok: false, reason: "tooLong" };
  return { ok: true, title };
}

export const titleCheckMessage: Record<"empty" | "tooLong", MessageKey> = {
  empty: "topics.ops.rename.empty",
  tooLong: "topics.ops.rename.tooLong"
};

/** A topic as an operation names it: its ID, its name (null when it has none) and its stamp. */
export type OpsTopic = Pick<TopicNodeSummary, "id" | "title" | "updatedAt"> &
  Partial<Pick<TopicNodeSummary, "management" | "parentId">>;

/** What a quick-undo notice says: a message and the names it mentions (null: not named yet). */
export interface OpsNotice {
  key: MessageKey;
  title: string | null;
  parent: string | null;
}

/** How long a notice with an Undo stays: long enough to read and to reach it by keyboard. */
export const noticeVisibleMs = 12_000;

/** The notice that follows a pinned or unpinned topic: the verb is the action's. */
export function pinNotice(pinned: boolean, title: string | null): OpsNotice {
  return {
    key: pinned ? "topics.ops.toast.pinned" : "topics.ops.toast.unpinned",
    title,
    parent: null
  };
}

/**
 * The notice that follows a pin that only the view history holds (a note or a source, or a topic
 * that is pinned there without being protected): it says nothing of protection, which only
 * `topics.management` gives (D28).
 */
export function itemPinNotice(pinned: boolean, title: string | null): OpsNotice {
  return {
    key: pinned ? "topics.ops.toast.itemPinned" : "topics.ops.toast.itemUnpinned",
    title,
    parent: null
  };
}

/** Filters names the way a person types them: without case or accents. */
export function foldName(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

export function matchesFilter(title: string | null, filter: string): boolean {
  const wanted = foldName(filter.trim());
  return wanted.length === 0 || (title !== null && foldName(title).includes(wanted));
}

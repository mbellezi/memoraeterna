import { formatObjectAddress, objectKinds, type ObjectKind } from "@app/domain";
import type { QueryResultRow } from "pg";

import { mapTimestamp } from "./sql.js";
import type { Queryable } from "./types.js";

/** The object kinds that have a stable `memora://<kind>/<uuid>` address: the domain's list. */
export const viewHistoryKinds = objectKinds;
export type ViewHistoryKind = ObjectKind;

/** Retention and read bounds of the local view history. */
export const viewHistoryLimits = {
  /** Unpinned entries kept; the oldest are dropped on each recorded open. Pins are always kept. */
  unpinnedEntries: 500,
  /** Pins kept at most; a further pin is refused until one is unpinned, so every pin is listed. */
  pinnedEntries: 10,
  titleCharacters: 300,
  /** Recent (unpinned) entries a read returns by default and at most; pins come on top of them. */
  listDefault: 10,
  listMax: 50
} as const;

/** The error message a refused pin carries across the process boundary. */
export const viewHistoryPinLimitMessage = "errors.viewHistory.pinLimit";

export interface ViewHistoryEntry {
  address: string;
  kind: ViewHistoryKind;
  objectId: string;
  /** The title when the object was last opened. */
  title: string;
  /** The object that hosted the open (a note opened inside its source), when known. */
  parentAddress: string | null;
  openedAt: Date;
  openCount: number;
  pinned: boolean;
}

export interface RecordViewInput {
  kind: ViewHistoryKind;
  objectId: string;
  title: string;
  parentAddress?: string | null | undefined;
}

export interface ListViewHistoryInput {
  /** How many recent (unpinned) entries to return; every pinned entry is returned besides them. */
  limit?: number | undefined;
  kinds?: readonly ViewHistoryKind[] | undefined;
}

/** The objects whose deletion removes their history: a deleted source, note or entity. */
export interface ForgottenObjects {
  sourceIds?: readonly string[];
  noteIds?: readonly string[];
  entityIds?: readonly string[];
}

interface ViewHistoryRow extends QueryResultRow {
  address: string;
  kind: ViewHistoryKind;
  objectId: string;
  title: string;
  parentAddress: string | null;
  openedAt: Date | string;
  openCount: number;
  pinned: boolean;
}

const columns = `h.address, h.kind, h.object_id as "objectId", h.title,
  h.parent_address as "parentAddress", h.opened_at as "openedAt",
  h.open_count as "openCount", h.pinned`;

/** The stable address of an object; the table enforces that it matches the kind and ID. */
export function viewHistoryAddress(kind: ViewHistoryKind, objectId: string): string {
  return formatObjectAddress({ kind, id: objectId });
}

/** One line, trimmed and cut to the stored bound (by characters, never in the middle of one). */
export function normalizeViewHistoryTitle(title: string): string {
  const oneLine = title.replace(/\s+/gu, " ").trim();
  if (!oneLine) throw new Error("A view history entry needs a title.");
  return Array.from(oneLine).slice(0, viewHistoryLimits.titleCharacters).join("");
}

function toEntry(row: ViewHistoryRow): ViewHistoryEntry {
  return {
    address: row.address,
    kind: row.kind,
    objectId: row.objectId,
    title: row.title,
    parentAddress: row.parentAddress,
    openedAt: mapTimestamp(row.openedAt),
    openCount: row.openCount,
    pinned: row.pinned
  };
}

/**
 * Objects that no longer exist are left out of a read, whatever their kind has a table for. Topics
 * and questions have no table yet; their entries are never hidden.
 */
const existingObjects = (alias: string) => `
  (${alias}.kind <> 'source' or exists (select 1 from source_items s where s.id = ${alias}.object_id))
  and (${alias}.kind <> 'note' or exists (select 1 from atomic_notes n where n.id = ${alias}.object_id))
  and (${alias}.kind <> 'entity' or exists (select 1 from entities e where e.id = ${alias}.object_id))`;

/**
 * The local view history: recents and pins, kept only on this machine. It is convenience state, not
 * telemetry, and it is cleared by a library reset like every other table.
 */
export function createViewHistoryRepository(db: Queryable) {
  return {
    /** Records one open: the title is refreshed, the count grows and the entry becomes the latest. */
    async record(input: RecordViewInput): Promise<ViewHistoryEntry> {
      const address = viewHistoryAddress(input.kind, input.objectId);
      const result = await db.query<ViewHistoryRow>(
        `insert into view_history as h (kind, object_id, address, title, parent_address)
         values ($1, $2::uuid, $3, $4, $5)
         on conflict (address) do update set
           title = excluded.title,
           parent_address = coalesce(excluded.parent_address, h.parent_address),
           opened_at = now(),
           open_count = h.open_count + 1
         returning ${columns}`,
        [
          input.kind,
          input.objectId,
          address,
          normalizeViewHistoryTitle(input.title),
          input.parentAddress ?? null
        ]
      );
      await db.query(
        `delete from view_history
         where pinned = false and id in (
           select id from view_history where pinned = false
           order by opened_at desc, id offset $1)`,
        [viewHistoryLimits.unpinnedEntries]
      );
      return toEntry(result.rows[0]!);
    },

    /**
     * Pinned entries first, then the most recently opened. Pins and recents have slots of their own:
     * `limit` recents are returned besides every pin (at most `pinnedEntries`), so many pins can
     * never push the recents off the list.
     */
    async list(input: ListViewHistoryInput = {}): Promise<ViewHistoryEntry[]> {
      const limit = Math.min(
        Math.max(1, Math.trunc(input.limit ?? viewHistoryLimits.listDefault)),
        viewHistoryLimits.listMax
      );
      const result = await db.query<ViewHistoryRow>(
        `select ${columns} from (
           select h.*, row_number() over (partition by h.pinned order by h.opened_at desc, h.id) as slot
           from view_history h
           where ($1::text[] is null or h.kind = any($1::text[])) and ${existingObjects("h")}
         ) h
         where (h.pinned and h.slot <= $3) or (not h.pinned and h.slot <= $2)
         order by h.pinned desc, h.opened_at desc, h.id`,
        [input.kinds?.length ? [...input.kinds] : null, limit, viewHistoryLimits.pinnedEntries]
      );
      return result.rows.map(toEntry);
    },

    /**
     * Pins or unpins a recorded entry; `null` when the address was never opened. A new pin is refused
     * (the error carries `viewHistoryPinLimitMessage`) once `pinnedEntries` entries are pinned.
     */
    async setPinned(address: string, pinned: boolean): Promise<ViewHistoryEntry | null> {
      const result = await db.query<ViewHistoryRow>(
        `update view_history as h set pinned = $2::boolean,
           pinned_at = case when $2::boolean then coalesce(h.pinned_at, now()) end
         where h.address = $1
           and (not $2::boolean or h.pinned
             or (select count(*) from view_history p
                 where p.pinned and ${existingObjects("p")}) < $3)
         returning ${columns}`,
        [address, pinned, viewHistoryLimits.pinnedEntries]
      );
      if (result.rows[0]) return toEntry(result.rows[0]);
      if (pinned) {
        const known = await db.query("select 1 from view_history where address = $1", [address]);
        if (known.rowCount) throw new Error(viewHistoryPinLimitMessage);
      }
      return null;
    },

    /**
     * Forgets the entries of objects that were deleted, pinned or not: the title snapshot of a
     * deleted source must not outlive it. Entries hosted by a deleted source go with it, since they
     * could only be opened through it. Resolves with the number of entries removed.
     */
    async forgetObjects(objects: ForgottenObjects): Promise<number> {
      const sourceIds = [...(objects.sourceIds ?? [])];
      const noteIds = [...(objects.noteIds ?? [])];
      const entityIds = [...(objects.entityIds ?? [])];
      if (sourceIds.length + noteIds.length + entityIds.length === 0) return 0;
      const result = await db.query(
        `delete from view_history
         where (kind = 'source' and object_id = any($1::uuid[]))
            or (kind = 'note' and object_id = any($2::uuid[]))
            or (kind = 'entity' and object_id = any($3::uuid[]))
            or parent_address = any($4::text[])`,
        [sourceIds, noteIds, entityIds, sourceIds.map((id) => viewHistoryAddress("source", id))]
      );
      return result.rowCount ?? 0;
    },

    /**
     * Forgets every unpinned entry and every entry whose object no longer exists, pinned or not
     * (a backstop for deletions that bypass `forgetObjects`); other pins stay. Resolves with the
     * number of entries removed.
     */
    async clear(): Promise<number> {
      const result = await db.query(
        `delete from view_history h where h.pinned = false or not (${existingObjects("h")})`
      );
      return result.rowCount ?? 0;
    }
  };
}

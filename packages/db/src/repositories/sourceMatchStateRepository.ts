import type { QueryResultRow } from "pg";

import { mapTimestamp } from "./sql.js";
import type { Queryable } from "./types.js";

/**
 * Per-root source matching state (F3 D27). `matchSeq` is the arrival order (taken when a root is
 * first matched, kept when it is matched again); discovery compares a new root with the roots
 * matched before it in the same embedding space, and a reverse neighbour replaces an earlier root's
 * nearest when it is closer.
 */
export interface SourceMatchState {
  rootId: string;
  matchSeq: number;
  nearestRootId: string | null;
  nearestCosine: number | null;
  spaceKey: string;
  fingerprint: string;
  matchedAt: Date;
}

interface StateRow extends QueryResultRow {
  rootId: string;
  matchSeq: string | number;
  nearestRootId: string | null;
  nearestCosine: number | null;
  spaceKey: string;
  fingerprint: string;
  matchedAt: unknown;
}

const columns = `root_id as "rootId", match_seq as "matchSeq", nearest_root_id as "nearestRootId",
  nearest_cosine as "nearestCosine", space_key as "spaceKey", fingerprint, matched_at as "matchedAt"`;

const mapState = (row: StateRow): SourceMatchState => ({
  ...row,
  matchSeq: Number(row.matchSeq),
  nearestCosine: row.nearestCosine === null ? null : Number(row.nearestCosine),
  matchedAt: mapTimestamp(row.matchedAt)
});

function checkCosine(cosine: number | null) {
  if (cosine !== null && !(cosine >= -1 && cosine <= 1))
    throw new Error("A nearest cosine lies between -1 and 1.");
}

export function createSourceMatchStateRepository(db: Queryable) {
  return {
    /** Records a matched root; a root matched again keeps its arrival order. */
    async record(
      input: Omit<SourceMatchState, "matchSeq" | "matchedAt">
    ): Promise<SourceMatchState> {
      checkCosine(input.nearestCosine);
      const row = (
        await db.query<StateRow>(
          `insert into source_match_state (root_id, nearest_root_id, nearest_cosine, space_key,
             fingerprint, matched_at)
           values ($1::uuid, $2::uuid, $3, $4, $5, clock_timestamp())
           on conflict (root_id) do update set nearest_root_id = excluded.nearest_root_id,
             nearest_cosine = excluded.nearest_cosine, space_key = excluded.space_key,
             fingerprint = excluded.fingerprint, matched_at = excluded.matched_at
           returning ${columns}`,
          [
            input.rootId,
            input.nearestRootId,
            input.nearestCosine,
            input.spaceKey,
            input.fingerprint
          ]
        )
      ).rows[0];
      if (!row) throw new Error("Source match state insert returned no row.");
      return mapState(row);
    },

    /**
     * Makes `nearestRootId` the nearest root of `rootId` when it is closer than the stored one (a
     * reverse neighbour of D27). Resolves to whether the state changed.
     */
    async offerNearest(rootId: string, nearestRootId: string, cosine: number): Promise<boolean> {
      checkCosine(cosine);
      const result = await db.query(
        `update source_match_state set nearest_root_id = $2::uuid, nearest_cosine = $3
          where root_id = $1::uuid and root_id <> $2::uuid
            and (nearest_cosine is null or nearest_cosine < $3)`,
        [rootId, nearestRootId, cosine]
      );
      return (result.rowCount ?? 0) > 0;
    },

    /** The state of one root, or null before it is first matched. */
    async read(rootId: string): Promise<SourceMatchState | null> {
      const row = (
        await db.query<StateRow>(
          `select ${columns} from source_match_state where root_id = $1::uuid`,
          [rootId]
        )
      ).rows[0];
      return row ? mapState(row) : null;
    },

    /** Roots matched before `beforeSeq` in one embedding space, in arrival order. */
    async listEarlier(spaceKey: string, beforeSeq: number): Promise<SourceMatchState[]> {
      const result = await db.query<StateRow>(
        `select ${columns} from source_match_state where space_key = $1 and match_seq < $2
          order by match_seq`,
        [spaceKey, beforeSeq]
      );
      return result.rows.map(mapState);
    }
  };
}

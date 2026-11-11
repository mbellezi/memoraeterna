import type { QuestionCitationKind } from "@app/domain";

/**
 * The hash of what a citation rests on, one SQL expression per kind (F5 D14). It is the only
 * implementation: the answer's citations store it when the answer is saved and the read computes it
 * again to find an answer gone stale, so the two can never disagree on what "changed" means.
 *
 * Every expression is over the alias `t` of the target's table (a topic also reads its overview as
 * `o`) and is never null for an existing target; a target that no longer exists matches no row, so
 * its current hash is null, which reads as "unavailable".
 *
 *  - note: title, idea statement and body (`atomic_notes` has no hash column);
 *  - chunk: the passage's own `content_hash`;
 *  - source: its content hash and a hash of its summary;
 *  - topic: the version of its overview (v0 before one is written).
 */
export const questionCitationHashSql = {
  note: {
    from: "atomic_notes t",
    hash: `encode(sha256(convert_to(t.title || E'\\x1f' || t.idea_statement || E'\\x1f' || t.body_markdown, 'UTF8')), 'hex')`
  },
  chunk: {
    from: "chunks t",
    hash: "t.content_hash"
  },
  source: {
    from: "source_items t",
    hash: `coalesce(t.content_hash, '') || ':' || encode(sha256(convert_to(coalesce(t.summary, ''), 'UTF8')), 'hex')`
  },
  topic: {
    from: "topics t left join topic_overviews o on o.topic_id = t.id",
    hash: `'v' || coalesce(o.version, 0)`
  }
} as const satisfies Record<QuestionCitationKind, { from: string; hash: string }>;

/**
 * A scalar subquery: the current hash of the `kind` target whose ID is `idExpression`, or null when
 * the target is gone. The expression must be SQL over the caller's own columns (never user input).
 */
export function questionCitationCurrentHashSql(
  kind: QuestionCitationKind,
  idExpression: string
): string {
  const target = questionCitationHashSql[kind];
  return `(select ${target.hash} from ${target.from} where t.id = ${idExpression})`;
}

/**
 * The candidate queries note matching ran before migration 0058 (`atomicNoteRepository.ts` at
 * `7d357c5`), kept only to measure the indexed ones against them: their latency, and how much of
 * their top 20 the new queries return. Both cross-join the note with every other note and compute
 * `unaccent()` and `similarity()` per row, so no index can serve them. Not used by the product.
 */

export interface LegacyStatement {
  text: string;
  values: unknown[];
}

export function legacyTextStatement(noteId: string, limit: number): LegacyStatement {
  return {
    text: `select candidate.id,
                  least(1, greatest(
                    similarity(unaccent(candidate.idea_statement), unaccent(source.idea_statement)),
                    similarity(unaccent(candidate.title), unaccent(source.title)),
                    ts_rank_cd(
                      to_tsvector('simple', unaccent(candidate.title || ' ' || candidate.idea_statement || ' ' || candidate.body_markdown)),
                      plainto_tsquery('simple', unaccent(source.idea_statement))
                    )
                  )) as "textScore"
           from atomic_notes source
           join atomic_notes candidate on candidate.id <> source.id and candidate.status <> 'rejected'
           where source.id = $1
           order by "textScore" desc, candidate.title, candidate.idea_statement, candidate.id
           limit $2`,
    values: [noteId, limit]
  };
}

export interface LegacyVectorInput {
  noteId: string;
  embedding: string;
  dimensions: number;
  model: string;
  spaceKey: string;
  provider: string;
  runtime: string;
  limit: number;
}

export function legacyVectorStatement(input: LegacyVectorInput): LegacyStatement {
  return {
    text: `select candidate.id,
                  coalesce(greatest(0, 1 - (e.embedding <=> $2::vector)), 0) as "vectorScore"
           from atomic_notes source
           join atomic_notes candidate on candidate.id <> source.id and candidate.status <> 'rejected'
           join embeddings_${input.dimensions} e
             on e.target_type = 'atomic_note' and e.target_id = candidate.id
            and ($3::text is null or e.model = $3) and e.strategy='native-v2:' || $5::text and e.provider=$6 and e.runtime=$7
           where source.id = $1
           order by "vectorScore" desc, candidate.title, candidate.idea_statement, candidate.id
           limit $4`,
    values: [
      input.noteId,
      input.embedding,
      input.model,
      input.limit,
      input.spaceKey,
      input.provider,
      input.runtime
    ]
  };
}

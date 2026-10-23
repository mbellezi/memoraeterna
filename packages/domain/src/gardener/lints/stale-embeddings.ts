// Stale embeddings (F4 D19 (3)): a current note whose vector in the tree's embedding space is
// missing, or was built from other text than the note holds now, is queued for one re-embedding.
// Only the text of the note decides (the hash of its embedding text against the hash stored with
// the vector); a prompt revision or a model change never re-embeds a library (D9), and a space
// change is the topic build's own work (D26). Pure: the caller reads the notes and hashes their
// embedding text.
import type { AuditLintConfig } from "./config.js";
import { compareIds } from "./finding.js";

export interface EmbeddingFact {
  noteId: string;
  /** The hash of the embedding text of the note as it is now. */
  expectedHash: string;
  /** The content hash stored with the note's vector in the tree's space; null when it has none. */
  storedHash: string | null;
}

export type StaleEmbeddingReason = "missing" | "content";

export interface StaleEmbedding {
  noteId: string;
  reason: StaleEmbeddingReason;
}

export interface StaleEmbeddingResult {
  /** The notes to re-embed, at most `staleEmbeddings.perRun`, by note ID. */
  stale: StaleEmbedding[];
  /** Notes found stale beyond the cap: the next audit takes them. */
  deferred: number;
  missing: number;
  content: number;
}

export function staleEmbeddings(
  facts: readonly EmbeddingFact[],
  config: Pick<AuditLintConfig, "staleEmbeddings">
): StaleEmbeddingResult {
  const found: StaleEmbedding[] = [];
  for (const fact of facts) {
    if (fact.storedHash === null) found.push({ noteId: fact.noteId, reason: "missing" });
    else if (fact.storedHash !== fact.expectedHash)
      found.push({ noteId: fact.noteId, reason: "content" });
  }
  found.sort((a, b) => compareIds(a.noteId, b.noteId));
  const cap = config.staleEmbeddings.perRun;
  return {
    stale: found.slice(0, cap),
    deferred: Math.max(0, found.length - cap),
    missing: found.filter((entry) => entry.reason === "missing").length,
    content: found.filter((entry) => entry.reason === "content").length
  };
}

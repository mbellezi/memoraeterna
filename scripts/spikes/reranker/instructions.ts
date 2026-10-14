/**
 * Candidate Qwen3-Reranker instructions for the note-relation task (English, as the model card
 * recommends). `default` is the model card's retrieval instruction, kept as an untuned control.
 * Candidates are compared on the tuning split only (`select-instruction.ts`).
 */
import { qwen3RerankerDefaultInstruction } from "../lib/qwen3-reranker.js";

export const instructionCandidates: Record<string, string> = {
  default: qwen3RerankerDefaultInstruction,
  relation:
    "Judge whether the Document states an idea with a substantive conceptual relationship to " +
    "the Query note: it supports, contradicts, extends, depends on, exemplifies or clarifies " +
    "it. Sharing a topic alone is not enough.",
  mechanism:
    "Given a note (Query), decide whether the Document note makes a claim about the same " +
    "underlying mechanism, rule or phenomenon, so that a careful reader would link the two " +
    "notes. Shared names, titles, vocabulary, catalogs or credits do not count.",
  study:
    "Judge whether the Document is useful to someone studying the Query note: it explains, " +
    "qualifies, supports, contradicts or applies the same specific idea. Answer no when it only " +
    "shares a keyword, a subject area or proper names."
};

export const relationInstructionIds = ["relation", "mechanism", "study"] as const;

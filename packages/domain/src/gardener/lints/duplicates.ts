// Duplicate notes (F4 D19 (1), plan 4.4 "duplicate notes on write become Inbox suggestions"): two
// current notes are duplicates when one is among the other's nearest neighbours at a cosine of
// `duplicates.cosine` or above, or when they share a normalized title. The lint only suggests: no
// note is merged, hidden or changed, and a dismissed pair stays dismissed (the finding is unique
// per pair). Pure: the evidence (neighbours and title groups) comes from the database.
import type { AuditLintConfig } from "./config.js";
import { compareIds, findingAddress, orderedPair } from "./finding.js";
import type { LintFinding } from "./finding.js";

/** One neighbour of a note in the tree's embedding space. */
export interface NeighbourEvidence {
  noteId: string;
  otherId: string;
  /** Cosine of the two note vectors (1 - cosine distance). */
  cosine: number;
}

/** Notes that share one normalized title, in any order. */
export type TitleGroup = readonly string[];

export interface DuplicateInput {
  neighbours: readonly NeighbourEvidence[];
  titleGroups: readonly TitleGroup[];
}

export type DuplicateReason = "vector" | "title" | "both";

export interface DuplicatePair {
  /** The two note IDs in canonical order. */
  notes: readonly [string, string];
  /** The best cosine seen for the pair, or null when only the titles are equal. */
  cosine: number | null;
  reason: DuplicateReason;
}

export interface DuplicateResult {
  pairs: DuplicatePair[];
  findings: LintFinding[];
  /** Title groups left out because more notes share the title than `duplicates.titleGroupMax`. */
  genericTitleGroups: number;
}

/** The fingerprint of the pair: stable while both notes exist, whatever side found it. */
export function duplicateFingerprint(a: string, b: string): string {
  const [left, right] = orderedPair(a, b);
  return `dup:${left}:${right}`;
}

/** Whether evidence about a pair still makes it a duplicate pair (the revalidation of a finding). */
export function pairHolds(
  evidence: { cosine: number | null; sameTitle: boolean },
  config: Pick<AuditLintConfig, "duplicates">
): boolean {
  return (
    evidence.sameTitle || (evidence.cosine !== null && evidence.cosine >= config.duplicates.cosine)
  );
}

/**
 * The duplicate pairs of the evidence, sorted by pair, and their findings. A note's neighbours
 * beyond the nearest `duplicates.neighbours` are ignored (the vector arm looks at the nearest
 * only), a pair seen from both sides is one pair and a title group counts only while it is small.
 */
export function duplicateFindings(
  input: DuplicateInput,
  config: Pick<AuditLintConfig, "duplicates">
): DuplicateResult {
  const { cosine: threshold, neighbours: nearest, titleGroupMax } = config.duplicates;
  const pairs = new Map<
    string,
    { notes: [string, string]; cosine: number | null; vector: boolean; title: boolean }
  >();
  const entry = (a: string, b: string) => {
    const notes = orderedPair(a, b);
    const key = `${notes[0]}:${notes[1]}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { notes, cosine: null, vector: false, title: false };
      pairs.set(key, pair);
    }
    return pair;
  };

  const byNote = new Map<string, NeighbourEvidence[]>();
  for (const evidence of input.neighbours) {
    if (evidence.noteId.toLowerCase() === evidence.otherId.toLowerCase()) continue;
    const list = byNote.get(evidence.noteId.toLowerCase()) ?? [];
    list.push(evidence);
    byNote.set(evidence.noteId.toLowerCase(), list);
  }
  for (const list of byNote.values()) {
    list.sort((a, b) => b.cosine - a.cosine || compareIds(a.otherId, b.otherId));
    for (const evidence of list.slice(0, nearest)) {
      const pair = entry(evidence.noteId, evidence.otherId);
      pair.cosine = pair.cosine === null ? evidence.cosine : Math.max(pair.cosine, evidence.cosine);
      if (evidence.cosine >= threshold) pair.vector = true;
    }
  }

  let genericTitleGroups = 0;
  for (const group of input.titleGroups) {
    const notes = [...new Set(group.map((id) => id.toLowerCase()))].sort();
    if (notes.length < 2) continue;
    if (notes.length > titleGroupMax) {
      genericTitleGroups += 1;
      continue;
    }
    for (let i = 0; i < notes.length; i += 1) {
      for (let j = i + 1; j < notes.length; j += 1) {
        entry(notes[i] as string, notes[j] as string).title = true;
      }
    }
  }

  const found: DuplicatePair[] = [];
  const findings: LintFinding[] = [];
  const ordered = [...pairs.values()].sort(
    (a, b) => compareIds(a.notes[0], b.notes[0]) || compareIds(a.notes[1], b.notes[1])
  );
  for (const pair of ordered) {
    if (!pair.vector && !pair.title) continue;
    const reason: DuplicateReason =
      pair.vector && pair.title ? "both" : pair.vector ? "vector" : "title";
    found.push({ notes: pair.notes, cosine: pair.cosine, reason });
    findings.push({
      kind: "duplicate",
      fingerprint: duplicateFingerprint(pair.notes[0], pair.notes[1]),
      objectRefs: pair.notes.map((id) => findingAddress("note", id)),
      params: { reason, cosine: pair.cosine === null ? null : Math.round(pair.cosine * 1e4) / 1e4 },
      risk: "low"
    });
  }
  return { pairs: found, findings, genericTitleGroups };
}

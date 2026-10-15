import type { TopicsBlockedReason, TopicsStatus } from "@app/domain";

/**
 * What the navigator's status line says about the engine (`topics.status`). Nothing here blocks the
 * reading surface: the lines are quiet, informative, and gone when the tree is simply working.
 */
export type StatusLine =
  | { kind: "building"; placed: number; items: number }
  | { kind: "blocked"; reason: TopicsBlockedReason; reembedNotes: number | null }
  | { kind: "dailyCap" };

/** The lines to show, most important first: the first build, why the engine waits, the daily cap. */
export function statusLines(status: TopicsStatus | null): StatusLine[] {
  if (!status) return [];
  const lines: StatusLine[] = [];
  if (status.phase === "building") {
    lines.push({ kind: "building", placed: status.counts.placed, items: status.counts.items });
  }
  if (status.blocked) {
    lines.push({
      kind: "blocked",
      reason: status.blocked,
      reembedNotes: status.reembedNotes ?? null
    });
  }
  if (status.dailyCapReached) lines.push({ kind: "dailyCap" });
  return lines;
}

/**
 * The "Re-embed library" action (docs D26, Q8) is offered when the embedding model changed and the
 * engine reports how many notes a re-embedding would cover; that is the case where the owner has to
 * ask for it. Local routes re-embed on their own and report no count.
 */
export function reembedOffer(lines: readonly StatusLine[]): number | null {
  for (const line of lines) {
    if (
      line.kind === "blocked" &&
      line.reason === "space_changed" &&
      (line.reembedNotes ?? 0) > 0
    ) {
      return line.reembedNotes;
    }
  }
  return null;
}

/** The re-embedding request the owner makes from the status line. */
export type ReembedState = "idle" | "confirming" | "working" | "queued" | "failed";

import type { TopicTree } from "@app/domain";

import type { RelationsBranchResult } from "../../../../../shared/ipc-relations-branch";
import type { BranchScope } from "./branch-model";

/** One answer of `relations.branch`, with what the model is built from beside it. */
export interface BranchRead {
  target: BranchScope;
  depth: 1 | 2 | 3;
  answer: RelationsBranchResult;
  sourceTitle: string | null;
}

/**
 * Whether a live re-read brought back what is already on screen. The lens then keeps the read it
 * has, so the model, the canvas, its camera and its keyboard cursor stay as they are.
 */
export function sameBranchRead(left: BranchRead, right: BranchRead): boolean {
  return (
    left.target.kind === right.target.kind &&
    left.target.id === right.target.id &&
    left.depth === right.depth &&
    left.sourceTitle === right.sourceTitle &&
    JSON.stringify(left.answer) === JSON.stringify(right.answer)
  );
}

export interface RereadTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const windowTimers: RereadTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/**
 * When a pushed change reads the branch again: once a burst of changes has settled for `delayMs`.
 * A change pushed before the first answer arrived is kept and read once that answer lands, so a
 * commit that raced the first read is never lost.
 */
export class LiveRereads {
  private handle: unknown = null;
  private answered = false;
  private pending = false;

  constructor(
    private readonly reread: () => void,
    private readonly delayMs: number,
    private readonly timers: RereadTimers = windowTimers
  ) {}

  /** A change to the notes, the relations or the tree was pushed. */
  push(): void {
    if (!this.answered) {
      this.pending = true;
      return;
    }
    if (this.handle !== null) return;
    this.handle = this.timers.set(() => {
      this.handle = null;
      this.reread();
    }, this.delayMs);
  }

  /** A read answered: a change kept while it was in flight is read now. */
  answer(): void {
    this.answered = true;
    if (!this.pending) return;
    this.pending = false;
    this.push();
  }

  dispose(): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
  }
}

/** A branch the picker offers. */
export interface BranchChoice {
  id: string;
  title: string;
}

export interface BranchChoices {
  above: BranchChoice | null;
  beside: BranchChoice[];
  areas: BranchChoice[];
}

type TreeLevel = Pick<TopicTree, "parent" | "nodes"> | null;

/**
 * The branch menu's neighbours: the parent (above), the siblings (beside) and the tree's areas.
 * The root's children are the areas, so a top-level branch lists them once, under the areas.
 */
export function branchChoices(
  siblings: TreeLevel,
  areas: TreeLevel,
  scopeId: string | null,
  parentId: string | null,
  name: (node: { id: string; title: string | null }) => BranchChoice
): BranchChoices {
  const parent = siblings?.parent ?? null;
  const underRoot = parent === null || parent.parentId === null;
  return {
    above: parent && !underRoot ? name(parent) : null,
    beside: underRoot
      ? []
      : (siblings?.nodes ?? []).filter((node) => node.id !== scopeId).map(name),
    areas: (areas?.nodes ?? [])
      .filter((node) => node.id !== scopeId && node.id !== parentId)
      .map(name)
  };
}

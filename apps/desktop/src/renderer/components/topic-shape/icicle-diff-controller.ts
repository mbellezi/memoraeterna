import type { ChangeSetRef, ChangesDiff, TopicDiffNode } from "@app/domain";

import { isTopicDiff } from "./icicle-diff-model";

export type IcicleDiffLoad =
  /** Nothing to draw: the host has no change-set in view. */
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  /** The change-set is gone (pruned, or never there). */
  | { status: "missing" }
  /** A relation pass or an overview write: there is no topic structure to draw. */
  | { status: "unsupported" }
  | { status: "ready"; nodes: readonly TopicDiffNode[]; hidden: number };

export interface IcicleDiffSnapshot {
  load: IcicleDiffLoad;
  /** The topic selected in either icicle or in the table; the view ignores it when the read lost it. */
  selectedId: string | null;
}

/** Reads the bounded diff of one change-set (the `changes.diff` IPC); null when it is gone. */
export type IcicleDiffLoader = (ref: ChangeSetRef) => Promise<ChangesDiff | null>;

export interface IcicleDiffControllerDeps {
  load: IcicleDiffLoader;
}

const initialSnapshot = (): IcicleDiffSnapshot => ({ load: { status: "idle" }, selectedId: null });

const sameRef = (a: ChangeSetRef | null, b: ChangeSetRef | null): boolean =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id);

/** A refresh that found the same diff changes nothing. */
function sameContent(a: IcicleDiffLoad, nodes: readonly TopicDiffNode[], hidden: number): boolean {
  return (
    a.status === "ready" && a.hidden === hidden && JSON.stringify(a.nodes) === JSON.stringify(nodes)
  );
}

/**
 * The state of one icicle diff, outside React so every rule is tested without a renderer.
 *
 * Pointing it at a change-set reads the bounded diff once; pointing it at another one drops the
 * selection and the answer still on its way. Only topic change-sets are drawn: a relation pass or
 * an overview write reads as `unsupported` without a call. A failed read stays visible and
 * retryable; a refresh in place keeps the diff on screen until the new one arrives and changes
 * nothing when it finds the same content. It never polls and listens to nothing: the host decides
 * when to read again (`refresh`), and mounts it only while its view is shown.
 */
export class IcicleDiffController {
  private snapshot = initialSnapshot();
  private readonly listeners = new Set<() => void>();
  private target: ChangeSetRef | null = null;
  /** The newest read; an older answer arriving later is dropped. */
  private token = 0;

  private load: IcicleDiffLoader;

  constructor(deps: IcicleDiffControllerDeps) {
    this.load = deps.load;
  }

  /** A host that passes a new callback each render changes how the next read is made, nothing else. */
  setLoader(load: IcicleDiffLoader): void {
    this.load = load;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): IcicleDiffSnapshot => this.snapshot;

  /** Points the diff at a change-set (or at none). The same one again changes nothing. */
  setTarget(ref: ChangeSetRef | null): void {
    if (sameRef(ref, this.target)) return;
    this.target = ref === null ? null : { kind: ref.kind, id: ref.id };
    this.token += 1;
    if (this.target === null) {
      this.replace(initialSnapshot());
    } else if (this.target.kind !== "topic") {
      this.replace({ load: { status: "unsupported" }, selectedId: null });
    } else {
      this.replace({ load: { status: "loading" }, selectedId: null });
      void this.read(this.target, false);
    }
  }

  /** The person asked to try again after a failure. */
  retry(): void {
    if (this.target === null || this.target.kind !== "topic") return;
    if (this.snapshot.load.status === "loading") return;
    void this.read(this.target, false);
  }

  /** Reads again in place (after an undo or a review): the diff on screen stays until the new one arrives. */
  refresh(): void {
    if (this.target === null || this.target.kind !== "topic") return;
    void this.read(this.target, this.snapshot.load.status === "ready");
  }

  select(topicId: string | null): void {
    if (this.snapshot.selectedId === topicId) return;
    this.update({ selectedId: topicId });
  }

  private async read(ref: ChangeSetRef, silent: boolean): Promise<void> {
    const token = ++this.token;
    if (!silent) this.update({ load: { status: "loading" } });
    let diff: ChangesDiff | null;
    try {
      diff = await this.load(ref);
    } catch {
      if (token !== this.token) return;
      // A failed refresh keeps the diff that is shown.
      if (!silent || this.snapshot.load.status !== "ready")
        this.update({ load: { status: "error" } });
      return;
    }
    if (token !== this.token) return;
    if (diff === null) this.update({ load: { status: "missing" } });
    else if (!isTopicDiff(diff)) this.update({ load: { status: "unsupported" } });
    else if (!sameContent(this.snapshot.load, diff.nodes, diff.hidden))
      this.update({ load: { status: "ready", nodes: diff.nodes, hidden: diff.hidden } });
  }

  private update(change: Partial<IcicleDiffSnapshot>): void {
    this.replace({ ...this.snapshot, ...change });
  }

  private replace(snapshot: IcicleDiffSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

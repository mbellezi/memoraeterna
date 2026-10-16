import { formatObjectAddress, type TopicPlacementRole } from "@app/domain";
import type { MessageKey } from "@app/i18n";

import type { DesktopApi } from "../../../../shared/ipc";
import { sharedNoticeCenter, type TopicNoticeCenter } from "./topic-notice-center";
import {
  checkTitle,
  failureMessage,
  isUnchanged,
  itemPinNotice,
  pinNotice,
  titleCheckMessage,
  type OpsNotice,
  type OpsTopic
} from "./topic-ops";

export type OpsApi = Pick<DesktopApi["topics"], "mutate" | "undo">;
/** The view history's pins: a note, a source or a topic that is only pinned there (D28). */
export type OpsHistoryApi = Pick<DesktopApi["viewHistory"], "record" | "setPinned">;

/** What pinning a note, a source or a topic pinned only in the view history needs to know. */
export interface HistoryPinItem {
  kind: "topic" | "note" | "source";
  id: string;
  /** The name the history keeps if the object was never opened; null reads as unnamed. */
  title: string | null;
  /**
   * The host a note opens in (its source's address), asked only when the history has no entry for
   * the object yet; null when it cannot be found.
   */
  host?: (() => Promise<string | null>) | undefined;
}

/** The dialog a view has open: at most one, and none while the view is hidden. */
export type OpsDialog =
  | { kind: "move"; topic: OpsTopic }
  | { kind: "create"; parent: { id: string; title: string | null }; top: boolean }
  | { kind: "place"; item: { kind: "note" | "source"; id: string; title: string } };

export interface OpsSnapshot {
  /** An operation is in flight; another one waits for it. */
  busy: boolean;
  /** The last refusal, cleared by the next attempt. */
  error: MessageKey | null;
  dialog: OpsDialog | null;
}

const idle: OpsSnapshot = { busy: false, error: null, dialog: null };

/**
 * The human structure operations of one view (docs F2 T26), outside React so every rule is tested
 * without a renderer: each operation is one call to `topics.mutate`, a success leaves a notice with
 * Undo, a refusal leaves its message. The notice is not the view's: it goes to the window's one
 * notice center, and goes away with the view that made it when that view is hidden. The views
 * redraw from pushed changes, so nothing here reads the tree.
 */
export class TopicOpsController {
  private snapshot: OpsSnapshot = idle;
  private readonly listeners = new Set<() => void>();
  private readonly center: TopicNoticeCenter;
  private readonly history: () => OpsHistoryApi;

  constructor(
    private readonly api: () => OpsApi,
    deps: { center?: TopicNoticeCenter; history?: () => OpsHistoryApi } = {}
  ) {
    this.center = deps.center ?? sharedNoticeCenter;
    this.history = deps.history ?? (() => window.app.viewHistory);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): OpsSnapshot => this.snapshot;

  // -------------------------------------------------------------------------
  // Operations: each resolves true when the tree is as the person asked for

  /** Renames a topic. The name is checked first; the same name again changes nothing. */
  async rename(topic: OpsTopic, raw: string): Promise<boolean> {
    const checked = checkTitle(raw);
    if (!checked.ok) {
      this.update({ error: titleCheckMessage[checked.reason] });
      return false;
    }
    if (topic.title === checked.title) {
      this.update({ error: null });
      return true;
    }
    return this.mutate(
      {
        op: "rename",
        id: topic.id,
        title: checked.title,
        expectedUpdatedAt: topic.updatedAt
      },
      { key: "topics.ops.toast.renamed", title: checked.title, parent: null }
    );
  }

  /** Moves a topic under another (last child). */
  move(topic: OpsTopic, parent: { id: string; title: string | null }): Promise<boolean> {
    return this.mutate(
      { op: "move", id: topic.id, parentId: parent.id, expectedUpdatedAt: topic.updatedAt },
      { key: "topics.ops.toast.moved", title: topic.title, parent: parent.title }
    );
  }

  /** Creates a subtopic. */
  async create(parent: { id: string; title: string | null }, raw: string): Promise<boolean> {
    const checked = checkTitle(raw);
    if (!checked.ok) {
      this.update({ error: titleCheckMessage[checked.reason] });
      return false;
    }
    return this.mutate(
      { op: "create", parentId: parent.id, title: checked.title },
      { key: "topics.ops.toast.created", title: checked.title, parent: parent.title }
    );
  }

  /** Pins or unpins a topic: its place in Pinned and its protection from automation (D28). */
  pin(topic: Pick<OpsTopic, "id" | "title">, pinned: boolean): Promise<boolean> {
    return this.mutate(
      { op: pinned ? "pin" : "unpin", id: topic.id },
      pinNotice(pinned, topic.title)
    );
  }

  /**
   * Pins or unpins what only the view history holds (D28): a note or a source (pinning one touches
   * nothing else), or a topic that is pinned there without being protected (its management is not
   * `pinned`, so the tree has nothing to change and there is nothing to undo). An object that was
   * never opened has no entry to pin yet: the entry is recorded first, with its host for a note.
   */
  pinHistory(item: HistoryPinItem, pinned: boolean): Promise<boolean> {
    return this.run(async () => {
      const address = formatObjectAddress({ kind: item.kind, id: item.id });
      const history = this.history();
      const entry = await history.setPinned(address, pinned);
      if (entry === null && pinned) {
        const host = item.host ? await item.host() : null;
        // A note opens from its source: without it the entry could not be listed or opened.
        if (item.kind === "note" && host === null) throw new Error("topics.ops.errors.failed");
        await history.record({
          kind: item.kind,
          id: item.id,
          title: item.title ?? "",
          ...(host ? { parentAddress: host } : {})
        });
        await history.setPinned(address, true);
      }
      return { changeSetId: null, notice: itemPinNotice(pinned, item.title) };
    });
  }

  /** Places a note or a source in a topic: as its place, or as one more place it shows up. */
  place(
    item: { kind: "note" | "source"; id: string; title: string | null },
    topic: { id: string; title: string | null },
    role: TopicPlacementRole
  ): Promise<boolean> {
    return this.mutate(
      { op: "placeItem", item: { kind: item.kind, id: item.id }, topicId: topic.id, role },
      {
        key: role === "primary" ? "topics.ops.toast.placed" : "topics.ops.toast.alsoPlaced",
        title: item.title,
        parent: topic.title
      }
    );
  }

  // -------------------------------------------------------------------------
  // Refusals and dialogs

  /** The last refusal is no longer news (a dialog or an editor closed). */
  clearError(): void {
    if (this.snapshot.error !== null) this.update({ error: null });
  }

  /** Opens a dialog (the view draws it); an older refusal is not shown in it. */
  openDialog(dialog: OpsDialog): void {
    this.update({ dialog, error: null });
  }

  closeDialog(): void {
    if (this.snapshot.dialog !== null || this.snapshot.error !== null) {
      this.update({ dialog: null, error: null });
    }
  }

  /** A view that is hidden keeps no dialog, no notice of its own and no refusal. */
  reset(): void {
    this.center.release(this);
    if (this.snapshot !== idle) this.update({ ...idle, busy: this.snapshot.busy });
  }

  // -------------------------------------------------------------------------

  private mutate(mutation: Parameters<OpsApi["mutate"]>[0], notice: OpsNotice): Promise<boolean> {
    return this.run(async () => {
      const result = await this.api().mutate(mutation);
      return { changeSetId: result.changeSetId, notice };
    });
  }

  /** One operation at a time: its notice when it succeeded, its message when it was refused. */
  private async run(
    operation: () => Promise<{ changeSetId: string | null; notice: OpsNotice }>
  ): Promise<boolean> {
    if (this.snapshot.busy) return false;
    this.update({ busy: true, error: null });
    try {
      const done = await operation();
      this.update({ busy: false });
      const state = done.changeSetId === null ? "none" : "idle";
      this.center.show(done.notice, done.changeSetId, state, this);
      return true;
    } catch (error) {
      // The same name or place again is not a failure: there is nothing to undo, and nothing wrong.
      if (isUnchanged(error)) {
        this.update({ busy: false });
        return true;
      }
      this.update({ busy: false, error: failureMessage(error) });
      return false;
    }
  }

  private update(patch: Partial<OpsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

import type { TopicPlacementRole } from "@app/domain";
import type { MessageKey } from "@app/i18n";

import type { DesktopApi } from "../../../../shared/ipc";
import {
  checkTitle,
  failureMessage,
  isUnchanged,
  noticeVisibleMs,
  pinNotice,
  titleCheckMessage,
  type OpsNotice,
  type OpsTopic
} from "./topic-ops";

export type OpsApi = Pick<DesktopApi["topics"], "mutate" | "undo">;

/**
 * Where a notice stands: `idle` (Undo is offered), `pending` (undoing), `blocked` (a later change
 * depends on it), `failed` (try again) or `none` (it only tells; there is nothing to undo).
 */
export type NoticeState = "idle" | "pending" | "blocked" | "failed" | "none";

export interface ShownNotice extends OpsNotice {
  /** Tells notices apart across updates (the live region announces a new one). */
  id: number;
  /** The change-set Undo reverts; null for a notice that only tells. */
  changeSetId: string | null;
  state: NoticeState;
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
  notice: ShownNotice | null;
  dialog: OpsDialog | null;
}

const idle: OpsSnapshot = { busy: false, error: null, notice: null, dialog: null };

/**
 * The human structure operations of one view (docs F2 T26), outside React so every rule is tested
 * without a renderer: each operation is one call to `topics.mutate`, a success leaves a notice with
 * Undo that stays long enough to be reached by keyboard, a refusal leaves its message. The views
 * redraw from pushed changes, so nothing here reads the tree.
 */
export class TopicOpsController {
  private snapshot: OpsSnapshot = idle;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private held = false;
  private noticeCounter = 0;

  constructor(private readonly api: () => OpsApi) {}

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
    return this.run(
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
    return this.run(
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
    return this.run(
      { op: "create", parentId: parent.id, title: checked.title },
      { key: "topics.ops.toast.created", title: checked.title, parent: parent.title }
    );
  }

  /** Pins or unpins a topic: its place in Pinned and its protection from automation (D28). */
  pin(topic: Pick<OpsTopic, "id" | "title">, pinned: boolean): Promise<boolean> {
    return this.run({ op: pinned ? "pin" : "unpin", id: topic.id }, pinNotice(pinned, topic.title));
  }

  /** Places a note or a source in a topic: as its place, or as one more place it shows up. */
  place(
    item: { kind: "note" | "source"; id: string; title: string | null },
    topic: { id: string; title: string | null },
    role: TopicPlacementRole
  ): Promise<boolean> {
    return this.run(
      { op: "placeItem", item: { kind: item.kind, id: item.id }, topicId: topic.id, role },
      {
        key: role === "primary" ? "topics.ops.toast.placed" : "topics.ops.toast.alsoPlaced",
        title: item.title,
        parent: topic.title
      }
    );
  }

  // -------------------------------------------------------------------------
  // The notice

  /** Reverts the change the notice names. */
  async undo(): Promise<void> {
    const notice = this.snapshot.notice;
    if (!notice || notice.changeSetId === null || notice.state === "pending") return;
    const changeSetId = notice.changeSetId;
    this.setNotice({ ...notice, state: "pending" });
    this.stopTimer();
    try {
      const result = await this.api().undo({ changeSetId });
      if (!this.owns(notice.id)) return;
      if (result.status === "undone") {
        this.show({ key: "topics.ops.toast.undone", title: null, parent: null }, null, "none");
      } else {
        this.setNotice({ ...notice, state: "blocked" });
        this.startTimer();
      }
    } catch {
      if (!this.owns(notice.id)) return;
      this.setNotice({ ...notice, state: "failed" });
      this.startTimer();
    }
  }

  /** The person left or closed the notice. */
  dismiss(): void {
    this.stopTimer();
    this.update({ notice: null });
  }

  /** Hovering or focusing the notice keeps it; leaving it starts the wait again. */
  hold(held: boolean): void {
    this.held = held;
    if (held) this.stopTimer();
    else if (this.snapshot.notice && this.snapshot.notice.state !== "pending") this.startTimer();
  }

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

  /** A view that is hidden keeps no dialog, no notice and no refusal. */
  reset(): void {
    this.stopTimer();
    this.held = false;
    if (this.snapshot !== idle) this.update({ ...idle, busy: this.snapshot.busy });
  }

  /** The view went away: the notice stops counting down (React may mount it again). */
  dispose(): void {
    this.stopTimer();
  }

  // -------------------------------------------------------------------------

  private async run(
    mutation: Parameters<OpsApi["mutate"]>[0],
    notice: OpsNotice
  ): Promise<boolean> {
    if (this.snapshot.busy) return false;
    this.stopTimer();
    this.update({ busy: true, error: null });
    try {
      const result = await this.api().mutate(mutation);
      this.update({ busy: false });
      this.show(notice, result.changeSetId, "idle");
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

  private show(notice: OpsNotice, changeSetId: string | null, state: NoticeState): void {
    this.noticeCounter += 1;
    this.update({ notice: { ...notice, id: this.noticeCounter, changeSetId, state } });
    this.startTimer();
  }

  private setNotice(notice: ShownNotice): void {
    this.update({ notice });
  }

  private owns(id: number): boolean {
    return this.snapshot.notice?.id === id;
  }

  private startTimer(): void {
    this.stopTimer();
    if (this.held || !this.snapshot.notice) return;
    this.timer = setTimeout(() => this.dismiss(), noticeVisibleMs);
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private update(patch: Partial<OpsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

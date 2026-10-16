import type { DesktopApi } from "../../../../shared/ipc";
import { noticeVisibleMs, type OpsNotice } from "./topic-ops";

export type NoticeApi = Pick<DesktopApi["topics"], "undo">;

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

export interface NoticeSnapshot {
  notice: ShownNotice | null;
}

/** Whether Undo can be asked of a notice: it names a change-set and no later change depends on it. */
export function canUndoNotice(notice: ShownNotice | null): boolean {
  return notice !== null && notice.changeSetId !== null && notice.state !== "blocked";
}

/**
 * The one notice of the window (docs F2 T26): every view that changes the tree (the navigator, the
 * Topic page, the Note page) shows its result here, so two notices never overlap and the U key and
 * the keyboard always reach the newest one. A new notice replaces the one on screen; the notice
 * stays long enough to read and to reach, and waits while it is hovered or focused. It is outside
 * React so each rule is tested without a renderer.
 */
export class TopicNoticeCenter {
  private snapshot: NoticeSnapshot = { notice: null };
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private held = false;
  private counter = 0;
  /** The view whose change the notice tells; a view that goes away takes its notice with it. */
  private owner: object | null = null;

  constructor(private readonly api: () => NoticeApi) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): NoticeSnapshot => this.snapshot;

  /** Shows a notice in place of the one on screen and starts its wait. */
  show(
    notice: OpsNotice,
    changeSetId: string | null,
    state: NoticeState,
    owner: object | null = null
  ): number {
    this.counter += 1;
    this.owner = owner;
    this.snapshot = { notice: { ...notice, id: this.counter, changeSetId, state } };
    this.emit();
    this.startTimer();
    return this.counter;
  }

  /** Reverts the change the notice names. */
  async undo(): Promise<void> {
    const notice = this.snapshot.notice;
    if (!notice || notice.changeSetId === null || notice.state === "pending") return;
    const { changeSetId } = notice;
    const owner = this.owner;
    this.replace({ ...notice, state: "pending" });
    this.stopTimer();
    try {
      const result = await this.api().undo({ changeSetId });
      // Another notice took the place meanwhile: it is the one that matters now.
      if (!this.owns(notice.id)) return;
      if (result.status === "undone") {
        this.show(
          { key: "topics.ops.toast.undone", title: null, parent: null },
          null,
          "none",
          owner
        );
      } else {
        this.replace({ ...notice, state: "blocked" });
        this.startTimer();
      }
    } catch {
      if (!this.owns(notice.id)) return;
      this.replace({ ...notice, state: "failed" });
      this.startTimer();
    }
  }

  /** The person left or closed the notice. */
  dismiss(): void {
    this.stopTimer();
    // The notice that was hovered or focused is gone, and so is what held it.
    this.held = false;
    if (this.snapshot.notice === null) return;
    this.owner = null;
    this.snapshot = { notice: null };
    this.emit();
  }

  /** Hovering or focusing the notice keeps it; leaving it starts the wait again. */
  hold(held: boolean): void {
    this.held = held;
    if (held) this.stopTimer();
    else if (this.snapshot.notice && this.snapshot.notice.state !== "pending") this.startTimer();
  }

  /** A view that is hidden or gone keeps no notice of its own on screen. */
  release(owner: object): void {
    if (this.owner === owner && this.snapshot.notice !== null) this.dismiss();
  }

  // -------------------------------------------------------------------------

  private owns(id: number): boolean {
    return this.snapshot.notice?.id === id;
  }

  private replace(notice: ShownNotice): void {
    this.snapshot = { notice };
    this.emit();
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

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The window's notice center: every view's controller shows its notices here. */
export const sharedNoticeCenter = new TopicNoticeCenter(() => window.app.topics);

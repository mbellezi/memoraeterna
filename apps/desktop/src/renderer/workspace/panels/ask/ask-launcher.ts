import type { AskScope } from "@app/domain";

import type { QuestionListItemView, QuestionsApi } from "../../../../shared/ipc-questions";
import { askedQuestion, rememberAsked, rememberRequest } from "./ask-session";

/**
 * Sends one Ask and lists the recent ones, outside React so the rules are tested without a
 * renderer:
 *
 * - one Ask at a time: while `questions.ask` is in flight a second one is refused, so a double
 *   Enter never asks twice;
 * - an Ask answers with its Question as soon as the row exists, and the caller moves to it
 *   (`onAsked`); the words and scope that made it are remembered for this window (`key`), so Back to
 *   the same `ask` address opens that Question instead of asking again;
 * - a failed Ask keeps the words in the field (the caller's) and says so once, with a way to try
 *   again; the recent list reads once and a failure of it leaves the composer usable (no recents).
 */

export type LauncherSend = { status: "idle" } | { status: "asking" } | { status: "error" };

export type LauncherRecents =
  { status: "loading" } | { status: "ready"; items: QuestionListItemView[] };

export interface LauncherSnapshot {
  send: LauncherSend;
  recents: LauncherRecents;
}

export interface AskLauncherDeps {
  api: () => Pick<QuestionsApi, "ask" | "list"> | undefined;
  /** The Question exists: move to its page. */
  onAsked: (questionId: string) => void;
}

/** How many recent questions the composer lists. */
export const recentLimit = 5;

export class AskLauncherController {
  private readonly listeners = new Set<() => void>();
  private snapshot: LauncherSnapshot = {
    send: { status: "idle" },
    recents: { status: "loading" }
  };
  private recentsRead = false;

  constructor(private readonly deps: AskLauncherDeps) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): LauncherSnapshot => this.snapshot;

  /** Reads the recent questions, once. */
  loadRecents(): void {
    if (this.recentsRead) return;
    this.recentsRead = true;
    const api = this.deps.api();
    if (!api) {
      this.set({ ...this.snapshot, recents: { status: "ready", items: [] } });
      return;
    }
    api
      .list({ limit: recentLimit })
      .then((page) =>
        this.set({ ...this.snapshot, recents: { status: "ready", items: page.items } })
      )
      // The composer works without its list: a failed read is a list with nothing in it.
      .catch(() => this.set({ ...this.snapshot, recents: { status: "ready", items: [] } }));
  }

  /**
   * Sends the Ask. `key` is the address that asked (an `ask` panel's own); a window that already
   * made a Question from it moves to that Question without asking again.
   */
  ask(input: { text: string; scope: AskScope; key?: string }): void {
    if (this.snapshot.send.status === "asking") return;
    if (input.key !== undefined) {
      const known = askedQuestion(input.key);
      if (known !== undefined) {
        this.deps.onAsked(known);
        return;
      }
    }
    const api = this.deps.api();
    if (!api) {
      this.set({ ...this.snapshot, send: { status: "error" } });
      return;
    }
    this.set({ ...this.snapshot, send: { status: "asking" } });
    api
      .ask({ text: input.text.trim(), scope: input.scope })
      .then(({ questionId, requestId }) => {
        rememberRequest(questionId, requestId);
        if (input.key !== undefined) rememberAsked(input.key, questionId);
        this.set({ ...this.snapshot, send: { status: "idle" } });
        this.deps.onAsked(questionId);
      })
      .catch(() => this.set({ ...this.snapshot, send: { status: "error" } }));
  }

  /** The person edits the words after a failure: the failure is not about these words any more. */
  clearError(): void {
    if (this.snapshot.send.status === "error")
      this.set({ ...this.snapshot, send: { status: "idle" } });
  }

  private set(snapshot: LauncherSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}

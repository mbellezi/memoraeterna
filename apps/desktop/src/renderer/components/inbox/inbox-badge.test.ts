import { describe, expect, it, vi } from "vitest";

import { emptyInboxCounts, type InboxCounts } from "@app/domain";

import type { AppEventHandler } from "../../../shared/app-events";
import { InboxBadge, type InboxBadgeApi } from "./inbox-badge";

const counts = (total: number): InboxCounts => ({ ...emptyInboxCounts(), total });
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(read: () => Promise<InboxCounts> = async () => counts(3)) {
  let handler: AppEventHandler<"inbox.changed"> | null = null;
  const unsubscribe = vi.fn(() => {
    handler = null;
  });
  const api: InboxBadgeApi = {
    inbox: { counts: vi.fn(read) },
    onAppEvent: ((type: string, next: AppEventHandler<"inbox.changed">) => {
      if (type === "inbox.changed") handler = next;
      return unsubscribe;
    }) as InboxBadgeApi["onAppEvent"]
  };
  return {
    badge: new InboxBadge(() => api),
    api,
    unsubscribe,
    push: (total: number) =>
      handler?.({
        type: "inbox.changed",
        total,
        byKind: counts(0).byKind,
        byRisk: counts(0).byRisk
      }),
    listening: () => handler !== null
  };
}

describe("the Inbox badge", () => {
  it("knows nothing until it starts, then reads the count once", async () => {
    const h = harness();
    expect(h.badge.getSnapshot()).toBeNull();
    h.badge.start();
    await settle();
    expect(h.badge.getSnapshot()).toBe(3);
    expect(h.api.inbox.counts).toHaveBeenCalledTimes(1);
  });

  it("follows the pushed counts and tells its listeners only when the number changes", async () => {
    const h = harness();
    const listener = vi.fn();
    h.badge.subscribe(listener);
    h.badge.start();
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
    h.push(5);
    h.push(5);
    expect(h.badge.getSnapshot()).toBe(5);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("lets a pushed count win over a read that is still on its way", async () => {
    let finish: (value: InboxCounts) => void = () => undefined;
    const h = harness(() => new Promise<InboxCounts>((resolve) => (finish = resolve)));
    h.badge.start();
    h.push(7);
    finish(counts(3));
    await settle();
    expect(h.badge.getSnapshot()).toBe(7);
  });

  it("starts once, stops listening when told, and ignores a read that arrives after", async () => {
    let finish: (value: InboxCounts) => void = () => undefined;
    const h = harness(() => new Promise<InboxCounts>((resolve) => (finish = resolve)));
    h.badge.start();
    h.badge.start();
    expect(h.api.inbox.counts).toHaveBeenCalledTimes(1);
    expect(h.listening()).toBe(true);
    h.badge.stop();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.listening()).toBe(false);
    finish(counts(9));
    await settle();
    expect(h.badge.getSnapshot()).toBeNull();
  });

  it("stays quiet when the count cannot be read", async () => {
    const h = harness(async () => {
      throw new Error("down");
    });
    h.badge.start();
    await settle();
    expect(h.badge.getSnapshot()).toBeNull();
  });
});

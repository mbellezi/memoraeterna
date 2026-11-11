import type { PgPool } from "@app/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEvent, AppEventHandler, AppEventType } from "../../../shared/app-events.js";
import { InboxService, recountDelayMs } from "./inbox-service.js";

describe("the quiet time before the Inbox recounts", () => {
  it("keeps the base delay while the count is cheap", () => {
    expect(recountDelayMs(3_000, 0)).toBe(3_000);
    expect(recountDelayMs(3_000, 20)).toBe(3_000);
    expect(recountDelayMs(5, 0)).toBe(5);
  });

  it("waits ten times as long as a slow count took, up to a minute", () => {
    expect(recountDelayMs(3_000, 800)).toBe(8_000);
    expect(recountDelayMs(3_000, 4_000)).toBe(40_000);
    expect(recountDelayMs(3_000, 60_000)).toBe(60_000);
  });
});

describe("the service's recount after an event", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A service whose database count takes `countMs` of the injected clock and whose vault takes `vaultMs`. */
  const build = (countMs: () => number, vaultMs = 0) => {
    let clock = 0;
    let queries = 0;
    const handlers = new Map<AppEventType, AppEventHandler<AppEventType>>();
    const pool = {
      query: async () => {
        queries += 1;
        clock += countMs();
        return { rows: [] };
      }
    } as unknown as PgPool;
    const service = new InboxService({
      getPool: () => pool,
      changes: { review: vi.fn(), undo: vi.fn() },
      reviewRelation: vi.fn(),
      matchBacklog: () => null,
      retryJob: vi.fn(),
      obsidianConflicts: async () => {
        clock += vaultMs;
        return [];
      },
      events: {
        publish: (_event: AppEvent) => undefined,
        subscribe: (type, handler) => {
          handlers.set(type, handler as AppEventHandler<AppEventType>);
          return () => undefined;
        }
      },
      refreshDelayMs: 3_000,
      now: () => clock
    });
    service.start();
    return {
      service,
      queries: () => queries,
      emit: () => handlers.get("relation.created")?.({ type: "relation.created" } as AppEvent)
    };
  };

  it("waits ten times as long as the database's last count took, not the base delay", async () => {
    const { service, queries, emit } = build(() => 800);
    await vi.advanceTimersByTimeAsync(10_000);
    await service.refreshNow();
    const before = queries();
    emit();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(queries()).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(queries()).toBe(before + 1);
    service.dispose();
  });

  it("recounts after the base delay while the count is fast, and times the database alone", async () => {
    // A slow vault scan must not stretch the quiet time of a fast database count.
    const { service, queries, emit } = build(() => 5, 4_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await service.refreshNow();
    const before = queries();
    emit();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(queries()).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(queries()).toBe(before + 1);
    service.dispose();
  });
});

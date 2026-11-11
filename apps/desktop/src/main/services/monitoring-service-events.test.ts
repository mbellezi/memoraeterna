import { afterEach, describe, expect, it, vi } from "vitest";

import type { PgPool } from "@app/db";

import { AppEventSchema, type AppEvent } from "../../shared/app-events.js";
import { appEventPort } from "./app-events.js";
import { MonitoringService } from "./monitoring-service.js";

const epoch = new Date(0).toISOString();
const started = {
  kind: "ai" as const,
  operation: "embedding",
  stage: "chunk_embedding",
  context: {},
  sourceItemIds: [],
  input: "full source"
};

function harness(rows: unknown[] = [{ id: "11111111-1111-4111-8111-111111111111" }]) {
  const query = vi.fn().mockResolvedValue({ rows });
  const events: AppEvent[] = [];
  appEventPort.attach({ publish: (event) => events.push(event) });
  const service = new MonitoringService(
    () => ({ query }) as unknown as PgPool,
    async () => ({ debugMode: false, debugFullCapture: false }),
    { error: vi.fn() }
  );
  return { service, query, events };
}

const changes = (events: AppEvent[]) =>
  events.filter((event) => event.type === "monitoring.changed");

afterEach(() => appEventPort.detach());

describe("MonitoringService publishes monitoring.changed (T115)", () => {
  it("publishes a capture's start and finish, both from the time the capture began", async () => {
    const { service, events } = harness();
    const before = Date.now();

    const capture = await service.start(started);
    await service.finish(capture, { status: "succeeded", durationMs: 3 });

    const [first, second] = changes(events);
    expect(capture?.startedAt).toBeDefined();
    expect(Date.parse(capture!.startedAt!)).toBeGreaterThanOrEqual(before);
    expect(first).toEqual({ type: "monitoring.changed", since: capture!.startedAt });
    expect(second).toEqual(first);
    for (const event of events) expect(AppEventSchema.safeParse(event).success).toBe(true);
  });

  it("publishes nothing for a call that is not recorded", async () => {
    const { service, events } = harness();

    expect(await service.operation("canonicalization", {}, async () => 42)).toBe(42);

    expect(changes(events)).toEqual([]);
  });

  it("publishes nothing when the write fails", async () => {
    const { service, query, events } = harness();
    query.mockRejectedValueOnce(new Error("database down"));

    expect(await service.start(started)).toBeNull();

    expect(changes(events)).toEqual([]);
  });

  it("publishes a recovery and a prune that deleted rows from the beginning of time", async () => {
    const { service, query, events } = harness([{ count: 3 }]);

    await service.recover();
    const pruned = await service.prune({ amount: 30, unit: "days", scope: "all", preview: false });

    expect(pruned.count).toBe(3);
    expect(changes(events)).toEqual([
      { type: "monitoring.changed", since: epoch },
      { type: "monitoring.changed", since: epoch }
    ]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("publishes nothing for a preview or a prune that touched no row", async () => {
    const { service, query, events } = harness([{ count: 4 }]);

    await service.prune({ amount: 30, unit: "days", scope: "all", preview: true });
    query.mockResolvedValue({ rows: [{ count: 0 }] });
    await service.prune({ amount: 30, unit: "days", scope: "payloads", preview: false });

    expect(changes(events)).toEqual([]);
  });
});

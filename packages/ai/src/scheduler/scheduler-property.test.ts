import { describe, expect, it } from "vitest";

import { resolveAiLaneRuntimeConfig } from "../runtime-config.js";
import { createAiScheduler } from "./scheduler.js";
import { fakeSchedulerClock, flush } from "./test-clock.js";
import type { AiPriority, LaneKey, LanePermit, RemoteLaneKind } from "./types.js";

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const lanes: Array<{ lane: LaneKey; remoteKind?: RemoteLaneKind }> = [
  { lane: "local" },
  { lane: "remote:key", remoteKind: "api-key" },
  { lane: "remote:codex", remoteKind: "codex" }
];
const aging = { p3ToP2Ms: 60_000, p2ToP1Ms: 120_000 };

/** The rank an entry competes with, written independently of the scheduler's own function. */
function expectedRank(priority: AiPriority, waited: number): number {
  if (priority === "P0") return 0;
  if (priority === "P1") return 1;
  if (priority === "P2") return waited >= 120_000 ? 1 : 2;
  return waited >= 180_000 ? 1 : waited >= 60_000 ? 2 : 3;
}

interface ModelEntry {
  id: number;
  lane: LaneKey;
  priority: AiPriority;
  admittedAt: number;
  sequence: number;
}

describe("lane scheduler property test", () => {
  it("never exceeds a lane limit, loses no entry and serves FIFO within effective priority over 10,000 operations", async () => {
    const next = random(20261017);
    const time = fakeSchedulerClock();
    const scheduler = createAiScheduler(
      resolveAiLaneRuntimeConfig({ aging }, { environment: {} }),
      time.clock
    );
    const waiting = new Map<number, ModelEntry>();
    const active = new Map<LaneKey, number>(lanes.map(({ lane }) => [lane, 0]));
    const ends: Array<{ at: number; done: () => void }> = [];
    const controllers = new Map<number, AbortController>();
    const settled = new Map<number, "finished" | "cancelled">();
    const violations: string[] = [];
    let admitted = 0;
    let sequence = 0;
    let maxP3Wait = 0;

    const limitOf = (lane: LaneKey) =>
      scheduler.snapshot().find((snapshot) => snapshot.lane === lane)?.limit ?? 1;

    /** Checks a start against the model: the lane limit and the selection order. */
    const started = (entry: ModelEntry) => {
      const now = time.now();
      waiting.delete(entry.id);
      const running = active.get(entry.lane)! + 1;
      active.set(entry.lane, running);
      if (running > limitOf(entry.lane))
        violations.push(`${entry.lane}: ${running} running over limit ${limitOf(entry.lane)}`);
      const key = (candidate: ModelEntry) =>
        [
          expectedRank(candidate.priority, now - candidate.admittedAt),
          candidate.admittedAt,
          candidate.sequence
        ] as const;
      const mine = key(entry);
      for (const other of waiting.values()) {
        if (other.lane !== entry.lane) continue;
        const theirs = key(other);
        const earlier =
          theirs[0] < mine[0] ||
          (theirs[0] === mine[0] &&
            (theirs[1] < mine[1] || (theirs[1] === mine[1] && theirs[2] < mine[2])));
        if (earlier) violations.push(`entry ${entry.id} started before ${other.id}`);
      }
      if (entry.priority === "P3") maxP3Wait = Math.max(maxP3Wait, now - entry.admittedAt);
    };
    const stopped = (lane: LaneKey) => active.set(lane, active.get(lane)! - 1);
    const waitUntil = (milliseconds: number) =>
      new Promise<void>((resolve) => ends.push({ at: time.now() + milliseconds, done: resolve }));

    const admit = () => {
      const { lane, remoteKind } = lanes[Math.floor(next() * lanes.length)]!;
      const roll = next();
      const priority: AiPriority =
        roll < 0.05 ? "P0" : roll < 0.2 ? "P1" : roll < 0.7 ? "P2" : "P3";
      const id = ++admitted;
      const reservation = scheduler.reserve();
      sequence = reservation.sequence;
      const entry: ModelEntry = {
        id,
        lane,
        priority,
        admittedAt: reservation.admittedAt,
        sequence
      };
      waiting.set(id, entry);
      const controller = next() < 0.1 ? new AbortController() : undefined;
      if (controller) controllers.set(id, controller);
      // The local lane is overloaded (calls of up to 8 s, one at a time), so entries wait long
      // enough for aging to decide the order; remote lanes run near their limits.
      const durationMs = Math.floor(next() * (lane === "local" ? 8_000 : 4_000)) + 1;
      const backoff = next() < 0.1 ? Math.floor(next() * 2_000) + 1 : null;
      scheduler
        .run(
          {
            lane,
            remoteKind,
            priority,
            workloadClass: "decide",
            label: String(id),
            reservation,
            ...(controller ? { signal: controller.signal } : {})
          },
          async (permit: LanePermit) => {
            started(entry);
            if (backoff !== null) {
              await waitUntil(Math.floor(durationMs / 2));
              await permit.releaseDuring(async () => {
                stopped(lane);
                await waitUntil(backoff);
                // Waiting again, with its first admission.
                waiting.set(id, entry);
              }, {});
              started(entry);
            }
            await waitUntil(durationMs);
            stopped(lane);
          }
        )
        .then(
          () => settled.set(id, "finished"),
          () => {
            settled.set(id, "cancelled");
            waiting.delete(id);
            controllers.delete(id);
          }
        );
    };

    const advance = async (milliseconds: number) => {
      const target = time.now() + milliseconds;
      for (;;) {
        ends.sort((left, right) => left.at - right.at);
        const due = ends[0];
        if (!due || due.at > target) break;
        ends.shift();
        await time.advance(Math.max(0, due.at - time.now()));
        due.done();
        await flush();
      }
      await time.advance(target - time.now());
    };

    for (let operation = 0; operation < 10_000; operation++) {
      const roll = next();
      if (roll < 0.5) admit();
      else if (roll < 0.8) await advance(Math.floor(next() * 3_000) + 1);
      else if (roll < 0.85) {
        const ids = [...controllers.keys()].filter((id) => waiting.has(id));
        const id = ids[Math.floor(next() * ids.length)];
        if (id !== undefined) controllers.get(id)!.abort(new Error("cancelled"));
      } else if (roll < 0.88) {
        const { lane } = lanes[1 + Math.floor(next() * 2)]!;
        scheduler.observeRateLimit(lane, time.now() + Math.floor(next() * 2_000));
      } else {
        const { lane } = lanes[1 + Math.floor(next() * 2)]!;
        scheduler.observeOutcome(lane, next() < 0.9 ? "ok" : "transient");
      }
      await flush();
    }
    // Drain: nothing new arrives, time runs until every entry has settled.
    for (let round = 0; round < 10_000 && settled.size < admitted; round++) await advance(5_000);

    expect(violations).toEqual([]);
    expect(settled.size).toBe(admitted);
    expect(waiting.size).toBe(0);
    expect([...active.values()]).toEqual([0, 0, 0]);
    expect(scheduler.snapshot().every((lane) => lane.running === 0)).toBe(true);
    expect(admitted).toBeGreaterThan(4_000);
    // Reported for the record: the longest wait of a P3 entry under this random load.
    expect(maxP3Wait).toBeGreaterThan(0);
  });
});

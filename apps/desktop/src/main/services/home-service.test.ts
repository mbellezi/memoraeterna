import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import type { HomeDigestRecord, PgPool } from "@app/db";
import type { InboxItem } from "@app/domain";

import { homeChannels } from "../../shared/ipc-home.js";
import { registerHomeIpc } from "./home-ipc.js";
import { HomeService } from "./home-service.js";

const mocks = vi.hoisted(() => ({ digest: vi.fn() }));
vi.mock("@app/db", async (original) => {
  const db = await original<typeof import("@app/db")>();
  return { ...db, createHomeDigestRepository: () => ({ digest: mocks.digest }) };
});

// The SQL runs against a real database in `homeDigestRepository.sidecar.test.ts`; these tests pin
// the boundary: what is validated, what reaches the repository and what the page receives.
const now = new Date("2026-11-11T11:00:00.000Z");
const since = "2026-11-10T22:40:00.000Z";
const topicId = "00000000-0000-4000-8000-000000000001";
const changeId = "00000000-0000-4000-8000-000000000002";
const questionId = "00000000-0000-4000-8000-000000000003";
const noteAddress = "memora://note/00000000-0000-4000-8000-000000000004";

const record = (overrides: Partial<HomeDigestRecord> = {}): HomeDigestRecord => ({
  since: new Date(since),
  firstRun: false,
  continue: [
    {
      address: noteAddress,
      kind: "note",
      title: "A note",
      parentAddress: null,
      openedAt: new Date("2026-11-10T22:38:00.000Z"),
      summary: null
    }
  ],
  new: {
    sources: { total: 0, items: [] },
    notes: { total: 3, placed: 2, unplaced: 1, items: [] }
  },
  inbox: {
    total: 2,
    top: [{ kind: "backlog", id: "b1", risk: "high", at: "2026-11-10T10:00:00.123456Z" }]
  },
  questions: [
    {
      id: questionId,
      text: "What is retrieval practice?",
      scope: { kind: "topic", topicId },
      status: "complete",
      createdAt: new Date("2026-11-10T09:00:00.000Z"),
      answerCount: 1
    }
  ],
  growth: [{ id: topicId, title: null, arrivals: 4 }],
  shape: {
    hasTree: true,
    notes: 10,
    topics: 3,
    depth: 2,
    violations: { hard: 0, soft: 1 },
    outOfBounds: 0,
    arrivalsThisWeek: 4,
    roots: [{ id: topicId, title: "Science", notes: 10, topics: 3, health: "good" }]
  },
  gardener: {
    count: 9,
    top: [
      {
        kind: "topic",
        id: changeId,
        titleKey: "topics.changeSets.rebalance",
        titleParams: {},
        risk: "medium",
        status: "applied",
        origin: "rebalance",
        subjectId: null,
        jobId: null,
        at: new Date("2026-11-10T23:00:00.000Z"),
        undoneAt: null,
        undo: "available"
      }
    ]
  },
  ...overrides
});

const pool = {} as unknown as PgPool;
const service = (options: Partial<ConstructorParameters<typeof HomeService>[0]> = {}) =>
  new HomeService({ getPool: () => pool, now: () => now, ...options });

const inboxItem: InboxItem = {
  kind: "backlog",
  id: "b1",
  risk: "high",
  variant: "match",
  at: "2026-11-10T10:00:00.123456Z",
  params: { notes: 40 },
  objects: [],
  changeSet: null,
  actions: ["apply", "dismiss"]
};

describe("HomeService.digest", () => {
  it("passes `since` to the repository and answers the digest with ISO times", async () => {
    mocks.digest.mockResolvedValueOnce(record());
    const digest = await service().digest({ since });
    expect(mocks.digest).toHaveBeenLastCalledWith({ since: new Date(since), now });
    expect(digest.since).toBe(since);
    expect(digest.continue[0]).toMatchObject({
      address: noteAddress,
      openedAt: "2026-11-10T22:38:00.000Z"
    });
    expect(digest.questions[0]?.createdAt).toBe("2026-11-10T09:00:00.000Z");
    expect(digest.gardener.top[0]?.at).toBe("2026-11-10T23:00:00.000Z");
    expect(digest.inbox).toEqual({
      total: 2,
      top: [
        { kind: "backlog", id: "b1", risk: "high", at: "2026-11-10T10:00:00.123456Z", item: null }
      ]
    });
  });

  it("takes a missing or null `since` to the repository as null and refuses a malformed one", async () => {
    mocks.digest.mockResolvedValue(record());
    await service().digest(undefined);
    expect(mocks.digest).toHaveBeenLastCalledWith({ since: null, now });
    await service().digest({ since: null });
    expect(mocks.digest).toHaveBeenLastCalledWith({ since: null, now });
    const calls = mocks.digest.mock.calls.length;
    await expect(service().digest({ since: "yesterday" })).rejects.toThrow();
    await expect(service().digest({ since, extra: 1 })).rejects.toThrow();
    expect(mocks.digest).toHaveBeenCalledTimes(calls);
  });

  it("fails with a message key while there is no database", async () => {
    await expect(service({ getPool: () => null }).digest({})).rejects.toThrow(
      "home.errors.unavailable"
    );
  });

  it("takes the Inbox's own total and rows when the Inbox service is installed", async () => {
    mocks.digest.mockResolvedValue(record());
    const list = vi.fn(async () => ({ items: [inboxItem], nextCursor: null }));
    const counts = vi.fn(async () => ({ total: 5 }));
    const digest = await service({ inbox: () => ({ list, counts }) }).digest({ since });
    expect(list).toHaveBeenCalledWith({ limit: 3 });
    expect(digest.inbox.total).toBe(5);
    expect(digest.inbox.top).toEqual([
      { kind: "backlog", id: "b1", risk: "high", at: inboxItem.at, item: inboxItem }
    ]);
  });

  it("keeps the database rows when the Inbox service fails: Home never fails for it", async () => {
    mocks.digest.mockResolvedValue(record());
    const failing = {
      list: vi.fn(async () => {
        throw new Error("inbox.errors.unavailable");
      }),
      counts: vi.fn(async () => ({ total: 9 }))
    };
    const digest = await service({ inbox: () => failing }).digest({ since });
    expect(digest.inbox.total).toBe(2);
    expect(digest.inbox.top[0]?.item).toBeNull();
    const absent = await service({ inbox: () => null }).digest({ since });
    expect(absent.inbox.total).toBe(2);
  });

  it("refuses a digest the contract does not describe", async () => {
    mocks.digest.mockResolvedValueOnce(
      record({
        growth: Array.from({ length: 6 }, () => ({ id: topicId, title: "T", arrivals: 1 }))
      })
    );
    await expect(service().digest({ since })).rejects.toThrow();
  });
});

describe("the digest's bounds", () => {
  it("are the repository's, restated for the contract the preload cannot import them for", async () => {
    const { homeDigestLimits } = await import("@app/db");
    const { homeDigestBounds } = await import("../../shared/ipc-home.js");
    expect(homeDigestBounds).toEqual({
      continue: homeDigestLimits.continue,
      arrivals: homeDigestLimits.arrivals,
      inbox: homeDigestLimits.inbox,
      questions: homeDigestLimits.questions,
      growth: homeDigestLimits.growth,
      gardener: homeDigestLimits.gardener,
      shapeRoots: homeDigestLimits.shapeRoots
    });
  });
});

describe("registerHomeIpc", () => {
  it("registers the one channel, validating the payload before the service sees it", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipc = {
      handle: (channel: string, fn: never) => handlers.set(channel, fn)
    } as unknown as IpcMain;
    const digest = vi.fn(async () => "ok");
    registerHomeIpc(ipc, { digest } as never);
    expect([...handlers.keys()]).toEqual([homeChannels.digest]);
    const handle = handlers.get(homeChannels.digest)!;
    await handle({}, { since });
    expect(digest).toHaveBeenLastCalledWith({ since });
    await handle({}, undefined);
    expect(digest).toHaveBeenLastCalledWith({});
    expect(() => handle({}, { since: 5 })).toThrow();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "@app/db";

import { createTopicChangeHooks } from "./topic-hooks.js";
import type { TopicTriggers } from "./topic-triggers.js";

const noteId = "55555555-5555-4555-8555-555555555555";
const sourceId = "11111111-1111-4111-8111-111111111111";

function fakeTriggers(failure?: Error) {
  const calls: string[] = [];
  const record = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
      if (failure) throw failure;
      return [];
    });
  const triggers = {
    notesChanged: record("notesChanged"),
    sourcesChanged: record("sourcesChanged"),
    repair: record("repair")
  };
  return { triggers, calls, api: triggers as unknown as TopicTriggers };
}

/** A transaction that records its statements and can fail one of them. */
function fakeTransaction(failOn?: string) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      statements.push(text);
      if (failOn && text === failOn) throw new Error("savepoint_failed");
      return { rows: [] };
    })
  };
  return { statements, client: client as unknown as Queryable };
}

describe("topic change hooks", () => {
  it("hand notes, sources and removals to the triggers", async () => {
    const { triggers, api } = fakeTriggers();
    const hooks = createTopicChangeHooks(api);
    await hooks.notesChanged([noteId]);
    await hooks.sourcesChanged([sourceId]);
    await hooks.itemsRemoved();
    expect(triggers.notesChanged).toHaveBeenCalledWith([noteId], {});
    expect(triggers.sourcesChanged).toHaveBeenCalledWith([sourceId], {});
    expect(triggers.repair).toHaveBeenCalledWith({});
  });

  it("never fail their caller: a failing trigger is logged and the sweep repairs it", async () => {
    const logger = { warn: vi.fn() };
    const { api } = fakeTriggers(new Error("database_unavailable"));
    const hooks = createTopicChangeHooks(api, logger);
    await expect(hooks.notesChanged([noteId])).resolves.toBeUndefined();
    await expect(hooks.sourcesChanged([sourceId])).resolves.toBeUndefined();
    await expect(hooks.itemsRemoved()).resolves.toBeUndefined();
    expect(logger.warn.mock.calls.map(([message]) => message)).toEqual([
      "Topic hook notesChanged failed; the topic sweep repairs it",
      "Topic hook sourcesChanged failed; the topic sweep repairs it",
      "Topic hook itemsRemoved failed; the topic sweep repairs it"
    ]);
    // Without a logger a failure is just as quiet.
    await expect(createTopicChangeHooks(api).itemsRemoved()).resolves.toBeUndefined();
  });

  it("run inside a savepoint in the caller's transaction and release it", async () => {
    const { triggers, api, calls } = fakeTriggers();
    const { client, statements } = fakeTransaction();
    const hooks = createTopicChangeHooks(api);
    triggers.repair.mockImplementation(async () => {
      statements.push("<enqueue>");
      calls.push("repair");
      return [];
    });
    await hooks.itemsRemoved({ client });
    expect(statements).toEqual([
      "savepoint topic_hook",
      "<enqueue>",
      "release savepoint topic_hook"
    ]);
    expect(triggers.repair).toHaveBeenCalledWith({ client });
  });

  it("roll back to the savepoint when a trigger fails, so the caller's transaction survives", async () => {
    const logger = { warn: vi.fn() };
    const { api } = fakeTriggers(new Error("jobs_table_unavailable"));
    const { client, statements } = fakeTransaction();
    const hooks = createTopicChangeHooks(api, logger);
    await expect(hooks.itemsRemoved({ client })).resolves.toBeUndefined();
    expect(statements).toEqual(["savepoint topic_hook", "rollback to savepoint topic_hook"]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("log, and do not throw, when the savepoint itself cannot be set", async () => {
    const logger = { warn: vi.fn() };
    const { api, triggers } = fakeTriggers();
    const { client } = fakeTransaction("savepoint topic_hook");
    await expect(
      createTopicChangeHooks(api, logger).notesChanged([noteId], { client })
    ).resolves.toBeUndefined();
    expect(triggers.notesChanged).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

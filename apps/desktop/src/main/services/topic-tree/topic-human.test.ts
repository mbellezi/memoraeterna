import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";

import { TopicUndoResultSchema, topicReadLimits } from "@app/domain";
import { TopicOperationError, topicOperationErrorCodes } from "@app/domain/topic-tree";
import type { StructureEvent, UndoBlocker } from "@app/domain/topic-tree";

import { ipcChannels } from "../../../shared/ipc.js";
import { createTopicTreeServices } from "./index.js";
import {
  historyEffectsOfUndo,
  humanErrorKeys,
  humanOperationError,
  humanTitleKeys,
  undoBlockersOf
} from "./topic-human.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const manage = (before: string, after: string, topicId = id(1)): StructureEvent =>
  ({
    op: "topic.manage",
    topicId,
    before: { management: before },
    after: { management: after }
  }) as StructureEvent;

describe("the human operations' vocabulary", () => {
  it("turns every refusal of the domain into a message key, and nothing else", () => {
    for (const code of topicOperationErrorCodes) {
      const error = humanOperationError(new TopicOperationError(code, "no"));
      expect(error?.message, code).toMatch(/^topics\.errors\.[A-Za-z]+$/u);
    }
    expect(humanOperationError(new TopicOperationError("cycle", "no"))?.message).toBe(
      humanErrorKeys.cycle
    );
    expect(humanOperationError(new TopicOperationError("duplicateTitle", "no"))?.message).toBe(
      humanErrorKeys.duplicateTitle
    );
    expect(humanOperationError(new Error("boom"))).toBeNull();
  });

  it("titles every change-set with a key the banner reads as a change by the person", () => {
    for (const key of Object.values(humanTitleKeys)) {
      expect(key).toMatch(/^topics\.changeSets\.human[A-Z][A-Za-z]*$/u);
    }
  });

  it("derives the view-history pin that undoing a pin or an unpin writes (D28)", () => {
    expect(historyEffectsOfUndo([manage("ai", "pinned")])).toEqual([
      { topicId: id(1), pinned: false }
    ]);
    expect(historyEffectsOfUndo([manage("pinned", "human")])).toEqual([
      { topicId: id(1), pinned: true }
    ]);
    // Moving between protected states is no pin, and other events carry none.
    expect(historyEffectsOfUndo([manage("ai", "human"), manage("human", "ai", id(2))])).toEqual([]);
    expect(historyEffectsOfUndo([])).toEqual([]);
  });

  it("bounds the blockers of an undo to the contract", () => {
    const blockers: UndoBlocker[] = [
      {
        kind: "changeSet",
        changeSetId: id(5),
        objects: Array.from({ length: 30 }, (_, n) => `topic:${id(100 + n)}`)
      },
      { kind: "itemDeleted", item: `note:${id(6)}` },
      { kind: "notApplied", status: "undone" },
      {
        kind: "conflict",
        code: "cycle",
        topicId: id(7),
        item: null,
        reason: "x".repeat(500)
      },
      ...Array.from({ length: 12 }, (_, n): UndoBlocker => ({
        kind: "itemDeleted",
        item: `note:${n}`
      }))
    ];
    const bounded = undoBlockersOf(blockers);
    expect(bounded).toHaveLength(topicReadLimits.undoBlockersMax);
    expect(TopicUndoResultSchema.safeParse({ status: "blocked", blockers: bounded }).success).toBe(
      true
    );
  });
});

describe("the human operations in the topic services", () => {
  it("installs the three handlers, which reach the service instead of answering unavailable", async () => {
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
    const ipc = {
      handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) =>
        handlers.set(channel, handler)
    } as unknown as IpcMain;
    const services = createTopicTreeServices({
      getPool: () => null,
      spaceResolver: {
        resolve: async () => ({ kind: "blocked", reason: "waiting_for_embeddings" })
      },
      env: {},
      isPackaged: false,
      logger: quiet,
      ipc: { main: ipc }
    });
    try {
      const requests: [string, unknown][] = [
        [ipcChannels.topicsMutate, { op: "pin", id: id(1) }],
        [ipcChannels.topicsUndo, { changeSetId: id(2) }],
        [ipcChannels.topicsReview, { changeSetId: id(3), decision: "dismiss" }]
      ];
      for (const [channel, payload] of requests) {
        // Without a database the service says so; the channel itself is wired.
        await expect(handlers.get(channel)!({}, payload), channel).rejects.toThrow(
          "errors.database.notReady"
        );
      }
      // The request is still validated before the service sees it.
      await expect(
        handlers.get(ipcChannels.topicsMutate)!({}, { op: "rename", id: "nope" })
      ).rejects.toThrow();
    } finally {
      services.dispose();
    }
  });
});

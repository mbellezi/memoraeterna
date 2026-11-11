import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { RelationBranchRead } from "@app/db";
import { ipcChannels } from "../../shared/ipc.js";
import {
  relationBranchStance,
  relationsBranchChannels,
  relationsBranchLimits
} from "../../shared/ipc-relations-branch.js";
import {
  readRelationsBranch,
  registerRelationsBranchIpc,
  relationsBranchReader,
  type RelationsBranchReader
} from "./relations-branch-ipc.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const read: RelationBranchRead = {
  topics: [
    { id: id(1), title: "Sleep", colourIndex: 0, parentId: null, noteCount: 0 },
    { id: id(2), title: "", colourIndex: 1, parentId: id(1), noteCount: 2 }
  ],
  nodes: [
    { id: id(10), title: "Naps", topicId: id(2), degree: 1 },
    { id: id(11), title: "Dreams", topicId: id(2), degree: 1 }
  ],
  edges: [{ id: id(20), a: id(10), b: id(11), type: "contrasts", band: "suggest" }],
  outside: [{ topicId: id(3), title: "Memory", edgeCount: 4 }],
  superEdges: [{ a: id(1), b: id(2), weight: 3 }],
  truncated: false
};

describe("relations.branch channel", () => {
  it("is named by the area and held once by ipcChannels (F5 T171)", () => {
    expect(relationsBranchChannels).toEqual({ branch: "app:relations:branch" });
    expect(
      Object.values(ipcChannels).filter((value) => value === relationsBranchChannels.branch)
    ).toHaveLength(1);
  });
});

describe("relationBranchStance", () => {
  it("draws every stored type with the stance the relation views give it", () => {
    // The table of `renderer/lib/relation-stance.ts` (a stored contrast reads as a contradiction).
    const expected = {
      supports: "supports",
      contrasts: "contradicts",
      contradicts: "contradicts",
      extends: "extends",
      depends_on: "depends_on",
      example_of: "example_of",
      clarifies: "related",
      mentions: "related",
      similar_to: "related",
      same_as: "related",
      related: "related"
    };
    for (const [type, stance] of Object.entries(expected))
      expect(relationBranchStance(type)).toBe(stance);
  });

  it("reads an unknown type as related, never as the raw value", () => {
    expect(relationBranchStance("refutes")).toBe("related");
    expect(relationBranchStance("constructor")).toBe("related");
  });
});

describe("readRelationsBranch", () => {
  it("fills the bounds a request leaves out and adds each edge's stance", async () => {
    const reader = vi.fn<RelationsBranchReader>(async () => read);
    const answer = await readRelationsBranch(reader, { scope: { topicId: id(1) } });
    expect(reader).toHaveBeenCalledWith({
      scope: { topicId: id(1) },
      colourDepth: 1,
      noteLimit: relationsBranchLimits.noteMax,
      perTopicLimit: relationsBranchLimits.perTopicMax,
      relationLimit: relationsBranchLimits.relationMax
    });
    expect(answer?.edges).toEqual([{ ...read.edges[0], stance: "contradicts" }]);
    expect(answer?.topics).toEqual(read.topics);
  });

  it("refuses a request out of its bounds before reading", async () => {
    const reader = vi.fn<RelationsBranchReader>(async () => read);
    const scope = { sourceId: id(5) };
    for (const bad of [
      {},
      { scope: { topicId: id(1), sourceId: id(5) } },
      { scope: { topicId: "not-a-uuid" } },
      { scope, colourDepth: 4 },
      { scope, noteLimit: 401 },
      { scope, perTopicLimit: 81 },
      { scope, relationLimit: 2001 },
      { scope, noteLimit: 0 },
      { scope: { topicId: id(1) }, extra: true }
    ])
      await expect(readRelationsBranch(reader, bad)).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
    await expect(
      readRelationsBranch(reader, { scope, colourDepth: 3, noteLimit: 400 })
    ).resolves.not.toBeNull();
  });

  it("answers null for a scope that does not exist", async () => {
    expect(await readRelationsBranch(async () => null, { scope: { sourceId: id(5) } })).toBeNull();
  });

  it("never lets an answer out of its shape", async () => {
    const tooMany = { ...read, nodes: Array.from({ length: 401 }, () => read.nodes[0]!) };
    await expect(
      readRelationsBranch(async () => tooMany, { scope: { topicId: id(1) } })
    ).rejects.toThrow();
    const badColour = { ...read, topics: [{ ...read.topics[0]!, colourIndex: 12 }] };
    await expect(
      readRelationsBranch(async () => badColour, { scope: { topicId: id(1) } })
    ).rejects.toThrow();
  });

  it("fails while the library's database is not ready", () => {
    expect(() =>
      relationsBranchReader(() => null)({
        scope: { topicId: id(1) },
        colourDepth: 1,
        noteLimit: 1,
        perTopicLimit: 1,
        relationLimit: 1
      })
    ).toThrow("objects.errors.unavailable");
  });
});

describe("registerRelationsBranchIpc", () => {
  it("answers the area's one channel through the handler, validated both ways", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipc = {
      handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
        handlers.set(channel, handler)
    } as unknown as IpcMain;
    const reader = vi.fn<RelationsBranchReader>(async () => read);
    registerRelationsBranchIpc(ipc, reader);
    expect([...handlers.keys()]).toEqual([relationsBranchChannels.branch]);
    const handle = handlers.get(relationsBranchChannels.branch)!;

    const answer = (await handle({}, { scope: { sourceId: id(5) }, colourDepth: 2 })) as {
      edges: { stance: string }[];
    };
    expect(reader).toHaveBeenCalledWith({
      scope: { sourceId: id(5) },
      colourDepth: 2,
      noteLimit: 400,
      perTopicLimit: 80,
      relationLimit: 2000
    });
    expect(answer.edges[0]?.stance).toBe("contradicts");
    await expect(handle({}, { scope: { sourceId: "x" } })).rejects.toThrow();
    expect(reader).toHaveBeenCalledTimes(1);
  });
});

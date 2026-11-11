import { describe, expect, it, vi } from "vitest";

import { relationsBranchChannels } from "../shared/ipc-relations-branch.js";
import { createRelationsBranchApi } from "./relations-branch-api.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const answer = {
  topics: [{ id: id(1), title: "Sleep", colourIndex: 0, parentId: null, noteCount: 1 }],
  nodes: [{ id: id(10), title: "Naps", topicId: id(1), degree: 0 }],
  edges: [],
  outside: [],
  superEdges: [],
  truncated: false
};

describe("createRelationsBranchApi", () => {
  it("sends a request with its bounds filled in and hands the page a validated answer", async () => {
    const invoke = vi.fn(async () => answer);
    const api = createRelationsBranchApi({ invoke });
    expect(await api.branch({ scope: { topicId: id(1) }, noteLimit: 50 })).toEqual(answer);
    expect(invoke).toHaveBeenCalledWith(relationsBranchChannels.branch, {
      scope: { topicId: id(1) },
      colourDepth: 1,
      noteLimit: 50,
      perTopicLimit: 80,
      relationLimit: 2000
    });
  });

  it("passes null through for a scope that does not exist", async () => {
    const api = createRelationsBranchApi({ invoke: async () => null });
    expect(await api.branch({ scope: { sourceId: id(5) } })).toBeNull();
  });

  it("refuses a bad request before it leaves and a bad answer before the page sees it", async () => {
    const invoke = vi.fn(async () => answer);
    const api = createRelationsBranchApi({ invoke });
    await expect(api.branch({ scope: { topicId: "x" } })).rejects.toThrow();
    await expect(api.branch({ scope: { topicId: id(1) }, relationLimit: 2001 })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    const forged = createRelationsBranchApi({
      invoke: async () => ({ ...answer, truncated: "no" })
    });
    await expect(forged.branch({ scope: { topicId: id(1) } })).rejects.toThrow();
  });
});

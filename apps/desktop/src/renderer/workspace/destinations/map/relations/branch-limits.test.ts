import { describe, expect, it } from "vitest";

import { branchListCaps } from "./branch-model";

const reads = import.meta.glob<string>(
  "../../../../../../../../packages/db/src/repositories/relationBranchRepository.ts",
  { query: "?raw", import: "default", eager: true }
);

describe("the list caps of the branch read", () => {
  it("name the caps the read model applies, so a list at its cap is told apart from a short one", () => {
    const text = Object.values(reads)[0];
    expect(text).toBeDefined();
    expect(text).toContain(`outsideMax: ${branchListCaps.outside},`);
    expect(text).toContain(`superEdgeMax: ${branchListCaps.superEdges},`);
  });
});

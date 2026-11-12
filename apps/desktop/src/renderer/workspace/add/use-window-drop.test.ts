import { describe, expect, it } from "vitest";

import { dragCarriesFiles, dragFileCount } from "./use-window-drop";

describe("a drag over the window", () => {
  it("is ours only when it carries files", () => {
    expect(dragCarriesFiles({ types: ["Files"] })).toBe(true);
    expect(dragCarriesFiles({ types: ["text/plain", "Files"] })).toBe(true);
    expect(dragCarriesFiles({ types: ["text/plain", "text/uri-list"] })).toBe(false);
    expect(dragCarriesFiles(null)).toBe(false);
  });

  it("counts the files and not the other items", () => {
    const items = [{ kind: "file" }, { kind: "string" }, { kind: "file" }] as DataTransferItem[];
    expect(dragFileCount({ items: items as unknown as DataTransferItemList })).toBe(2);
    expect(dragFileCount(null)).toBe(0);
  });
});

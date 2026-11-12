import { describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../../shared/ipc";
import { readBacklinks } from "./context-reads";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (via: string, n: number) => ({ from: `memora://note/${uuid(n)}`, via });

function appWith(pages: { items: unknown[]; next?: string }[]) {
  let at = 0;
  const backlinks = vi.fn(async () => pages[at++] ?? { items: [] });
  return { app: { objects: { backlinks } } as unknown as DesktopApi, backlinks };
}

describe("reading backlinks for a tab", () => {
  it("keeps the arms the tab shows and the cursor of the next page", async () => {
    // A page with fewer than twenty wanted items goes on, so give it a second, last page.
    const { app: two } = appWith([
      { items: [item("mention", 1), item("relation", 2)], next: "c2" },
      { items: [item("mention", 3)] }
    ]);
    const page = await readBacklinks(two, "memora://entity/x", ["mention"], null);
    expect(page.items.map((entry) => entry.from)).toEqual([
      `memora://note/${uuid(1)}`,
      `memora://note/${uuid(3)}`
    ]);
    expect(page.next).toBeNull();
  });

  it("skips the arms before the one it shows, a few requests at most", async () => {
    const full = (arm: string) => ({
      items: Array.from({ length: 50 }, (_, n) => item(arm, n + 1)),
      next: "more"
    });
    const { app, backlinks } = appWith([
      full("relation"),
      full("relation"),
      { items: [item("overview_citation", 900)] }
    ]);
    const page = await readBacklinks(app, "memora://note/x", ["overview_citation"], null);
    expect(page.items).toHaveLength(1);
    expect(backlinks).toHaveBeenCalledTimes(3);
    expect(page.next).toBeNull();
  });

  it("stops after six requests when nothing it shows turns up", async () => {
    const { app, backlinks } = appWith(
      Array.from({ length: 10 }, () => ({ items: [item("relation", 1)], next: "more" }))
    );
    const page = await readBacklinks(app, "memora://note/x", ["question_citation"], null);
    expect(page.items).toEqual([]);
    expect(backlinks).toHaveBeenCalledTimes(6);
    expect(page.next).toBe("more");
  });

  it("starts from the cursor it is given", async () => {
    const { app, backlinks } = appWith([{ items: [item("mention", 1)] }]);
    await readBacklinks(app, "memora://entity/x", ["mention"], "abc");
    expect(backlinks).toHaveBeenCalledWith({
      address: "memora://entity/x",
      limit: 50,
      cursor: "abc"
    });
  });
});

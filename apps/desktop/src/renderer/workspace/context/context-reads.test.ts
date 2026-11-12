import { describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../../shared/ipc";
import { createResolveBook, readBacklinks, resolveBatches } from "./context-reads";

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

describe("the book of addresses asked for their summaries", () => {
  it("asks an address once when the effect runs, is cleaned up and runs again", () => {
    // StrictMode in development: setup, cleanup, setup, with the refs kept.
    const book = createResolveBook();
    expect(book.take(["a", "b"], "0|true")).toEqual(["a", "b"]);
    expect(book.take(["a", "b"], "0|true")).toEqual([]);
  });

  it("asks only the addresses a longer list adds while the first batch is in flight", () => {
    const book = createResolveBook();
    book.take(["a", "b"], "0|true");
    expect(book.take(["a", "b", "c"], "0|true")).toEqual(["c"]);
  });

  it("asks everything again after a change, or for another kind of answer", () => {
    const book = createResolveBook();
    book.take(["a"], "0|true");
    expect(book.take(["a"], "1|true")).toEqual(["a"]);
    expect(book.take(["a"], "1|false")).toEqual(["a"]);
  });

  it("lets a failed batch be asked again", () => {
    const book = createResolveBook();
    book.take(["a", "b"], "0|true");
    book.release(["a"]);
    expect(book.take(["a", "b"], "0|true")).toEqual(["a"]);
  });

  it("cuts a long list into requests of at most 200", () => {
    const addresses = Array.from({ length: 450 }, (_, n) => `a${n}`);
    expect(resolveBatches(addresses).map((batch) => batch.length)).toEqual([200, 200, 50]);
    expect(resolveBatches([])).toEqual([]);
  });
});

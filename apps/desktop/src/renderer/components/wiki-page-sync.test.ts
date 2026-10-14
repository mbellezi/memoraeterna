import { describe, expect, it } from "vitest";

import type { WikiResolvedLinks } from "../../shared/ipc";
import {
  createWikiPageSync,
  currentWikiPageLinks,
  emptyWikiPageLinks,
  lookupWikiLink,
  wikiLinkFetchMode,
  wikiLinkRetryBackoff,
  wikiLinkRetryDelayMs,
  wikiLinkSetKey,
  wikiLinkValueToShow,
  wikiPageLinksFromResolved,
  type WikiLinkedTargetValue,
  type WikiPageLinks,
  type WikiPageSyncClient
} from "./wiki-page-sync";

const pageId = "00000000-0000-4000-8000-000000000001";
const revisionOne = "00000000-0000-4000-8000-0000000000a1";
const revisionTwo = "00000000-0000-4000-8000-0000000000a2";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface TestPage {
  id: string;
  revisionId: string;
  evidence: Array<{ id: string; current: boolean; sourceAvailable?: boolean }>;
  impacts: string[];
  links: Array<{ kind: "atomic_note"; id: string }>;
}

function page(overrides: Partial<TestPage> = {}): TestPage {
  return {
    id: pageId,
    revisionId: revisionOne,
    evidence: [{ id: uuid(900), current: true, sourceAvailable: true }],
    impacts: [],
    links: Array.from({ length: 200 }, (_, index) => ({
      kind: "atomic_note" as const,
      id: uuid(1000 + index)
    })),
    ...overrides
  };
}

function resolved(current: TestPage, failedCount = 0): WikiResolvedLinks {
  const links = current.links.map((link) => ({
    kind: link.kind,
    id: link.id,
    title: `Note ${link.id}`,
    markdown: "Body",
    sourceItemId: null,
    evidence: []
  }));
  return {
    pageId: current.id,
    revisionId: current.revisionId,
    targets: links.slice(failedCount),
    unresolved: [],
    failed: links.slice(0, failedCount).map(({ kind, id }) => ({ kind, id }))
  };
}

/** A fake IPC surface that counts every request, as the real preload bridge would. */
function fakeClient(initial: TestPage) {
  const state = { page: initial, failResolve: 0, failedLinks: 0 };
  const calls = { get: 0, resolveLinks: 0 };
  const client: WikiPageSyncClient<TestPage> = {
    async get() {
      calls.get += 1;
      return structuredClone(state.page);
    },
    async resolveLinks() {
      calls.resolveLinks += 1;
      if (state.failResolve > 0) {
        state.failResolve -= 1;
        throw new Error("unavailable");
      }
      return resolved(state.page, state.failedLinks);
    }
  };
  return { client, calls, state };
}

function sink() {
  const events: Array<{ type: "page" | "links"; value: unknown }> = [];
  let live = true;
  return {
    events,
    stop: () => {
      live = false;
    },
    handlers: {
      isLive: () => live,
      onPage: (value: TestPage) => events.push({ type: "page", value }),
      onLinks: (value: WikiPageLinks) => events.push({ type: "links", value })
    }
  };
}

describe("wiki reading page poll", () => {
  it("makes at most two requests per cycle for a 200-link page and one when nothing changed", async () => {
    const { client, calls } = fakeClient(page());
    const output = sink();
    const sync = createWikiPageSync(client, page());
    const perCycle: number[] = [];

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const before = calls.get + calls.resolveLinks;
      await sync.cycle(pageId, undefined, output.handlers);
      perCycle.push(calls.get + calls.resolveLinks - before);
    }

    // The first cycle reads the page and resolves its 200 links once; later cycles only re-read.
    expect(perCycle).toEqual([2, 1, 1, 1, 1]);
    expect(Math.max(...perCycle)).toBeLessThanOrEqual(2);
    expect(calls.resolveLinks).toBe(1);
    const links = output.events.filter((event) => event.type === "links");
    expect(links).toHaveLength(1);
    expect((links[0]!.value as WikiPageLinks).targets.size).toBe(200);
    // An unchanged page is neither re-rendered nor re-resolved.
    expect(output.events.filter((event) => event.type === "page")).toHaveLength(0);
  });

  it("resolves the links again only when the revision or the evidence currency changes", async () => {
    const { client, calls, state } = fakeClient(page());
    const output = sink();
    const sync = createWikiPageSync(client, page());
    await sync.cycle(pageId, undefined, output.handlers);
    expect(calls.resolveLinks).toBe(1);

    // Content-only change (impacts) re-renders the page but the links do not depend on it.
    state.page = page({ impacts: ["stale"] });
    await sync.cycle(pageId, undefined, output.handlers);
    expect(calls.resolveLinks).toBe(1);
    expect(output.events.filter((event) => event.type === "page")).toHaveLength(1);

    state.page = page({ impacts: ["stale"], evidence: [{ id: uuid(900), current: false }] });
    await sync.cycle(pageId, undefined, output.handlers);
    expect(calls.resolveLinks).toBe(2);

    state.page = page({ revisionId: revisionTwo, evidence: [{ id: uuid(900), current: false }] });
    const before = calls.get + calls.resolveLinks;
    await sync.cycle(pageId, undefined, output.handlers);
    expect(calls.get + calls.resolveLinks - before).toBe(2);
    expect(calls.resolveLinks).toBe(3);
  });

  it("keeps the last targets when a resolution fails and retries on the next cycle", async () => {
    const { client, calls, state } = fakeClient(page());
    const output = sink();
    let now = 0;
    const sync = createWikiPageSync(client, page(), () => now);
    await sync.cycle(pageId, undefined, output.handlers);

    state.page = page({ revisionId: revisionTwo });
    state.failResolve = 1;
    await sync.cycle(pageId, undefined, output.handlers);
    const failed = output.events.at(-1)!.value as WikiPageLinks;
    expect(failed.status).toBe("error");
    expect(failed.revisionId).toBe(revisionTwo);
    expect(failed.targets.size).toBe(200);

    now += wikiLinkRetryDelayMs(1);
    await sync.cycle(pageId, undefined, output.handlers);
    expect((output.events.at(-1)!.value as WikiPageLinks).status).toBe("ready");
    expect(calls.resolveLinks).toBe(3);
  });

  it("skips a cycle that starts while the previous one is still resolving", async () => {
    const { client, calls } = fakeClient(page());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolveLinks = client.resolveLinks;
    client.resolveLinks = async (...args) => {
      await gate;
      return resolveLinks(...args);
    };
    const output = sink();
    const sync = createWikiPageSync(client, page());

    const first = sync.cycle(pageId, undefined, output.handlers);
    const second = sync.cycle(pageId, undefined, output.handlers);
    release();
    await Promise.all([first, second]);

    expect(calls.get).toBe(1);
    expect(calls.resolveLinks).toBe(1);
  });

  it("ignores results once the poll is no longer live", async () => {
    const { client } = fakeClient(page({ revisionId: revisionTwo }));
    const output = sink();
    const sync = createWikiPageSync(client, page());
    output.stop();
    await sync.cycle(pageId, undefined, output.handlers);
    expect(output.events).toHaveLength(0);
  });

  it("backs off with a capped exponential delay instead of resolving again every cycle", async () => {
    const { client, calls, state } = fakeClient(page());
    state.failResolve = Number.POSITIVE_INFINITY;
    const output = sink();
    let now = 0;
    const sync = createWikiPageSync(client, page(), () => now);
    const attempts: number[] = [];
    // One poll cycle every 3 s for ten minutes of an unavailable resolver.
    for (let tick = 0; tick < 200; tick += 1) {
      const before = calls.resolveLinks;
      await sync.cycle(pageId, undefined, output.handlers);
      if (calls.resolveLinks > before) attempts.push(now);
      now += 3_000;
    }
    // Failures are spaced 3 s, 6 s, 12 s, ... and then never closer than the cap.
    const gaps = attempts.slice(1).map((time, index) => time - attempts[index]!);
    expect(gaps.slice(0, 5)).toEqual([3_000, 6_000, 12_000, 24_000, 48_000]);
    expect(Math.max(...gaps)).toBe(wikiLinkRetryBackoff.maxMs);
    expect(gaps.slice(5).every((gap) => gap === wikiLinkRetryBackoff.maxMs)).toBe(true);
    expect(calls.resolveLinks).toBeLessThan(20);
    expect((output.events.at(-1)!.value as WikiPageLinks).status).toBe("error");

    // Recovery resolves once, clears the backoff and then stops asking.
    state.failResolve = 0;
    now += wikiLinkRetryBackoff.maxMs;
    await sync.cycle(pageId, undefined, output.handlers);
    expect((output.events.at(-1)!.value as WikiPageLinks).status).toBe("ready");
    const after = calls.resolveLinks;
    await sync.cycle(pageId, undefined, output.handlers);
    expect(calls.resolveLinks).toBe(after);
  });

  it("treats links that failed to resolve as a failure to retry, keeping the others", async () => {
    const { client, calls, state } = fakeClient(page());
    state.failedLinks = 3;
    const output = sink();
    let now = 0;
    const sync = createWikiPageSync(client, page(), () => now);
    await sync.cycle(pageId, undefined, output.handlers);
    const partial = output.events.at(-1)!.value as WikiPageLinks;
    expect(partial.status).toBe("ready");
    expect(partial.targets.size).toBe(197);
    expect(partial.failed.size).toBe(3);
    // The failed links read as retryable, never as missing.
    const failedLink = { kind: "atomic_note", id: uuid(1000) };
    expect(lookupWikiLink(partial, pageId, revisionOne, failedLink)).toEqual({ kind: "failed" });

    // Backing off: the next cycle does not ask again, a later one does and completes the set.
    await sync.cycle(pageId, undefined, output.handlers);
    expect(calls.resolveLinks).toBe(1);
    state.failedLinks = 0;
    now += wikiLinkRetryDelayMs(1);
    await sync.cycle(pageId, undefined, output.handlers);
    expect(calls.resolveLinks).toBe(2);
    expect((output.events.at(-1)!.value as WikiPageLinks).failed.size).toBe(0);
    await sync.cycle(pageId, undefined, output.handlers);
    expect(calls.resolveLinks).toBe(2);
  });

  it("resolves an earlier link set again when a later one failed and the page went back", async () => {
    const { client, calls, state } = fakeClient(page());
    const output = sink();
    const sync = createWikiPageSync(client, page(), () => 0);
    await sync.cycle(pageId, undefined, output.handlers);
    state.page = page({ revisionId: revisionTwo });
    state.failResolve = 1;
    await sync.cycle(pageId, undefined, output.handlers);
    expect((output.events.at(-1)!.value as WikiPageLinks).status).toBe("error");

    // Back on the first set, which is no longer what is shown: it is resolved, not assumed.
    state.page = page();
    await sync.cycle(pageId, undefined, output.handlers);
    expect(calls.resolveLinks).toBe(3);
    expect((output.events.at(-1)!.value as WikiPageLinks).status).toBe("ready");
  });

  it("resolves a new revision at once even while the previous one is backing off", async () => {
    const { client, calls, state } = fakeClient(page());
    state.failResolve = 1;
    const output = sink();
    const sync = createWikiPageSync(client, page(), () => 0);
    await sync.cycle(pageId, undefined, output.handlers);
    await sync.cycle(pageId, undefined, output.handlers);
    expect(calls.resolveLinks).toBe(1);

    state.page = page({ revisionId: revisionTwo });
    await sync.cycle(pageId, undefined, output.handlers);
    expect(calls.resolveLinks).toBe(2);
    expect((output.events.at(-1)!.value as WikiPageLinks).status).toBe("ready");
  });

  it("keys the link set on revision and evidence currency only", () => {
    expect(wikiLinkSetKey(page())).toBe(wikiLinkSetKey(page({ impacts: ["x"] })));
    expect(wikiLinkSetKey(page())).not.toBe(
      wikiLinkSetKey(page({ evidence: [{ id: uuid(900), current: false }] }))
    );
  });
});

describe("wiki link lookup", () => {
  const target = { kind: "atomic_note", id: uuid(1000) };
  const value: WikiLinkedTargetValue = {
    kind: "atomic_note",
    id: target.id,
    title: "Note",
    markdown: "Body",
    sourceItemId: null,
    evidence: []
  };
  const ready = wikiPageLinksFromResolved({
    pageId,
    revisionId: revisionOne,
    targets: [value],
    unresolved: [{ kind: "source", id: uuid(2000) }],
    failed: [{ kind: "page", id: uuid(3000) }]
  });

  it("serves listed links from the batch without an individual request", () => {
    expect(lookupWikiLink(ready, pageId, revisionOne, target)).toEqual({ kind: "value", value });
    expect(lookupWikiLink(ready, pageId, revisionOne, { kind: "source", id: uuid(2000) })).toEqual({
      kind: "missing"
    });
  });

  it("falls back to an individual request only for links the batch cannot know", () => {
    expect(
      lookupWikiLink(ready, pageId, revisionOne, { kind: "atomic_note", id: uuid(7) })
    ).toEqual({ kind: "fetch" });
    expect(lookupWikiLink(null, pageId, revisionOne, target)).toEqual({ kind: "fetch" });
    expect(lookupWikiLink(ready, uuid(5), revisionOne, target)).toEqual({ kind: "fetch" });
    expect(lookupWikiLink(ready, pageId, undefined, target)).toEqual({ kind: "fetch" });
  });

  it("reports pending and failed batches instead of requesting links one by one", () => {
    const loading = emptyWikiPageLinks({ id: pageId, revisionId: revisionOne });
    expect(lookupWikiLink(loading, pageId, revisionOne, target)).toEqual({ kind: "pending" });
    expect(lookupWikiLink({ ...loading, status: "error" }, pageId, revisionOne, target)).toEqual({
      kind: "failed"
    });
  });

  it("keeps showing the previous targets while a new revision is resolved", () => {
    const next = currentWikiPageLinks(ready, { id: pageId, revisionId: revisionTwo })!;
    expect(next.status).toBe("loading");
    expect(lookupWikiLink(next, pageId, revisionTwo, target)).toEqual({ kind: "value", value });
    expect(lookupWikiLink(next, pageId, revisionTwo, { kind: "atomic_note", id: uuid(7) })).toEqual(
      { kind: "pending" }
    );
    expect(
      currentWikiPageLinks(ready, { id: uuid(6), revisionId: revisionOne })!.targets.size
    ).toBe(0);
    expect(currentWikiPageLinks(ready, null)).toBeNull();
  });
});

describe("opened note cards", () => {
  const noteTarget = { kind: "atomic_note", id: uuid(1000) };
  const batch: WikiLinkedTargetValue = {
    kind: "atomic_note",
    id: noteTarget.id,
    title: "Old title",
    markdown: "Old text",
    sourceItemId: null,
    evidence: []
  };
  const fresh: WikiLinkedTargetValue = {
    ...batch,
    title: "New title",
    markdown: "Edited text",
    noteState: { status: "approved", protected: true, current: false },
    successors: [{ id: uuid(1001), title: "Successor" }]
  };
  const ready = wikiPageLinksFromResolved({
    pageId,
    revisionId: revisionOne,
    targets: [batch],
    unresolved: [],
    failed: []
  });
  const served = lookupWikiLink(ready, pageId, revisionOne, noteTarget);

  it("reads a note served by the batch again when it is opened, and not before", () => {
    expect(wikiLinkFetchMode(served, "atomic_note", false)).toBe("none");
    expect(wikiLinkFetchMode(served, "atomic_note", true)).toBe("refresh");
    // Only note cards expand; other kinds keep the batch value.
    expect(wikiLinkFetchMode(served, "source", true)).toBe("none");
  });

  it("shows the fresh read over the batch value once it arrives", () => {
    expect(wikiLinkValueToShow(served, undefined, "refresh")).toBe(batch);
    expect(wikiLinkValueToShow(served, fresh, "refresh")).toBe(fresh);
    const shown = wikiLinkValueToShow(served, fresh, "refresh")!;
    expect(shown.noteState).toEqual({ status: "approved", protected: true, current: false });
    expect(shown.successors).toEqual([{ id: uuid(1001), title: "Successor" }]);
    // A collapsed card has no refresh in flight, so a read left over from before never wins.
    expect(wikiLinkValueToShow(served, fresh, "none")).toBe(batch);
  });

  it("stops showing a note whose own read finds it gone since the batch", () => {
    // Archived or discarded after the revision was resolved: the read returns nothing.
    expect(wikiLinkValueToShow(served, null, "refresh")).toBeNull();
  });

  it("still reads a link the batch cannot know individually", () => {
    const unknown = lookupWikiLink(ready, pageId, revisionOne, {
      kind: "atomic_note",
      id: uuid(7)
    });
    expect(wikiLinkFetchMode(unknown, "atomic_note", false)).toBe("individual");
    expect(wikiLinkValueToShow(unknown, fresh, "individual")).toBe(fresh);
    expect(wikiLinkValueToShow(unknown, null, "individual")).toBeNull();
  });

  it("never reads while the batch is pending or failed", () => {
    const loading = emptyWikiPageLinks({ id: pageId, revisionId: revisionOne });
    for (const links of [loading, { ...loading, status: "error" as const }]) {
      const lookup = lookupWikiLink(links, pageId, revisionOne, noteTarget);
      expect(wikiLinkFetchMode(lookup, "atomic_note", true)).toBe("none");
      expect(wikiLinkValueToShow(lookup, fresh, "none")).toBeNull();
    }
  });
});

describe("link retry backoff", () => {
  it("doubles from the poll interval up to a cap", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(wikiLinkRetryDelayMs)).toEqual([
      3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000, 60_000
    ]);
  });
});

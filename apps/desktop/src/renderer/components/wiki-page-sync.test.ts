import { describe, expect, it } from "vitest";

import type { WikiResolvedLinks } from "../../shared/ipc";
import {
  createWikiPageSync,
  currentWikiPageLinks,
  emptyWikiPageLinks,
  lookupWikiLink,
  wikiLinkSetKey,
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

function resolved(current: TestPage): WikiResolvedLinks {
  return {
    pageId: current.id,
    revisionId: current.revisionId,
    targets: current.links.map((link) => ({
      kind: link.kind,
      id: link.id,
      title: `Note ${link.id}`,
      markdown: "Body",
      sourceItemId: null,
      evidence: []
    })),
    unresolved: []
  };
}

/** A fake IPC surface that counts every request, as the real preload bridge would. */
function fakeClient(initial: TestPage) {
  const state = { page: initial, failResolve: 0 };
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
      return resolved(state.page);
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
    const sync = createWikiPageSync(client, page());
    await sync.cycle(pageId, undefined, output.handlers);

    state.page = page({ revisionId: revisionTwo });
    state.failResolve = 1;
    await sync.cycle(pageId, undefined, output.handlers);
    const failed = output.events.at(-1)!.value as WikiPageLinks;
    expect(failed.status).toBe("error");
    expect(failed.revisionId).toBe(revisionTwo);
    expect(failed.targets.size).toBe(200);

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
    unresolved: [{ kind: "source", id: uuid(2000) }]
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

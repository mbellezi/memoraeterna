import { createContext } from "react";
import type { z } from "zod";
import type { WikiLinkedTargetSchema } from "@app/domain";

import type { WikiResolvedLinks } from "../../shared/ipc";

export type WikiLinkedTargetValue = z.infer<typeof WikiLinkedTargetSchema>;

export const wikiLinkKey = (target: { kind: string; id: string }) => `${target.kind}:${target.id}`;

/** Every link of one page revision, resolved with a single request. */
export interface WikiPageLinks {
  pageId: string;
  revisionId: string;
  status: "loading" | "ready" | "error";
  targets: ReadonlyMap<string, WikiLinkedTargetValue>;
  unresolved: ReadonlySet<string>;
  /** Asks the page poll to resolve the links again. */
  retry?: () => void;
}

export const WikiPageLinksContext = createContext<WikiPageLinks | null>(null);

export type WikiLinkLookup =
  | { kind: "value"; value: WikiLinkedTargetValue }
  | { kind: "missing" }
  | { kind: "pending" }
  | { kind: "failed" }
  | { kind: "fetch" };

/**
 * Decides where a link gets its target: the page's batch when it covers the link, otherwise an
 * individual request (links the batch cannot know, such as successors of an opened note).
 */
export function lookupWikiLink(
  links: WikiPageLinks | null,
  pageId: string,
  revisionId: string | undefined,
  target: { kind: string; id: string }
): WikiLinkLookup {
  if (
    !links ||
    links.pageId !== pageId ||
    revisionId === undefined ||
    links.revisionId !== revisionId
  )
    return { kind: "fetch" };
  const key = wikiLinkKey(target);
  const value = links.targets.get(key);
  if (value) return { kind: "value", value };
  if (links.status === "loading") return { kind: "pending" };
  if (links.status === "error") return { kind: "failed" };
  return links.unresolved.has(key) ? { kind: "missing" } : { kind: "fetch" };
}

export function emptyWikiPageLinks(
  page: { id: string; revisionId: string },
  status: WikiPageLinks["status"] = "loading"
): WikiPageLinks {
  return {
    pageId: page.id,
    revisionId: page.revisionId,
    status,
    targets: new Map(),
    unresolved: new Set()
  };
}

export function wikiPageLinksFromResolved(resolved: WikiResolvedLinks): WikiPageLinks {
  return {
    pageId: resolved.pageId,
    revisionId: resolved.revisionId,
    status: "ready",
    targets: new Map(resolved.targets.map((target) => [wikiLinkKey(target), target])),
    unresolved: new Set(resolved.unresolved.map(wikiLinkKey))
  };
}

/** Links shown for the visible revision; a revision still being resolved keeps the last targets. */
export function currentWikiPageLinks(
  links: WikiPageLinks | null,
  page: { id: string; revisionId: string } | null
): WikiPageLinks | null {
  if (!page) return null;
  if (!links || links.pageId !== page.id) return emptyWikiPageLinks(page);
  return links.revisionId === page.revisionId
    ? links
    : { ...links, revisionId: page.revisionId, status: "loading" };
}

interface SyncPage {
  id: string;
  revisionId: string;
  evidence: ReadonlyArray<{ id: string; current: boolean; sourceAvailable?: boolean | undefined }>;
}

/** The whole page: any visible change (content, impacts, evidence currency) differs. */
export const wikiPageSnapshotKey = (page: unknown) => JSON.stringify(page);

/**
 * What the batch of links depends on. Link targets only change with the revision or when the
 * currency of its evidence flips, so an unchanged key needs no new resolution.
 */
export function wikiLinkSetKey(page: SyncPage): string {
  return [
    page.revisionId,
    ...page.evidence.map(
      (item) => `${item.id}:${item.current ? 1 : 0}:${item.sourceAvailable === false ? 0 : 1}`
    )
  ].join("|");
}

export interface WikiPageSyncClient<Page extends SyncPage> {
  get: (id: string, revisionId?: string) => Promise<Page | null>;
  resolveLinks: (pageId: string, revisionId?: string) => Promise<WikiResolvedLinks | null>;
}

export interface WikiPageSyncSink<Page extends SyncPage> {
  isLive: () => boolean;
  onPage: (page: Page) => void;
  onLinks: (links: WikiPageLinks) => void;
}

/**
 * One reading-page poll. A cycle reads the page once and resolves its links only when the revision
 * or evidence currency changed, so a page with hundreds of links costs one request per cycle and a
 * second only when something changed. An unchanged page causes no render.
 */
export function createWikiPageSync<Page extends SyncPage>(
  client: WikiPageSyncClient<Page>,
  shown: Page | null
) {
  let pageKey = shown ? wikiPageSnapshotKey(shown) : null;
  let linkKey: string | null = null;
  let lastLinks: WikiPageLinks | null = null;
  let running = false;
  async function run(
    id: string,
    historicalRevision: string | undefined,
    sink: WikiPageSyncSink<Page>
  ): Promise<void> {
    const next = await client.get(id, historicalRevision);
    if (!next || !sink.isLive()) return;
    const nextPageKey = wikiPageSnapshotKey(next);
    if (nextPageKey !== pageKey) {
      pageKey = nextPageKey;
      sink.onPage(next);
    }
    const nextLinkKey = wikiLinkSetKey(next);
    if (nextLinkKey === linkKey) return;
    let links: WikiPageLinks;
    try {
      const resolved = await client.resolveLinks(next.id, next.revisionId);
      if (!sink.isLive()) return;
      if (resolved) {
        linkKey = nextLinkKey;
        links = wikiPageLinksFromResolved(resolved);
      } else links = failedLinks(lastLinks, next);
    } catch {
      if (!sink.isLive()) return;
      links = failedLinks(lastLinks, next);
    }
    lastLinks = links;
    sink.onLinks(links);
  }
  return {
    /** A cycle that starts while the previous one is still running does nothing. */
    async cycle(
      id: string,
      historicalRevision: string | undefined,
      sink: WikiPageSyncSink<Page>
    ): Promise<void> {
      if (running) return;
      running = true;
      try {
        await run(id, historicalRevision, sink);
      } finally {
        running = false;
      }
    }
  };
}

/** A failed resolution keeps the last known targets of the same page and is retried next cycle. */
function failedLinks(previous: WikiPageLinks | null, page: SyncPage): WikiPageLinks {
  const base =
    previous && previous.pageId === page.id ? previous : emptyWikiPageLinks(page, "error");
  return { ...base, revisionId: page.revisionId, status: "error" };
}

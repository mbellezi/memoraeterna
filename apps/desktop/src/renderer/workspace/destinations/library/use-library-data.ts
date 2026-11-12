import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatObjectAddress, type ObjectKind } from "@app/domain";

import type { LibraryRow } from "../../../../shared/ipc-library";
import type { QuestionListItemView } from "../../../../shared/ipc-questions";
import { useObjectKindChanged, watchObject, type ObjectState } from "../../../lib/object-events";
import type { LibraryQuery } from "../../route";
import {
  facetKey,
  libraryPaging,
  queryKey,
  questionsInput,
  rowsInput,
  scopeTopicIds,
  type LibraryFacets
} from "./library-model";
import { createPagedList, initialPagedState, type PageSource, type PagedState } from "./paged-list";

/**
 * The Library's data (spec T149): the sources through `library.rows`, the questions through
 * `questions.list`, both as paged lists that read again after `object.changed` of their kind. A
 * hidden Library (`active` false) reads nothing and listens to nothing; shown again it reads in
 * place when its last read worked, and a failed read stays on screen with its retry
 * (`rules/frontend.md`). There is no timer that polls: the only timers settle typing and clicks
 * (`libraryPaging.settleMs`) and gather a burst of changes into one re-read.
 */

const sourceChanges: readonly ObjectKind[] = ["source"];
const questionChanges: readonly ObjectKind[] = ["question"];
const topicChanges: readonly ObjectKind[] = ["topic"];

function sourcesSource(query: LibraryQuery): PageSource<LibraryRow, LibraryFacets> {
  return {
    async read({ cursor, limit, facets }) {
      const result = await window.app.library.rows(rowsInput(query, { cursor, limit, facets }));
      return {
        items: result.rows,
        next: result.next,
        total: result.total,
        facets: result.facets
      };
    }
  };
}

function questionsSource(text: string | undefined): PageSource<QuestionListItemView, never> {
  return {
    async read({ cursor, limit }) {
      const result = await window.app.questions.list(questionsInput(text, { cursor, limit }));
      return { items: result.items, next: result.next };
    }
  };
}

export interface PagedData<Item, Facets> {
  state: PagedState<Item, Facets>;
  more: () => void;
  retry: () => void;
}

interface PagedConfig<Item, Facets> {
  /** Identifies the rows: a change starts the list from its first page. */
  key: string;
  /** Identifies the counts: a change asks for them again. */
  facetKey: string;
  /** The most rows one request of this source may ask for. */
  refreshPage: number;
  source: () => PageSource<Item, Facets>;
  itemKey: (item: Item) => string;
  kinds: readonly ObjectKind[];
  active: boolean;
}

function usePagedData<Item, Facets>(config: PagedConfig<Item, Facets>): PagedData<Item, Facets> {
  const [state, setState] = useState<PagedState<Item, Facets>>(
    initialPagedState as PagedState<Item, Facets>
  );
  const latest = useRef(config);
  // The identity of a row is the same function for the life of the list.
  const [list] = useState(() => {
    return createPagedList<Item, Facets>({
      pageSize: libraryPaging.pageSize,
      refreshCap: libraryPaging.refreshCap,
      refreshDelayMs: libraryPaging.refreshDelayMs,
      refreshPage: config.refreshPage,
      key: config.itemKey,
      onChange: setState
    });
  });
  useEffect(() => {
    latest.current = config;
  });
  // What the last read was for: the first read starts at once, later ones wait for the typing to settle.
  const read = useRef<{ key: string; facetKey: string } | null>(null);

  // React (development) runs a setup, a cleanup and a setup again on the state it keeps: the list
  // wakes up again, and what the first setup read is read again.
  useEffect(() => {
    list.resume();
    return () => {
      list.dispose();
      read.current = null;
    };
  }, [list]);

  useEffect(() => {
    if (!config.active) return undefined;
    const before = read.current;
    if (before !== null && before.key === config.key) {
      // Shown again with the same query: read in place after a good read; a failed one stays.
      if (list.getState().status === "ready") list.refresh();
      return undefined;
    }
    const start = () => {
      const asked = latest.current;
      const facets =
        before === null || before.facetKey !== asked.facetKey || list.getState().facets === null;
      read.current = { key: asked.key, facetKey: asked.facetKey };
      list.load(asked.source(), { facets });
    };
    if (before === null) {
      start();
      return undefined;
    }
    const timer = setTimeout(start, libraryPaging.settleMs);
    return () => clearTimeout(timer);
    // The query's key is the whole dependency: the source is built from the latest config.
  }, [config.active, config.key, list]);

  useObjectKindChanged(config.kinds, () => list.refresh(), config.active);

  const more = useCallback(() => list.more(), [list]);
  const retry = useCallback(() => list.retry(), [list]);
  return { state, more, retry };
}

/** The Fontes tab: the sources of the query, with the counts of the chips and the territory bar. */
export function useLibrarySources(
  query: LibraryQuery,
  active: boolean
): PagedData<LibraryRow, LibraryFacets> {
  return usePagedData<LibraryRow, LibraryFacets>({
    key: queryKey(query),
    facetKey: facetKey(query),
    refreshPage: libraryPaging.refreshPages.sources,
    source: () => sourcesSource(query),
    itemKey: (row) => row.id,
    kinds: sourceChanges,
    active
  });
}

/** The Perguntas tab: the saved questions, newest first, filtered by their words. */
export function useLibraryQuestions(
  text: string | undefined,
  active: boolean
): PagedData<QuestionListItemView, never> {
  const key = text?.trim() ?? "";
  return usePagedData<QuestionListItemView, never>({
    key,
    facetKey: key,
    refreshPage: libraryPaging.refreshPages.questions,
    source: () => questionsSource(text),
    itemKey: (question) => question.id,
    kinds: questionChanges,
    active
  });
}

/** `objects.resolveMany` takes up to this many addresses. */
const resolveBatch = 200;

/**
 * The titles of the topics that the loaded questions were asked about, in one `resolveMany` per
 * batch of 200 per change of the set, and again when a topic changes (a rename). A topic that no
 * longer exists maps to null; one not read yet is absent, and reads "Um tópico".
 */
export function useScopeTitles(
  questions: readonly QuestionListItemView[],
  active: boolean
): ReadonlyMap<string, string | null> {
  const [titles, setTitles] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [changes, setChanges] = useState(0);
  const ids = useMemo(() => scopeTopicIds(questions).sort(), [questions]);
  const key = ids.join(",");
  useObjectKindChanged(topicChanges, () => setChanges((count) => count + 1), active);
  useEffect(() => {
    if (!active || ids.length === 0) return undefined;
    const app = typeof window === "undefined" ? undefined : window.app;
    if (!app?.objects?.resolveMany) return undefined;
    let live = true;
    const addressOf = (id: string) => formatObjectAddress({ kind: "topic", id });
    void (async () => {
      const next = new Map<string, string | null>();
      try {
        for (let from = 0; from < ids.length; from += resolveBatch) {
          const batch = ids.slice(from, from + resolveBatch);
          const result = await app.objects.resolveMany({ addresses: batch.map(addressOf) });
          if (!live) return;
          for (const id of batch) {
            const found = result.items[addressOf(id)];
            next.set(id, found ? found.title : null);
          }
        }
      } catch {
        // The scope reads "Um tópico" for what a later read does not name; what was read stays.
      }
      if (live && next.size > 0) setTitles((known) => new Map([...known, ...next]));
    })();
    return () => {
      live = false;
    };
    // `ids` is read through its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active, changes]);
  return titles;
}

/**
 * The object the quick-look sheet looks at: read through `objects.get` and again when it changes,
 * with `retry` for a read that failed (the sheet says so once and offers "Tentar de novo").
 */
export function usePeekObject(address: string | null): { object: ObjectState; retry: () => void } {
  const [object, setObject] = useState<ObjectState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (address === null) return undefined;
    return watchObject(
      () => (typeof window === "undefined" ? undefined : window.app),
      address,
      setObject
    );
    // `attempt` re-runs the read: it is the retry.
  }, [address, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { object, retry };
}

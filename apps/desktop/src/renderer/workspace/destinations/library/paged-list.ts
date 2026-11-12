/**
 * A keyset-paged list that stays current (spec T149; D16): the first page of a query, more pages on
 * demand, and a re-read of what is loaded after a pushed change. Pure TypeScript, so the table's
 * paging, its newest-answer-wins rule and its quiet failures are tested without a screen. The
 * Library's two tabs (sources through `library.rows`, questions through `questions.list`) are two
 * sources of one list.
 *
 * - A new query drops older answers (a generation count) and keeps the rows on screen, dimmed
 *   (`stale`), until its first page arrives; a first page that fails is `error`.
 * - A re-read after a change keeps the rows when it fails (nothing the person sees is lost); several
 *   changes in a burst cost one re-read, started `refreshDelayMs` after the first.
 * - A page that fails to load more says so once (`moreFailed`) and waits for a retry.
 */

/** One page as a source answers it. */
export interface PageResult<Item, Facets> {
  items: readonly Item[];
  /** The cursor of the next page; absent on the last one. */
  next?: string | undefined;
  /** Matches in all, when the source counts them. */
  total?: number | undefined;
  facets?: Facets | undefined;
}

export interface PageRequest {
  cursor?: string | undefined;
  limit: number;
  /** Also count the facets (a state or area changed, or a re-read). */
  facets: boolean;
}

/** What one query reads. */
export interface PageSource<Item, Facets> {
  read(request: PageRequest): Promise<PageResult<Item, Facets>>;
}

export interface PagedState<Item, Facets> {
  status: "loading" | "ready" | "error";
  items: readonly Item[];
  /** Null while it is not known (the source does not count and more pages wait). */
  total: number | null;
  facets: Facets | null;
  hasMore: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
  /** The rows shown belong to the previous query; the new one is being read. */
  stale: boolean;
}

export const initialPagedState: PagedState<never, never> = {
  status: "loading",
  items: [],
  total: null,
  facets: null,
  hasMore: false,
  loadingMore: false,
  moreFailed: false,
  stale: false
};

export interface Scheduler {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const timers: Scheduler = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export interface PagedListOptions<Item, Facets> {
  pageSize: number;
  /** The most rows one request of this source may ask for (a re-read pages by this). */
  refreshPage: number;
  /**
   * How deep a re-read goes. A list loaded deeper than this keeps the rows past it as they were
   * (they follow the re-read head), so a live change never cuts what the person scrolled to.
   */
  refreshCap: number;
  refreshDelayMs: number;
  /** An item's identity: a row that arrives twice (a page edge that moved) is kept once. */
  key: (item: Item) => string;
  onChange: (state: PagedState<Item, Facets>) => void;
  schedule?: Scheduler;
}

export interface PagedList<Item, Facets> {
  /** Starts a query: its first page replaces the rows. `facets` asks for the counts too. */
  load(source: PageSource<Item, Facets>, options: { facets: boolean }): void;
  /** Reads the next page, when there is one and nothing else is being read. */
  more(): void;
  /** Re-reads what is loaded after a change; a burst of calls is one read. */
  refresh(): void;
  /** Tries again what failed: the first page, or the page that did not load. */
  retry(): void;
  getState(): PagedState<Item, Facets>;
  /** Stops reporting and drops every answer in flight. */
  dispose(): void;
  /** Undoes `dispose` (React runs a cleanup and a setup again on a kept state in development). */
  resume(): void;
}

export function createPagedList<Item, Facets>(
  options: PagedListOptions<Item, Facets>
): PagedList<Item, Facets> {
  const schedule = options.schedule ?? timers;
  let state = initialPagedState as PagedState<Item, Facets>;
  let source: PageSource<Item, Facets> | null = null;
  let cursor: string | undefined;
  /** Bumped by every `load`: an answer of an older query is dropped. */
  let generation = 0;
  /** A page or a re-read is being read. */
  let busy = false;
  /** A first page is being read (a change that comes meanwhile may not be in it). */
  let loading = false;
  let wanted = false;
  let timer: unknown = null;
  let disposed = false;

  const set = (patch: Partial<PagedState<Item, Facets>>) => {
    state = { ...state, ...patch };
    if (!disposed) options.onChange(state);
  };

  const unique = (items: readonly Item[]): Item[] => {
    const seen = new Set<string>();
    const kept: Item[] = [];
    for (const item of items) {
      const id = options.key(item);
      if (!seen.has(id)) {
        seen.add(id);
        kept.push(item);
      }
    }
    return kept;
  };

  const totalOf = (result: PageResult<Item, Facets>, count: number): number | null =>
    result.total ?? (result.next === undefined ? count : null);

  const settle = () => {
    busy = false;
    if (wanted && timer === null && !disposed) runRefresh();
  };

  const load: PagedList<Item, Facets>["load"] = (next, loadOptions) => {
    generation += 1;
    const mine = generation;
    source = next;
    cursor = undefined;
    busy = false;
    loading = true;
    wanted = false;
    if (timer !== null) schedule.clear(timer);
    timer = null;
    const keep = state.status === "ready" && state.items.length > 0;
    set(
      keep
        ? { stale: true, loadingMore: false, moreFailed: false }
        : { ...initialPagedState, facets: state.facets, status: "loading" }
    );
    next
      .read({ limit: options.pageSize, facets: loadOptions.facets })
      .then((result) => {
        if (mine !== generation) return;
        const items = unique(result.items);
        cursor = result.next;
        loading = false;
        set({
          status: "ready",
          stale: false,
          items,
          total: totalOf(result, items.length),
          facets: result.facets ?? state.facets,
          hasMore: result.next !== undefined,
          loadingMore: false,
          moreFailed: false
        });
        // A change that came while the page was being read may have missed its snapshot: read once more.
        if (wanted && timer === null && !disposed) {
          timer = schedule.set(runRefresh, options.refreshDelayMs);
        }
      })
      .catch(() => {
        if (mine !== generation) return;
        loading = false;
        set({ ...initialPagedState, facets: state.facets, status: "error" });
      });
  };

  const more = () => {
    if (!source || busy || cursor === undefined || state.status !== "ready" || state.stale) return;
    busy = true;
    const mine = generation;
    set({ loadingMore: true, moreFailed: false });
    source
      .read({ cursor, limit: options.pageSize, facets: false })
      .then((result) => {
        if (mine !== generation) return;
        cursor = result.next;
        const items = unique([...state.items, ...result.items]);
        set({
          items,
          total: totalOf(result, items.length),
          hasMore: result.next !== undefined,
          loadingMore: false
        });
        settle();
      })
      .catch(() => {
        if (mine !== generation) return;
        set({ loadingMore: false, moreFailed: true });
        settle();
      });
  };

  function runRefresh(): void {
    timer = null;
    if (!wanted || !source || state.status !== "ready" || state.stale) return;
    if (busy) return;
    wanted = false;
    busy = true;
    const mine = generation;
    const reading = source;
    const before = state.items;
    const want = Math.min(options.refreshCap, Math.max(options.pageSize, before.length));
    void (async () => {
      const items: Item[] = [];
      let next: string | undefined;
      let first: PageResult<Item, Facets> | null = null;
      try {
        do {
          const result = await reading.read({
            cursor: next,
            limit: Math.min(options.refreshPage, want - items.length),
            facets: first === null
          });
          if (mine !== generation) return;
          first ??= result;
          items.push(...result.items);
          next = result.next;
        } while (next !== undefined && items.length < want);
      } catch {
        // A failed re-read keeps the rows that are shown.
        if (mine === generation) settle();
        return;
      }
      if (mine !== generation || first === null) return;
      const head = unique(items);
      // A list deeper than the re-read keeps the rows past the head, from the last row both share.
      const tail = next !== undefined && before.length > want ? tailAfter(before, head) : [];
      const kept = tail.length > 0 ? [...head, ...tail] : head;
      if (tail.length === 0) cursor = next;
      set({
        items: kept,
        total: first.total ?? (next === undefined ? kept.length : state.total),
        facets: first.facets ?? state.facets,
        hasMore: tail.length > 0 ? state.hasMore : next !== undefined,
        moreFailed: false
      });
      settle();
    })();
  }

  /** The rows of `before` past the last one that `head` also holds, none of them in `head` again. */
  function tailAfter(before: readonly Item[], head: readonly Item[]): Item[] {
    const inHead = new Set(head.map(options.key));
    let last = -1;
    before.forEach((item, index) => {
      if (inHead.has(options.key(item))) last = index;
    });
    return last === -1
      ? []
      : before.slice(last + 1).filter((item) => !inHead.has(options.key(item)));
  }

  return {
    load,
    more,
    refresh() {
      // Nothing to re-read after a first page failed. A change during a first page's read is kept
      // for after it (the page's snapshot may not hold it); a re-read that is running reads again after.
      if (disposed || !source || state.status === "error") return;
      wanted = true;
      if (timer === null && !busy && !loading) {
        timer = schedule.set(runRefresh, options.refreshDelayMs);
      }
    },
    retry() {
      if (state.status === "error" && source) load(source, { facets: true });
      else if (state.moreFailed) more();
    },
    getState: () => state,
    resume() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      generation += 1;
      if (timer !== null) schedule.clear(timer);
      timer = null;
    }
  };
}

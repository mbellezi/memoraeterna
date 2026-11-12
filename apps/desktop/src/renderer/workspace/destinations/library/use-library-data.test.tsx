import { StrictMode, act } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QuestionListItemView } from "../../../../shared/ipc-questions";
import { libraryPaging } from "./library-model";
import { useLibraryQuestions, useScopeTitles, type PagedData } from "./use-library-data";

/**
 * The Library's hooks mounted for real, in a small DOM and under React's StrictMode (the way
 * `npm run dev` runs the renderer): a first read that survives the development double effect, a
 * re-read that honours each source's page size, and the topic titles read in batches of 200.
 */

const questionsMax = 50;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const question = (n: number, topic?: number): QuestionListItemView =>
  ({
    id: uuid(1000 + n),
    text: `Question ${n}`,
    language: "en",
    scope: topic === undefined ? { kind: "library" } : { kind: "topic", topicId: uuid(topic) },
    status: "complete",
    createdAt: "2026-11-10T20:00:00.000Z",
    updatedAt: "2026-11-10T20:00:00.000Z",
    answerCount: 1
  }) as QuestionListItemView;

type Listener = (event: unknown) => void;

function installDom() {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
  const listeners = new Set<Listener>();
  (window as unknown as Record<string, unknown>).location = { protocol: "http:" };
  const provided: Record<string, unknown> = {
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  for (const [name, value] of Object.entries(provided))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  (window as unknown as Record<string, unknown>).app = {
    onAppEvent: (_type: string, handler: Listener) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }
  };
  return {
    window: window as unknown as { app: Record<string, unknown> },
    document,
    emit: (event: unknown) => {
      for (const handler of [...listeners]) handler(event);
    }
  };
}

let dom: ReturnType<typeof installDom>;
let unmount: (() => void) | null = null;

beforeEach(() => {
  dom = installDom();
});
afterEach(() => {
  unmount?.();
  unmount = null;
  for (const key of ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"])
    delete (globalThis as Record<string, unknown>)[key];
  vi.useRealTimers();
});

async function mount<T>(hook: () => T): Promise<{ current: () => T }> {
  const { createRoot } = await import("react-dom/client");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  let latest: T | undefined;
  const Probe = () => {
    latest = hook();
    return null;
  };
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(
      <StrictMode>
        <Probe />
      </StrictMode>
    );
  });
  unmount = () => act(() => root.unmount());
  return { current: () => latest as T };
}

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("the paged hooks under StrictMode", () => {
  it("leave the loading state when the first page arrives, and read again on retry and on a change", async () => {
    const list = vi.fn(async () => ({ items: [question(1)] }));
    dom.window.app.questions = { list };
    const hook = await mount<PagedData<QuestionListItemView, never>>(() =>
      useLibraryQuestions("", true)
    );
    await settle();
    expect(hook.current().state.status).toBe("ready");
    expect(hook.current().state.items).toHaveLength(1);

    vi.useFakeTimers();
    const calls = list.mock.calls.length;
    await act(async () => {
      dom.emit({
        type: "object.changed",
        refs: [{ kind: "question", id: uuid(9), change: "created" }]
      });
      await vi.advanceTimersByTimeAsync(libraryPaging.refreshDelayMs + 10);
    });
    expect(list.mock.calls.length).toBe(calls + 1);
  });

  it("re-read the questions in pages the questions API accepts, so a long list stays current", async () => {
    const all = Array.from({ length: 60 }, (_, index) => question(index));
    const list = vi.fn(async (input: { cursor?: string; limit?: number }) => {
      const limit = input.limit ?? questionsMax;
      if (limit > questionsMax) throw new Error("limit above the API's maximum");
      const from = input.cursor === undefined ? 0 : Number(input.cursor);
      const items = all.slice(from, from + limit);
      return from + limit < all.length ? { items, next: String(from + limit) } : { items };
    });
    dom.window.app.questions = { list };
    const hook = await mount<PagedData<QuestionListItemView, never>>(() =>
      useLibraryQuestions("", true)
    );
    await settle();
    await act(async () => hook.current().more());
    await settle();
    expect(hook.current().state.items).toHaveLength(60);

    vi.useFakeTimers();
    all.unshift(question(99));
    await act(async () => {
      dom.emit({
        type: "object.changed",
        refs: [{ kind: "question", id: uuid(1099), change: "created" }]
      });
      await vi.advanceTimersByTimeAsync(libraryPaging.refreshDelayMs + 10);
    });
    // What was loaded (60 rows) is read again; the new question leads it.
    expect(hook.current().state.items).toHaveLength(60);
    expect(hook.current().state.items[0]?.id).toBe(uuid(1099));
  });
});

describe("the scope titles", () => {
  it("name topics beyond the first 200 and say a topic is gone only when it is", async () => {
    const questions = Array.from({ length: 250 }, (_, index) => question(index, 2000 + index));
    const known = new Set(Array.from({ length: 249 }, (_, index) => uuid(2000 + index)));
    const resolveMany = vi.fn(async ({ addresses }: { addresses: string[] }) => ({
      items: Object.fromEntries(
        addresses
          .filter((address) => known.has(address.slice(address.lastIndexOf("/") + 1)))
          .map((address) => [address, { address, kind: "topic", title: `T ${address.slice(-4)}` }])
      ),
      missing: []
    }));
    dom.window.app.objects = { resolveMany };
    const hook = await mount(() => useScopeTitles(questions, true));
    await settle();
    await settle();
    // StrictMode reads the first batch twice; every call stays within what the API takes.
    const sizes = resolveMany.mock.calls.map(([input]) => input.addresses.length);
    expect(Math.max(...sizes)).toBe(200);
    expect(sizes.slice(-2)).toEqual([200, 50]);
    const titles = hook.current();
    expect(titles.get(uuid(2000))).toBe("T 2000");
    expect(titles.get(uuid(2249))).toBeNull();
    expect(titles.get(uuid(2230))).toBe("T 2230");
  });

  it("read again when a topic changes (a rename)", async () => {
    const questions = [question(1, 2001)];
    let title = "Before";
    const resolveMany = vi.fn(async ({ addresses }: { addresses: string[] }) => ({
      items: Object.fromEntries(
        addresses.map((address) => [address, { address, kind: "topic", title }])
      ),
      missing: []
    }));
    dom.window.app.objects = { resolveMany };
    const hook = await mount(() => useScopeTitles(questions, true));
    await settle();
    expect(hook.current().get(uuid(2001))).toBe("Before");
    title = "After";
    await act(async () => {
      dom.emit({
        type: "object.changed",
        refs: [{ kind: "topic", id: uuid(2001), change: "updated" }]
      });
    });
    await settle();
    expect(hook.current().get(uuid(2001))).toBe("After");
  });
});

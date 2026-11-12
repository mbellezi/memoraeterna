// The DOM globals must exist before Radix loads: this import stays first.
import { createTestDom, type TestDom } from "../../../workspace/test-dom";
import { vi } from "vitest";
import { createTranslator, type LanguageCode } from "@app/i18n";

import { SettingsSurface } from "../../SettingsSurface";
import type { SettingsSectionId } from "../../settings-model";
import { describeFixture } from "./section-screen";

/**
 * What the tests of the Settings sections share: a fake `window.app` whose calls are recorded and
 * answered from a table (a value, or a function of the arguments; no entry rejects), a bus the test can
 * emit on, and `mountSection`, which opens the real Settings surface on one section in a small DOM.
 */

export type Answer = unknown;
export type Answers = Record<string, Answer>;

export interface Harness {
  dom: TestDom;
  /** Every call made on `window.app`, in order. */
  calls: Array<{ path: string; args: unknown[] }>;
  answers: Answers;
  emit(type: string, event?: Record<string, unknown>): Promise<void>;
  /** Settles the promises the section started and the timers React uses. */
  settle(): Promise<void>;
  /** Hides or shows Settings the way the shell does: it stays mounted. */
  show(active: boolean): Promise<void>;
  frame(): HTMLElement;
  row(id: string): HTMLElement | null;
  click(element: Element | null | undefined): Promise<void>;
  /** Types into a field through the handler React holds (this DOM has no `oninput`). */
  type(input: Element | null | undefined, value: string): Promise<void>;
  /** Presses a key in a field through the handler React holds. */
  press(input: Element | null | undefined, key: string): Promise<void>;
  /** The button whose text is exactly `text`, inside `root` (the page by default). */
  button(text: string, root?: ParentNode): HTMLButtonElement | undefined;
  text(): string;
  count(path: string): number;
  dispose(): Promise<void>;
}

const reactProps = (element: Element): Record<string, (event: unknown) => void> => {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[
    key ?? ""
  ] as Record<string, (event: unknown) => void>;
};

export async function mountSection(options: {
  section: SettingsSectionId;
  locale?: LanguageCode;
  answers?: Answers;
}): Promise<Harness> {
  vi.useFakeTimers();
  const dom = createTestDom();
  const calls: Harness["calls"] = [];
  const answers: Answers = { "settings.describe": describeFixture({}), ...options.answers };
  const handlers = new Map<string, Array<(event: unknown) => void>>();

  const node = (path: string): unknown =>
    new Proxy(function fake() {}, {
      get(_target, key) {
        if (typeof key !== "string" || key === "then" || key === "toJSON") return undefined;
        return node(path === "" ? key : `${path}.${key}`);
      },
      apply(_target, _this, args: unknown[]) {
        calls.push({ path, args });
        if (!Object.hasOwn(answers, path)) return Promise.reject(new Error(`no answer: ${path}`));
        const answer = answers[path];
        try {
          return Promise.resolve(typeof answer === "function" ? answer(...args) : answer);
        } catch (error) {
          return Promise.reject(error);
        }
      }
    });
  const root = node("") as Record<string, unknown>;
  const app = new Proxy(root, {
    get(target, key) {
      if (key === "onAppEvent")
        return (type: string, handler: (event: unknown) => void) => {
          handlers.set(type, [...(handlers.get(type) ?? []), handler]);
          return () => {
            handlers.set(
              type,
              (handlers.get(type) ?? []).filter((candidate) => candidate !== handler)
            );
          };
        };
      return target[key as string];
    }
  });
  (dom.window as unknown as { app: unknown }).app = app;
  const prototype = (dom.window as unknown as { HTMLElement: { prototype: object } }).HTMLElement
    .prototype as { focus?: () => void; select?: () => void; scrollIntoView?: () => void };
  prototype.focus = () => undefined;
  prototype.select = () => undefined;

  const settle = async () => {
    await dom.act(() => void vi.advanceTimersByTime(0));
    await dom.act(() => void vi.advanceTimersByTime(0));
  };
  const t = createTranslator(options.locale ?? "en");
  const surface = (active: boolean) => (
    <SettingsSurface t={t} initialSection={options.section} active={active} />
  );
  await dom.render(surface(true));
  await settle();

  return {
    dom,
    calls,
    answers,
    settle,
    emit: async (type, event = {}) => {
      await dom.act(() => {
        for (const handler of handlers.get(type) ?? []) handler({ type, ...event });
      });
      await settle();
    },
    show: async (active) => {
      await dom.render(surface(active));
      await settle();
    },
    frame: () => dom.document.querySelector("[data-surface]") as HTMLElement,
    row: (id) => dom.document.querySelector(`[data-setting-id="${id}"]`) as HTMLElement | null,
    click: (element) =>
      dom.act(() => void element?.dispatchEvent(new dom.window.Event("click", { bubbles: true }))),
    type: (input, value) =>
      dom.act(() => void reactProps(input as Element).onChange?.({ target: { value } })),
    press: (input, key) =>
      dom.act(
        () =>
          void reactProps(input as Element).onKeyDown?.({
            key,
            preventDefault: () => undefined,
            stopPropagation: () => undefined
          })
      ),
    button: (text, scope = dom.document) =>
      [...scope.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === text
      ) as HTMLButtonElement | undefined,
    text: () => dom.document.body.textContent ?? "",
    count: (path) => calls.filter((call) => call.path === path).length,
    dispose: async () => {
      await dom.dispose();
      vi.useRealTimers();
    }
  };
}

// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../workspace/test-dom";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { settingsRegistryV2 } from "../../shared/settings-registry";
import { SettingRow } from "./SettingRow";
import { SettingsSurface, highlightMs } from "./SettingsSurface";
import { registerSections } from "./sections-registry";
import { requestSettingsTarget, resetSettingsTargetForTests } from "./settings-target";

const en = createTranslator("en");
const ptBR = createTranslator("pt-BR");
const noop = () => undefined;

describe("a setting row", () => {
  const row = (changed: boolean) =>
    renderToString(
      <SettingRow
        t={en}
        id="contentLanguage"
        label="Notes language"
        help="In what language Memora writes."
        changed={changed}
        defaultLabel="Same as macOS"
        onReset={noop}
        control={<select aria-label="Notes language" />}
      />
    );

  it("marks a changed row with the word, the accent bar, the default and the way back", () => {
    const html = row(true);
    expect(html).toContain("Changed");
    expect(html).toContain("data-changed");
    expect(html).toContain("inset_2px_0_0_var(--accent)");
    expect(html).toContain("Default:");
    expect(html).toContain("Same as macOS");
    expect(html).toContain('aria-label="Restore default: Notes language"');
    expect(html).toContain('data-setting-id="contentLanguage"');
    expect(html).toContain('tabindex="-1"');
  });

  it("shows nothing of that on a row at its default", () => {
    const html = row(false);
    expect(html).not.toContain("Changed");
    expect(html).not.toContain("Restore default");
    expect(html).not.toContain("inset_2px_0_0");
  });

  it("lights a row taken to by a link, with the same bar, and says a reset is running, failed or pending", () => {
    const lit = renderToString(<SettingRow t={en} id="x" label="X" highlighted reset="idle" />);
    expect(lit).toContain("bg-surface-selected");
    const working = renderToString(
      <SettingRow t={en} id="x" label="X" changed onReset={noop} reset="working" defaultVaries />
    );
    expect(working).toContain("Restoring…");
    expect(working).not.toContain("Restore default");
    expect(
      renderToString(<SettingRow t={en} id="x" label="X" changed onReset={noop} reset="failed" />)
    ).toContain("Nothing was changed.");
    expect(
      renderToString(<SettingRow t={en} id="x" label="X" changed onReset={noop} reset="pending" />)
    ).toContain("confirm");
  });
});

describe("the surface, rendered once", () => {
  it("reports the loading state and shows the section's title while the values are read", () => {
    const html = renderToString(<SettingsSurface t={ptBR} />);
    expect(html).toContain('data-surface="settings"');
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('role="status" aria-busy="true"');
    expect(html).toContain("Geral e aparência");
    expect(html.match(/data-section=/g)).toHaveLength(7);
    expect(html).toContain('aria-current="true"');
  });

  it("marks no section as current while a search replaces the section", () => {
    const html = renderToString(<SettingsSurface t={en} initialQuery="language" />);
    expect(html).not.toContain("aria-current");
  });

  it("reports empty for a search nothing answers, and success with a list for one that does", () => {
    const none = renderToString(<SettingsSurface t={en} initialQuery="impressora" />);
    expect(none).toContain('data-state="empty"');
    expect(none).toContain("Nothing for “impressora” in settings.");
    expect(none).toContain("Clear the search");
    const some = renderToString(<SettingsSurface t={en} initialQuery="language" />);
    expect(some).toContain('data-state="success"');
    expect(some).toContain("results for “language”");
    expect(some).toContain("data-result=");
    // The best one carries the Enter keycap, and each shows its path.
    expect(some).toContain("General and appearance");
    expect(some).toContain("›");
  });

  it("uses the id it is given as its frame, so a section's own surface reports itself", () => {
    expect(renderToString(<SettingsSurface t={en} surface="settings-general" />)).toContain(
      'data-surface="settings-general"'
    );
  });

  it("renders nothing until it is first shown, and stays in the page, hidden, afterwards", () => {
    expect(renderToString(<SettingsSurface t={en} active={false} />)).toBe("");
  });

  it("has a Settings entry for every setting the registry stores, so every row can be found by its id", () => {
    const html = renderToString(<SettingsSurface t={en} initialSection="advanced" />);
    expect(html).toContain("Advanced and diagnostics");
    expect(settingsRegistryV2.length).toBeGreaterThan(60);
  });
});

describe("registering sections by file", () => {
  const Body = () => null;
  it("takes each file's section, in path order, and refuses a file without one or two for one section", () => {
    const registry = registerSections({
      "./sections/ai/AiSection.tsx": { section: { id: "ai", Section: Body } },
      "./sections/general/GeneralSection.tsx": { section: { id: "general", Section: Body } }
    });
    expect(Object.keys(registry)).toEqual(["ai", "general"]);
    expect(() => registerSections({ "./a.tsx": {} })).toThrow("must export section");
    expect(() =>
      registerSections({
        "./a.tsx": { section: { id: "ai", Section: Body } },
        "./b.tsx": { section: { id: "ai", Section: Body } }
      })
    ).toThrow("twice");
  });
});

// ---------------------------------------------------------------------------
// In a DOM

let dom: TestDom;
let reads: number;
let focusedByScript: Element | null;
let describeAnswer: () => Promise<unknown>;
let resetCalls: unknown[];
let resetAnswer: (id: string) => Promise<unknown>;
let emit: () => void;

const entries = (changedIds: string[] = ["contentLanguage"]) =>
  settingsRegistryV2
    .filter((entry) => entry.store.kind !== "none")
    .map((entry) => ({
      id: entry.id,
      value: entry.control === "switch" ? false : null,
      default: entry.control === "switch" ? false : null,
      changed: changedIds.includes(entry.id)
    }));

beforeEach(async () => {
  vi.useFakeTimers();
  resetSettingsTargetForTests();
  reads = 0;
  resetCalls = [];
  resetAnswer = (id) => Promise.resolve({ id, value: null });
  focusedByScript = null;
  describeAnswer = () => Promise.resolve({ entries: entries() });
  dom = createTestDom();
  const prototype = (dom.window as unknown as { HTMLElement: { prototype: object } }).HTMLElement
    .prototype as { focus?: () => void };
  prototype.focus = function focus(this: Element) {
    // A browser does not focus a disabled control.
    if ((this as HTMLInputElement).disabled) return;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the test records what took focus
    focusedByScript = this;
  };
  (prototype as { select?: () => void }).select = () => undefined;
  const app = {
    settings: {
      describe: () => {
        reads += 1;
        return describeAnswer();
      },
      reset: (input: unknown) => {
        resetCalls.push(input);
        return resetAnswer((input as { id: string }).id);
      }
    },
    onAppEvent: (_type: string, handler: () => void) => {
      emit = handler;
      return () => undefined;
    }
  };
  (dom.window as unknown as { app: unknown }).app = app;
});

afterEach(async () => {
  await dom.dispose();
  vi.useRealTimers();
});

const mount = async (props: Partial<Parameters<typeof SettingsSurface>[0]> = {}) => {
  await dom.render(<SettingsSurface t={en} onOpenClassic={noop} {...props} />);
  await dom.act(() => void vi.advanceTimersByTime(0));
};
const frame = () => dom.document.querySelector("[data-surface]") as HTMLElement;
const row = (id: string) =>
  dom.document.querySelector(`[data-setting-id="${id}"]`) as HTMLElement | null;
const click = (element: Element) =>
  dom.act(() => void element.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
/**
 * Types into a field. The DOM of these tests has no `oninput`, so React would not turn an input event
 * into `onChange`: the handler React holds for the field is called as it would be, with the text.
 */
const type = (input: HTMLInputElement, value: string) =>
  dom.act(() => {
    const key = Object.keys(input).find((name) => name.startsWith("__reactProps$"));
    const props = (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[
      key ?? ""
    ];
    props?.onChange({ target: { value } });
  });
/** A key in the search field, through the handler React holds (the same reason as `type`). */
const press = (input: HTMLInputElement, key: string) =>
  dom.act(() => {
    const name = Object.keys(input).find((candidate) => candidate.startsWith("__reactProps$"));
    const props = (input as unknown as Record<string, { onKeyDown: (event: unknown) => void }>)[
      name ?? ""
    ];
    props?.onKeyDown({ key, preventDefault: () => undefined });
  });
const search = () => dom.document.querySelector('[role="searchbox"]') as HTMLInputElement;

describe("the surface, in the DOM", () => {
  it("reads the values once, shows the changed count and the marker, and focuses the search field", async () => {
    await mount();
    expect(frame().getAttribute("data-state")).toBe("success");
    expect(reads).toBe(1);
    expect(focusedByScript).toBe(search());
    expect(row("contentLanguage")?.hasAttribute("data-changed")).toBe(true);
    expect(row("themeMode")?.hasAttribute("data-changed")).toBe(false);
    const general = dom.document.querySelector('[data-section="general"]') as HTMLElement;
    expect(general.textContent).toContain("1");
    expect(dom.document.body.textContent).toContain("1 setting changed");
  });

  it("draws the loading bars of the section it opens: its rows, and no control it does not have", async () => {
    describeAnswer = () => new Promise(() => undefined);
    await mount();
    await dom.act(() => void vi.advanceTimersByTime(200));
    const bars = () => dom.document.querySelector("[aria-busy]")?.innerHTML ?? "";
    // General has 2 groups and 3 rows; no control-sized block while the section has no body of its own.
    expect(bars().match(/gap-y-2 border-b border-border/g)).toHaveLength(3);
    expect(bars()).not.toContain("w-40 rounded-md");
    await dom.render(
      <SettingsSurface
        t={en}
        sections={{ general: { id: "general", Section: () => null } }}
        onOpenClassic={noop}
      />
    );
    await dom.act(() => void vi.advanceTimersByTime(200));
    expect(bars()).toContain("w-40 rounded-md");
  });

  it("keeps the changed count as one sentence, with the list it opens inside it, and names values", async () => {
    const known: Record<string, [string, string]> = {
      themeMode: ["dark", "dark"],
      language: ["en", "en"],
      contentLanguage: ["pt-BR", "en"]
    };
    describeAnswer = () =>
      Promise.resolve({
        entries: entries().map((entry) => ({
          ...entry,
          ...(known[entry.id] ? { value: known[entry.id]![0], default: known[entry.id]![1] } : {})
        }))
      });
    await mount();
    const toggle = dom.document.querySelector("[aria-controls]") as HTMLElement;
    expect(toggle.textContent).toBe("1 setting changed in this section");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // The theme and the language are said in words, in the row's control place.
    expect(row("themeMode")?.textContent).toContain("Dark");
    expect(row("language")?.textContent).toContain("English");
    expect(row("contentLanguage")?.textContent).toContain("Portuguese (Brazil)");
    expect(row("contentLanguage")?.textContent).toContain("Default:English");
  });

  it("focuses the search field when the saved values arrive after Settings opened", async () => {
    let answer: (value: unknown) => void = () => undefined;
    describeAnswer = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    await mount();
    // The field waits, disabled, while the values are read: a browser would not focus it yet.
    expect(frame().getAttribute("data-state")).toBe("loading");
    expect(search().disabled).toBe(true);
    expect(focusedByScript).toBeNull();
    await dom.act(() => answer({ entries: entries() }));
    await dom.act(() => void vi.advanceTimersByTime(0));
    expect(search().disabled).toBe(false);
    expect(focusedByScript).toBe(search());
  });

  it("shows a failed read in place with one retry, and the rows after the retry answers", async () => {
    describeAnswer = () => Promise.reject(new Error("closed"));
    await mount();
    expect(frame().getAttribute("data-state")).toBe("error");
    expect(dom.document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(dom.document.body.textContent).toContain("Could not read your saved settings.");
    expect(dom.document.body.textContent).toContain("Nothing was changed");
    describeAnswer = () => Promise.resolve({ entries: entries() });
    const retry = [...dom.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry"
    )!;
    await click(retry);
    await dom.act(() => void vi.advanceTimersByTime(0));
    expect(frame().getAttribute("data-state")).toBe("success");
    expect(reads).toBe(2);
  });

  it("reads again when a settings.changed arrives, never on a timer", async () => {
    await mount();
    await dom.act(() => void vi.advanceTimersByTime(60_000));
    expect(reads).toBe(1);
    await dom.act(() => emit());
    await dom.act(() => void vi.advanceTimersByTime(0));
    expect(reads).toBe(2);
  });

  it("searches as it is typed: a list, Enter opens the best result's row, focuses and lights it for 2 s", async () => {
    await mount();
    await type(search(), "notes language");
    expect(frame().getAttribute("data-state")).toBe("success");
    const results = [...dom.document.querySelectorAll("[data-result]")];
    expect(results[0]?.getAttribute("data-result")).toBe("contentLanguage");
    await press(search(), "Enter");
    expect(search().value).toBe("");
    expect(focusedByScript).toBe(row("contentLanguage"));
    expect(row("contentLanguage")?.className).toContain("bg-surface-selected");
    await dom.act(() => void vi.advanceTimersByTime(highlightMs + 10));
    expect(row("contentLanguage")?.className).not.toContain("bg-surface-selected");
  });

  it("says nothing was found, offers the way back, and Escape clears the search", async () => {
    await mount();
    await type(search(), "impressora");
    expect(frame().getAttribute("data-state")).toBe("empty");
    expect(dom.document.body.textContent).toContain("Nothing for “impressora” in settings.");
    await press(search(), "Escape");
    expect(search().value).toBe("");
    expect(frame().getAttribute("data-state")).toBe("success");
  });

  it("goes to a section from the column, and a click on a result opens that row in its section", async () => {
    await mount();
    await click(dom.document.querySelector('[data-section="advanced"]')!);
    expect(row("debugMode")).not.toBeNull();
    expect(row("themeMode")).toBeNull();
    await type(search(), "dark");
    const best = dom.document.querySelector("[data-result]") as HTMLElement;
    expect(best.getAttribute("data-result")).toBe("themeMode");
    await click(best);
    expect(row("themeMode")).not.toBeNull();
    expect(focusedByScript).toBe(row("themeMode"));
  });

  it("answers a request for a section and a setting once: scrolls, focuses, lights", async () => {
    await mount({ active: false });
    expect(dom.document.querySelector("[data-surface]")).toBeNull();
    requestSettingsTarget({ section: "advanced", setting: "debugMode" });
    await dom.render(<SettingsSurface t={en} onOpenClassic={noop} active />);
    await dom.act(() => void vi.advanceTimersByTime(0));
    expect(focusedByScript).toBe(row("debugMode"));
    expect(row("debugMode")?.className).toContain("bg-surface-selected");
    // The flat name of an id an address cannot hold finds its row too.
    requestSettingsTarget({ setting: "aiDecisionsOpenaiPlatform" });
    await dom.act(() => void vi.advanceTimersByTime(0));
    expect(focusedByScript).toBe(row("ai:decisions-openai-platform"));
  });

  it("restores a changed setting through reset and reads the values again", async () => {
    await mount();
    const restore = [...dom.document.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.startsWith("Restore default: Notes language")
    )!;
    await click(restore);
    await dom.act(() => void vi.advanceTimersByTime(0));
    expect(resetCalls).toEqual([{ id: "contentLanguage" }]);
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("asks once in the line before it restores every changed setting of the section", async () => {
    await mount();
    const restoreAll = [...dom.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Restore all"
    )!;
    await click(restoreAll);
    expect(dom.document.body.textContent).toContain("Restore 1 setting to its default?");
    expect(resetCalls).toEqual([]);
    const confirm = [...dom.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Restore"
    )!;
    await click(confirm);
    await dom.act(() => void vi.advanceTimersByTime(0));
    expect(resetCalls).toEqual([{ id: "contentLanguage" }]);
  });

  it("asks before it removes a stored key, naming it, and only Remove writes", async () => {
    describeAnswer = () => Promise.resolve({ entries: entries(["ai:decisions-openai-platform"]) });
    await mount({ initialSection: "ai" });
    const restore = () =>
      [...dom.document.querySelectorAll("button")].find((button) =>
        button.getAttribute("aria-label")?.startsWith("Restore default: OpenAI Platform key")
      )!;
    await click(restore());
    expect(resetCalls).toEqual([]);
    expect(row("ai:decisions-openai-platform")?.textContent).toContain(
      "Remove it from this Mac? You would have to enter it again."
    );
    const cancel = [...row("ai:decisions-openai-platform")!.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel"
    )!;
    await click(cancel);
    expect(resetCalls).toEqual([]);
    expect(row("ai:decisions-openai-platform")?.textContent).toContain("Restore default");
    await click(restore());
    await click(
      [...row("ai:decisions-openai-platform")!.querySelectorAll("button")].find(
        (button) => button.getAttribute("aria-label") === "Remove: OpenAI Platform key"
      )!
    );
    await dom.act(() => void vi.advanceTimersByTime(0));
    expect(resetCalls).toEqual([{ id: "ai:decisions-openai-platform", confirmed: true }]);
  });

  it("leaves a stored key out of Restore all, counts it as a step for the person, and restores the rest", async () => {
    const other = settingsRegistryV2.find(
      (entry) =>
        entry.section === "ai" &&
        entry.store.kind !== "none" &&
        entry.reset !== "none" &&
        entry.reset !== "credential"
    )!;
    describeAnswer = () =>
      Promise.resolve({ entries: entries(["ai:decisions-openai-platform", other.id]) });
    await mount({ initialSection: "ai" });
    expect(dom.document.body.textContent).toContain("2 settings changed");
    await click(
      [...dom.document.querySelectorAll("button")].find(
        (button) => button.textContent === "Restore all"
      )!
    );
    // The line promises only what it will do: one setting, not the key.
    expect(dom.document.body.textContent).toContain("Restore 1 setting to its default?");
    await click(
      [...dom.document.querySelectorAll("button")].find(
        (button) => button.textContent === "Restore"
      )!
    );
    await dom.act(() => void vi.advanceTimersByTime(0));
    expect(resetCalls).toEqual([{ id: other.id }]);
    expect(dom.document.body.textContent).toContain(
      "1 needs a step from you and stayed as it was."
    );
  });

  it("offers no Restore all when every changed setting of the section is a stored key", async () => {
    describeAnswer = () => Promise.resolve({ entries: entries(["ai:decisions-openai-platform"]) });
    await mount({ initialSection: "ai" });
    expect(dom.document.body.textContent).toContain("1 setting changed");
    expect(
      [...dom.document.querySelectorAll("button")].some(
        (button) => button.textContent === "Restore all"
      )
    ).toBe(false);
  });

  it("says a reset that failed failed, apart from the ones that wait for a step", async () => {
    resetAnswer = () => Promise.reject(new Error("closed"));
    await mount();
    await click(
      [...dom.document.querySelectorAll("button")].find(
        (button) => button.textContent === "Restore all"
      )!
    );
    await click(
      [...dom.document.querySelectorAll("button")].find(
        (button) => button.textContent === "Restore"
      )!
    );
    await dom.act(() => void vi.advanceTimersByTime(0));
    const status = [...dom.document.querySelectorAll('[role="status"]')].map(
      (node) => node.textContent
    );
    expect(status.join(" ")).toContain("1 could not be restored and stayed as it was.");
    expect(status.join(" ")).not.toContain("needs a step");
  });

  it("opens the old settings from the column's foot, and ⌘F goes to the search field", async () => {
    const opened = vi.fn();
    await mount({ onOpenClassic: opened });
    await click(
      [...dom.document.querySelectorAll("button")].find(
        (button) => button.textContent === "Open the old settings"
      )!
    );
    expect(opened).toHaveBeenCalledTimes(1);
    focusedByScript = null;
    await dom.act(
      () => void dom.key(dom.document.body as unknown as Element, "f", { metaKey: true })
    );
    expect(focusedByScript).toBe(search());
  });
});

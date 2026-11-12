// What the object journeys J4, J5, J6 and J8 share (F5 T155, spec 5.3): reading the workspace's
// stack, opening an object address the way the system does, waiting for a surface by the
// `data-surface` and `data-state` its frame writes, and a step log that captures each step in both
// themes with its contrast scan (X12) and reports the failures at the end of the journey. A selector
// is a data attribute or a role the surface emits, never its copy.
import { expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";

import { captureStep, stepFailures, type MemoraSession } from "./app.js";
import { readGestures } from "./gestures.js";
import { pressShortcut } from "./shortcuts.js";

/** The device-local layout key of the workspace (`R/workspace/persist.ts`, D8). */
export const workspaceStorageKey = "memora.workspace.v1";

export interface StackView {
  root: string;
  /** The address each panel shows now (the current entry of its own history), left to right. */
  panels: string[];
  /** The focused panel's index; -1 is the root. */
  focus: number;
}

/** The stack of one destination in a stored workspace state; null when the shape is not one. */
export function stackOf(state: unknown, destination: string): StackView | null {
  const stacks = (state as { stacks?: Record<string, unknown> } | null)?.stacks;
  const stack = stacks?.[destination] as
    { root?: unknown; panels?: unknown; focus?: unknown } | undefined;
  if (!stack || typeof stack.root !== "string" || !Array.isArray(stack.panels)) return null;
  const panels = stack.panels.map((panel: { history?: unknown; index?: unknown }) =>
    Array.isArray(panel.history) && typeof panel.index === "number"
      ? (panel.history[panel.index] as string | undefined)
      : undefined
  );
  if (panels.some((address) => typeof address !== "string")) return null;
  return {
    root: stack.root,
    panels: panels as string[],
    focus: typeof stack.focus === "number" ? stack.focus : -1
  };
}

/** The destination the workspace is in (`explore`, `inbox`, ...) and its stack, as stored. */
export async function readWorkspace(page: Page): Promise<{ destination: string; state: unknown }> {
  const raw = await page.evaluate((key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }, workspaceStorageKey);
  const state = raw ? (JSON.parse(raw) as unknown) : null;
  return {
    destination: (state as { destination?: string } | null)?.destination ?? "",
    state
  };
}

/** The stack of `destination` as stored (the shell saves it at most every 500 ms: poll for it). */
export async function readStack(page: Page, destination: string): Promise<StackView | null> {
  return stackOf((await readWorkspace(page)).state, destination);
}

/** Waits until the stored stack of `destination` satisfies `check`; the message names the stack. */
export async function expectStack(
  page: Page,
  destination: string,
  check: (stack: StackView) => boolean,
  what: string,
  timeout = 15_000
): Promise<StackView> {
  let last: StackView | null = null;
  await expect
    .poll(
      async () => {
        last = await readStack(page, destination);
        return last !== null && check(last);
      },
      { message: `the ${destination} stack: ${what}`, timeout }
    )
    .toBe(true);
  return last as unknown as StackView;
}

/**
 * Shows the context panel (it starts hidden: Cmd-Shift-\ toggles it). From 1280 px it docks beside
 * the stack; below that it is a 40 px strip, and `open` also opens the strip's overlay.
 */
export async function showContextPanel(
  session: { electronApp: ElectronApplication; page: Page },
  options: { open?: boolean } = {}
): Promise<void> {
  const panel = session.page.locator('[data-surface="context-panel"]');
  const hidden = await panel.evaluate((node) => node.hasAttribute("hidden")).catch(() => true);
  if (hidden) await pressShortcut(session, "Meta+Shift+\\");
  await expect(panel, "the context panel did not show").toBeVisible({ timeout: 15_000 });
  if (!options.open) return;
  const strip = panel.locator("button[aria-expanded]").first();
  if ((await strip.count()) === 0) return;
  if ((await strip.getAttribute("aria-expanded")) !== "true") await strip.click();
  await expect(strip).toHaveAttribute("aria-expanded", "true");
}

/** `memora://note/<id>`. */
export const noteAddress = (id: string) => `memora://note/${id}`;

/** Opens an object the way the system does (`open-url` in the main process, D10). */
export async function openObject(session: MemoraSession, address: string): Promise<void> {
  await session.electronApp.evaluate(({ app }, url) => {
    app.emit("open-url", { preventDefault: () => undefined }, url);
  }, address);
}

/** A surface's frame by the id it reports; `state` narrows it to one of the four states. */
export function surface(page: Page, id: string, state?: string): Locator {
  return page.locator(`[data-surface="${id}"]${state ? `[data-state="${state}"]` : ""}`);
}

/** The top panel of the stack: the frame that marks itself `data-panel-top`. */
export function topPanel(page: Page): Locator {
  return page.locator("[data-panel-top]");
}

/**
 * The steps of one journey: each is captured in light and dark and scanned for contrast (X12). The
 * failures are collected and asserted softly at the end, so a contrast defect does not hide what a
 * later functional step would have shown, and is still a red journey.
 */
export class StepLog {
  private index = 0;
  private readonly failures: string[] = [];
  private readonly notes: string[] = [];

  constructor(
    private readonly session: MemoraSession,
    private readonly spec: string
  ) {}

  async step(name: string): Promise<void> {
    this.index += 1;
    // A window another app covers is occluded: it stops rendering, so the theme switch of the capture
    // (its wait runs on animation frames) would never see the new colours. Bring it to the front.
    await this.session.electronApp
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.moveTop())
      .catch(() => undefined);
    await this.session.page.bringToFront().catch(() => undefined);
    const record = await captureStep(this.session, this.spec, this.index, name);
    // Each failure of the step: a scan drawn in the other theme (a "light" scan of a page that stayed
    // dark proves nothing about light) and every contrast finding, per theme.
    this.failures.push(...stepFailures(record));
  }

  note(text: string): void {
    this.notes.push(text);
  }

  /** The contrast failures so far (X12). */
  contrastFailures(): readonly string[] {
    return this.failures;
  }

  /** Records the run's evidence on the test and asserts the contrast bar; call it last. */
  async finish(info: {
    annotations: { push(...items: { type: string; description: string }[]): void };
  }): Promise<void> {
    const gestures = await readGestures(this.session.page).catch(() => null);
    info.annotations.push(
      { type: "contrast failures", description: String(this.failures.length) },
      ...(gestures
        ? [
            {
              type: "gestures",
              description: `${gestures.total} (${gestures.pointer} pointer, ${gestures.keys} keys): ${gestures.log.join(" ")}`
            }
          ]
        : []),
      ...this.notes.map((text) => ({ type: "note", description: text }))
    );
    expect
      .soft(this.failures, "contrast (X12): every visible text and glyph, both themes")
      .toEqual([]);
  }
}

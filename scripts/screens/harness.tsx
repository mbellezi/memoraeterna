/**
 * The page side of the screens tool: it runs inside the fixture bundle. `mount` renders one surface
 * over a fake `window.app` in one mode and theme, waits for the surface's own frame to report
 * `[data-surface=<id>][data-state=<mode>]` (5 s at most) and answers with what it found.
 *
 * A surface that has its own frame (a panel inside `PanelFrame`) reports its state itself and a
 * disagreement fails. A hosted screen that has none yet is wrapped in a stand-in frame that labels
 * the mode, and the check then needs DOM evidence that the surface really is in that state: an
 * alert for error (or a host's `data-screen-passthrough`, for a surface whose failed question shows
 * the app instead), a busy or status region for loading, and neither for empty and success.
 */
import { createRoot, type Root } from "react-dom/client";

import type { ScreenModule, ScreenMode } from "../../apps/desktop/src/renderer/workspace/surfaces";
import { evidenceReasons, readEvidence } from "./evidence";
import { createFakeApi } from "./fake-api";

export type FrameSource = "own" | "harness" | "none";
export type ScreenTheme = "light" | "dark";

export interface MountResult {
  surface: string;
  mode: ScreenMode;
  theme: ScreenTheme;
  frame: FrameSource;
  /** What `data-state` said when the check ended. */
  state: string | null;
  ok: boolean;
  reasons: string[];
  /** Calls the surface made that its fixtures did not answer. */
  missing: string[];
  /** Uncaught page errors (an unhandled promise rejection is not one). */
  pageErrors: string[];
}

export const frameTimeoutMs = 5000;
const pollMs = 50;
const settleMs = 200;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let root: Root | null = null;
let host: HTMLElement | null = null;
const pageErrors: string[] = [];
window.addEventListener("error", (event) => pageErrors.push(String(event.message)));

interface Registry {
  modules: Readonly<Record<string, ScreenModule>>;
  ribbons: readonly string[];
}

function frameOf(
  id: string,
  mode: ScreenMode
): { frame: FrameSource; reasons: string[]; state: string | null } {
  const frames = [...document.querySelectorAll<HTMLElement>("[data-surface]")];
  const own = frames.find((element) => element.dataset.harness === undefined);
  if (own) {
    const reasons: string[] = [];
    if (own.dataset.surface !== id)
      reasons.push(`frame says surface ${own.dataset.surface ?? ""}, expected ${id}`);
    const state = own.dataset.state ?? null;
    if (state !== mode) reasons.push(`frame says state ${state ?? "none"}, expected ${mode}`);
    return { frame: "own", reasons, state };
  }
  const stand = host?.querySelector<HTMLElement>("[data-harness]");
  if (!stand) return { frame: "none", reasons: ["no frame"], state: null };
  stand.dataset.surface = id;
  stand.dataset.state = mode;
  return { frame: "harness", reasons: [], state: mode };
}

async function mount(
  registry: Registry,
  id: string,
  mode: ScreenMode,
  theme: ScreenTheme
): Promise<MountResult> {
  const module = registry.modules[id];
  const base = { surface: id, mode, theme };
  if (!module)
    return {
      ...base,
      frame: "none",
      state: null,
      ok: false,
      reasons: ["no screen module"],
      missing: [],
      pageErrors: []
    };
  root?.unmount();
  root = null;
  host?.remove();
  pageErrors.length = 0;
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(theme);

  const fake = createFakeApi(
    mode,
    mode === "success" || mode === "empty" ? module.fixtures[mode] : {}
  );
  (window as unknown as { app: unknown }).app = fake.app;
  host = document.createElement("div");
  host.id = "screen-host";
  document.body.append(host);
  const stand = document.createElement("div");
  stand.setAttribute("data-harness", "");
  stand.style.height = "100vh";
  stand.style.padding = "1rem";
  stand.style.boxSizing = "border-box";
  stand.style.overflow = "auto";
  host.append(stand);
  root = createRoot(stand);
  root.render(module.render());

  const check = (): { frame: FrameSource; state: string | null; reasons: string[] } => {
    const found = frameOf(id, mode);
    const reasons = [...found.reasons];
    if (found.frame !== "none" && stand.isConnected)
      reasons.push(...evidenceReasons(mode, readEvidence(document.body)));
    if (
      mode === "success" &&
      registry.ribbons.includes(id) &&
      !document.querySelector("[data-path-ribbon]")
    )
      reasons.push("an object panel shows no path ribbon in success");
    if ((mode === "success" || mode === "empty") && fake.missing().length > 0)
      reasons.push(`no fixture for ${fake.missing().join(", ")}`);
    return { frame: found.frame, state: found.state, reasons };
  };

  let last = check();
  for (let waited = 0; last.reasons.length > 0 && waited < frameTimeoutMs; waited += pollMs) {
    await sleep(pollMs);
    last = check();
  }
  if (last.reasons.length === 0) {
    // A surface that is right and then flips (a late failure) is not in the state.
    await sleep(settleMs);
    last = check();
  }
  await document.fonts.ready;
  return {
    ...base,
    frame: last.frame,
    state: last.state,
    ok: last.reasons.length === 0 && pageErrors.length === 0,
    reasons: pageErrors.length > 0 ? [...last.reasons, "uncaught page error"] : last.reasons,
    missing: fake.missing(),
    pageErrors: [...pageErrors]
  };
}

export interface ScreensApi {
  ids: string[];
  mount(id: string, mode: ScreenMode, theme: ScreenTheme): Promise<MountResult>;
}

/** Called by the generated entry: publishes the screens the bundle holds. */
export function registerScreens(
  modules: Readonly<Record<string, ScreenModule>>,
  ribbons: readonly string[]
): void {
  const registry: Registry = { modules, ribbons };
  const api: ScreensApi = {
    ids: Object.keys(modules),
    mount: (id, mode, theme) => mount(registry, id, mode, theme)
  };
  (window as unknown as { __screens: ScreensApi }).__screens = api;
}

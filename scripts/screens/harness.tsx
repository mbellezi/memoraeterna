/**
 * The page side of the screens tool: it runs inside the fixture bundle. `mount` renders one surface
 * over a fake `window.app` in one mode and theme, waits for the surface's own frame to report
 * `[data-surface=<id>][data-state=<mode>]` (5 s at most) and answers with what it found.
 *
 * A surface that has its own frame (a panel inside `PanelFrame`) reports its state itself and a
 * disagreement fails. Only a hosted screen that has none yet (kind "hosted") is wrapped in a
 * stand-in frame that labels the mode; every other kind without its own frame fails. Either way the
 * check then needs DOM evidence that the surface really is in that state: an alert for error, a
 * busy or status region for loading, and neither for empty and success. The text of empty must
 * also differ from the text of success (`run.ts` compares the signatures).
 */
import { createRoot, type Root } from "react-dom/client";

import type {
  ScreenModule,
  ScreenMode,
  SurfaceKind
} from "../../apps/desktop/src/renderer/workspace/surfaces";
import { readEvidence } from "./evidence";
import { createFakeApi } from "./fake-api";
import {
  resolveFrame,
  stateReasons,
  textSignature,
  untilState,
  type FrameNode,
  type FrameSource
} from "./frame";

export type { FrameSource };
export type ScreenTheme = "light" | "dark";

export interface MountResult {
  surface: string;
  mode: ScreenMode;
  theme: ScreenTheme;
  frame: FrameSource;
  /** What `data-state` said when the check ended. */
  state: string | null;
  /** A signature of the text shown when the check ended (empty must differ from success). */
  signature: string;
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
  kinds: Readonly<Record<string, SurfaceKind>>;
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
      signature: "",
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
    mode === "success" || mode === "empty" ? module.fixtures[mode] : {},
    mode === "error" ? module.fixtures.error : {}
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

  const kind = registry.kinds[id] ?? "panel";
  const check = () => {
    const frame = resolveFrame(
      [...document.querySelectorAll<HTMLElement>("[data-surface]")] as FrameNode[],
      stand as FrameNode,
      id,
      mode,
      kind
    );
    const reasons = stateReasons({
      mode,
      ribbon: registry.ribbons.includes(id),
      ribbonShown: document.querySelector("[data-path-ribbon]") !== null,
      frame,
      evidence: readEvidence(document.body),
      mounted: stand.isConnected,
      missing: fake.missing()
    });
    return { frame: frame.frame, state: frame.state, reasons };
  };

  const last = await untilState(check, sleep, {
    timeoutMs: frameTimeoutMs,
    pollMs,
    settleMs
  });
  await document.fonts.ready;
  return {
    ...base,
    frame: last.frame,
    state: last.state,
    signature: textSignature(stand.innerText),
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
  ribbons: readonly string[],
  kinds: Readonly<Record<string, SurfaceKind>>
): void {
  const registry: Registry = { modules, ribbons, kinds };
  const api: ScreensApi = {
    ids: Object.keys(modules),
    mount: (id, mode, theme) => mount(registry, id, mode, theme)
  };
  (window as unknown as { __screens: ScreensApi }).__screens = api;
}

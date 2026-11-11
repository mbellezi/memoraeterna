import { useCallback, useEffect, useReducer, useRef, useState, type Dispatch } from "react";

import { closePanelPriority, subscribeClosePanel } from "../lib/close-panel";
import { subscribeWindowNavigation } from "../lib/window-navigation";
import { createWorkspaceSaver, loadWorkspace } from "./persist";
import { reduce, type WorkspaceAction, type WorkspaceState } from "./state";

/**
 * The workspace as React state (D8, D9): the reducer of `state.ts` over the persisted state, saved
 * at most every 500 ms and flushed on unload; focus mode (⌘⇧F), which is a moment's choice and not
 * persisted; and the stack's share of the window commands. ⌘W closes the focused panel of the
 * destination on screen, and ⌘[ / ⌘] (and the mouse buttons) walk its history, before the old
 * views' own handlers; with the root focused, both fall through to them.
 */
export interface Workspace {
  workspace: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  focusMode: boolean;
  toggleFocusMode: () => void;
}

/** The stack commands come before the old views' handlers (priority 0) and after any dialog. */
export const stackNavigationPriority = 1;

/** The focused panel of the destination on screen, or null when the root (or Settings) is. */
export function focusedPanel(state: WorkspaceState): number | null {
  if (state.destination === "settings") return null;
  const stack = state.stacks[state.destination];
  return stack.focus >= 0 && stack.focus < stack.panels.length ? stack.focus : null;
}

export function useWorkspace(options: { commands?: boolean } = {}): Workspace {
  const commands = options.commands ?? true;
  const [workspace, dispatch] = useReducer(
    (state: WorkspaceState, action: WorkspaceAction) => reduce(state, action),
    undefined,
    () => loadWorkspace()
  );
  const [saver] = useState(() => createWorkspaceSaver());
  useEffect(() => {
    saver.save(workspace);
  }, [workspace, saver]);
  useEffect(() => {
    const flush = () => saver.flush();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [saver]);

  const [focusMode, setFocusMode] = useState(false);
  const toggleFocusMode = useCallback(() => setFocusMode((value) => !value), []);

  // The listeners read the state of the moment, not the one they were registered with.
  const latest = useRef(workspace);
  useEffect(() => {
    latest.current = workspace;
  }, [workspace]);
  useEffect(() => {
    if (!commands) return undefined;
    const offClose = subscribeClosePanel(() => {
      const panel = focusedPanel(latest.current);
      if (panel === null) return false;
      dispatch({ type: "close", panel });
      return true;
    }, closePanelPriority.panel);
    const offNavigation = subscribeWindowNavigation((direction) => {
      const state = latest.current;
      // Forward right after a close reopens the panel, even with the root focused (D8).
      const reopens =
        direction === "forward" &&
        state.destination !== "settings" &&
        state.stacks[state.destination].forwardReopens === true;
      if (focusedPanel(state) === null && !reopens) return false;
      dispatch({ type: direction });
      return true;
    }, stackNavigationPriority);
    return () => {
      offClose();
      offNavigation();
    };
  }, [commands]);

  return { workspace, dispatch, focusMode, toggleFocusMode };
}

/** The window's width, followed without a timer (a resize observer on the document). */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth
  );
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      const next = window.innerWidth;
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, []);
  return width;
}

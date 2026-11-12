import { useCallback, useState, type Dispatch, type ReactNode } from "react";
import type { Translator } from "@app/i18n";

import { ContextPanel } from "./ContextPanel";
import { focusedObject } from "./context-model";
import { contextMode } from "./layout-config";
import type { KeymapResult } from "./keymap";
import {
  contextTabFor,
  type ContextTabId,
  type WorkspaceAction,
  type WorkspaceState
} from "./state";

/**
 * The context panel as the application hosts it: whether it is shown (the workspace's `context`
 * flag, the stack on screen, no focus mode), the object and tab it follows, and the commands that
 * reach it (⌘⇧\ and ⌥1-⌥6). Below 1280 px the panel is a strip, and ⌘⇧\ opens and closes its
 * overlay instead of hiding it.
 */
export interface ContextHost {
  /** The panel, or null while it is not shown. */
  element: ReactNode;
  /** The shell reserves room for the panel (`LayoutChrome.context`). */
  present: boolean;
  /** Handles a keymap result that concerns the panel; false means the caller dispatches it. */
  command: (result: KeymapResult) => boolean;
}

export function useContextPanel(options: {
  t: Translator;
  workspace: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  viewportWidth: number;
  /** The destination's stack is on screen (Settings and the old screens cover it otherwise). */
  stackShown: boolean;
  focusMode: boolean;
}): ContextHost {
  const { t, workspace, dispatch, viewportWidth, stackShown, focusMode } = options;
  const [open, setOpen] = useState(false);
  const mode = contextMode(viewportWidth);
  const present = workspace.context && stackShown && !focusMode;
  const focus = focusedObject(workspace);
  const tab: ContextTabId = focus ? contextTabFor(workspace, focus.kind) : "connections";
  const stack =
    workspace.destination === "settings" ? null : workspace.stacks[workspace.destination];

  const onTab = useCallback(
    (next: ContextTabId) => {
      if (focus) dispatch({ type: "setContextTab", kind: focus.kind, tab: next });
    },
    [focus, dispatch]
  );
  const onOpen = useCallback(
    (address: string, options?: { replace?: boolean }) => {
      if (!stack) return;
      dispatch({
        type: "open",
        address,
        from: stack.focus,
        mode: options?.replace ? "replace" : "push"
      });
      // An overlay gives the panel back to what was opened.
      setOpen(false);
    },
    [stack, dispatch]
  );

  const command = (result: KeymapResult): boolean => {
    if (result.type === "toggleContext") {
      if (mode !== "strip" || !present) return false;
      setOpen((value) => !value);
      return true;
    }
    if (result.type === "contextTab") {
      // ⌥1-⌥6 show the panel when it is hidden, and open its overlay when it is a strip.
      if (!workspace.context && stackShown) dispatch({ type: "toggleContext" });
      if (focus) onTab(result.tab);
      if (mode === "strip") setOpen(true);
      return true;
    }
    return false;
  };

  return {
    present,
    command,
    element: present ? (
      <ContextPanel
        t={t}
        focus={focus}
        tab={tab}
        onTab={onTab}
        mode={mode}
        open={open}
        onOpenChange={setOpen}
        onOpen={onOpen}
        shown={stackShown}
      />
    ) : null
  };
}

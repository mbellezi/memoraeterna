import { createContext, useContext } from "react";

import type { WorkspaceAction, WorkspaceState } from "./state";

/**
 * What a destination's root needs of the workspace that `PanelProps` does not carry: the state it
 * reads (Home's `lastHomeOpenAt`, Explore's focus) and the reducer's `dispatch` (Home records its
 * own opening and resumes the trail). The panel stack provides it around every root and panel; a
 * screen module or a test that renders a root alone provides none, and the root then does nothing
 * beyond what its props say.
 */
export interface WorkspaceBridge {
  workspace: WorkspaceState;
  dispatch: (action: WorkspaceAction) => void;
}

export const WorkspaceBridgeContext = createContext<WorkspaceBridge | null>(null);

/** The workspace's state and reducer, or null where no panel stack hosts the caller. */
export function useWorkspaceBridge(): WorkspaceBridge | null {
  return useContext(WorkspaceBridgeContext);
}

/**
 * The app's Add command (Cmd-N, the title bar's Add), for a surface that offers it as a button: Home's
 * first run. It is the same command, so the button and the shortcut can never lead to different
 * places. Null where no app hosts the caller.
 */
export const AddSourceContext = createContext<(() => void) | null>(null);

export function useAddSource(): (() => void) | null {
  return useContext(AddSourceContext);
}

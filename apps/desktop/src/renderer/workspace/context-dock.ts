import { createContext, useContext } from "react";

/**
 * Whether the context panel is docked beside the stack (from 1280 px, while it is on; below that it
 * is a 40 px strip, and with it hidden nothing lists a page's relations). A note's body reads it:
 * while the panel is docked the body shows the stance summary, and otherwise the full list of
 * relations (design record 5.6, 6.3, amendment A2). The shell provides the value; until the context
 * panel exists nothing is docked.
 */
export const ContextDockContext = createContext(false);

export function useContextDocked(): boolean {
  return useContext(ContextDockContext);
}

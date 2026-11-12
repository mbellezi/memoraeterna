import { createContext, useContext } from "react";

/**
 * What Explore's root can ask of the app: the actions that are not a panel. The app provides them
 * (the root draws no button for an action nobody provides, so no control does nothing).
 */
export interface ExploreActions {
  /** "Add your first source": the same as Cmd-N. */
  onAddSource?: () => void;
}

export const ExploreActionsContext = createContext<ExploreActions>({});

export function useExploreActions(): ExploreActions {
  return useContext(ExploreActionsContext);
}

import { formatObjectAddress } from "@app/domain";

import { formatView } from "../route";
import type { WorkspaceAction } from "../state";

/**
 * What the workspace does when Adicionar finishes or asks for the advanced panel (D32), as the
 * actions the app dispatches in order. Kept apart from `App.tsx` so a test can run them through the
 * reducer.
 */

/** A Source was added: go to Explore and push it onto the stack at once, with no toast (A7). */
export function showSourceActions(sourceItemId: string): WorkspaceAction[] {
  return [
    {
      type: "firstSource",
      address: formatObjectAddress({ kind: "source", id: sourceItemId })
    }
  ];
}

/** "Mais opções de importação…", "Colar link" and "Escrever uma nota": the import panel beside the focused one. */
export function showImportPanelActions(focus: number): WorkspaceAction[] {
  return [
    { type: "go", destination: "explore" },
    { type: "open", address: formatView({ view: "import" }), from: focus, mode: "push" }
  ];
}

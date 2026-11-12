import { useSyncExternalStore } from "react";
import type { Translator } from "@app/i18n";

import type { WorkspaceAction, WorkspaceState } from "../state";
import { runCommand, type PaletteActions } from "./commands";
import { Palette } from "./Palette";
import { palette, type PaletteStore } from "./palette-store";
import { openActions, type PaletteEffect } from "./palette-model";

/**
 * The app's one Cmd-K: it draws the palette while the store says it is open and carries out what a
 * chosen row asks for. An address opens right of the focused panel (or in it, for ⌥↵); from
 * Settings, which has no stack, it opens onto Explore's. Mount it once, beside the quick-look host.
 */
export interface PaletteHostProps {
  t: Translator;
  workspace: WorkspaceState;
  /** Applies workspace actions in order; the app first uncovers the stack if an old screen is over it. */
  dispatch: (actions: WorkspaceAction[]) => void;
  /** What the commands do outside the stack: the rail's places, Adicionar, the theme, focus mode. */
  actions: Omit<PaletteActions, "dispatch">;
  store?: PaletteStore;
}

export function PaletteHost({
  t,
  workspace,
  dispatch,
  actions,
  store = palette
}: PaletteHostProps) {
  const opened = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (!opened.open) return null;

  const onEffect = (effect: PaletteEffect) => {
    if (effect.type === "open") dispatch(openActions(workspace, effect.address, effect.replace));
    else
      runCommand(effect.commandId, workspace, {
        ...actions,
        dispatch: (action) => dispatch([action])
      });
  };
  return (
    <Palette
      key={opened.token}
      t={t}
      state={workspace}
      initialQuery={opened.initial}
      onEffect={onEffect}
      onClose={store.close}
    />
  );
}

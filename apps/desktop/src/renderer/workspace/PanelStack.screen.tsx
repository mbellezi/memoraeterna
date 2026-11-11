import { useEffect, useReducer, useState, type CSSProperties } from "react";

import { destinationRoots } from "./destinations";
import { fixtureAddresses, panelFixtures, standInPanels } from "./panel-screen-fixtures";
import { PanelStack, type PanelModule, type PanelProps } from "./PanelStack";
import { defaultWorkspace, reduce, type WorkspaceAction, type WorkspaceState } from "./state";
import { layoutCustomProperties } from "./shell-model";
import type { ScreenModule } from "./surfaces";
import { useViewportWidth } from "./use-workspace";
import { screenTranslator } from "./screen-locale";

export const surface = "panel-stack";

const t = screenTranslator();

export const fixtures: ScreenModule["fixtures"] = {
  success: panelFixtures(false),
  empty: panelFixtures(true)
};

/** Explore's root stands in for the Explore root of T141: the stack's far-left item. */
const standInRoot: PanelModule = {
  kind: "destination-explore",
  match: (address) => address === destinationRoots.explore,
  title: () => "",
  Component: StandInRoot
};

function StandInRoot({ onState }: PanelProps) {
  useEffect(() => onState("success"), [onState]);
  return null;
}

/**
 * The trail of design record §8 in Explore: a source opened from the Library, a note, a question
 * asked about it, the topic its path leads to (the previous panel, its list marking the open note)
 * and that note on top. The stack, its spines, the "+N" spine at the window minimum and the frames
 * are the real components over the reducer of `state.ts`; the pages inside are stand-ins.
 */
function initial(): WorkspaceState {
  let state = reduce(defaultWorkspace("2026-11-11"), { type: "go", destination: "explore" });
  const trail = [
    fixtureAddresses.source,
    fixtureAddresses.note,
    fixtureAddresses.question,
    fixtureAddresses.topic,
    fixtureAddresses.topNote
  ];
  trail.forEach((address, index) => {
    state = reduce(state, { type: "open", address, from: index - 1, mode: "push" });
  });
  return state;
}

function Stack() {
  const [workspace, dispatch] = useReducer(
    (state: WorkspaceState, action: WorkspaceAction) => reduce(state, action),
    undefined,
    initial
  );
  const [focusMode, setFocusMode] = useState(false);
  const width = useViewportWidth();
  return (
    // The shell writes the layout constants the stack reads; here the screen does.
    <div className="h-full bg-background" style={layoutCustomProperties(width) as CSSProperties}>
      <PanelStack
        t={t}
        workspace={workspace}
        dispatch={dispatch}
        viewportWidth={width}
        // The navigator the shell shows in Explore takes its width, as in the app.
        chrome={{ navigator: true, context: false }}
        focusMode={focusMode}
        onToggleFocusMode={() => setFocusMode((value) => !value)}
        registry={[...standInPanels, standInRoot]}
      />
    </div>
  );
}

export function render() {
  return <Stack />;
}

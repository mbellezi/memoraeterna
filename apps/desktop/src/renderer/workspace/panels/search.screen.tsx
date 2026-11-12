import { useCallback, useState, type CSSProperties } from "react";

import { PanelFrame, type PanelLoadState } from "../PanelFrame";
import { omniFixture, recentFixture, resolveManyFixture } from "../palette/palette-fixtures";
import { formatView } from "../route";
import { screenTranslator } from "../screen-locale";
import { layoutCustomProperties } from "../shell-model";
import type { ScreenModule } from "../surfaces";
import { useViewportWidth } from "../use-workspace";
import { Component, title } from "./search.panel";
import { searchAddress } from "./search/search-model";

export const surface = "search";

const t = screenTranslator();
const noop = () => undefined;
const address = formatView({ view: "search", query: "ferment" });

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "search.omni": omniFixture(false),
    "objects.resolveMany": resolveManyFixture(),
    "viewHistory.list": recentFixture(false)
  },
  empty: {
    "search.omni": omniFixture(true),
    "objects.resolveMany": resolveManyFixture(),
    "viewHistory.list": recentFixture(true)
  }
};

/** One search panel in its frame: the real component and the real frame. */
function FramedSearch({ mode }: { mode: "full" | "compact" }) {
  const [state, setState] = useState<PanelLoadState>("loading");
  const [focusMode, setFocusMode] = useState(false);
  const [open, setOpen] = useState(address);
  const report = useCallback((next: PanelLoadState) => setState(next), []);
  const top = mode === "full";
  return (
    <PanelFrame
      t={t}
      surface={surface}
      address={open}
      kind={null}
      kindLabel={title(null, t)}
      title={title(null, t)}
      mode={mode}
      top={top}
      state={state}
      canBack={false}
      canForward={false}
      onBack={noop}
      onForward={noop}
      onClose={noop}
      focusMode={focusMode}
      onToggleFocusMode={() => setFocusMode((value) => !value)}
      onPin={noop}
      onOpen={noop}
    >
      <Component
        t={t}
        address={open}
        mode={mode}
        active
        onState={report}
        onPlace={noop}
        // A filter chip replaces the panel's content, as in the stack.
        onOpen={(next) => setOpen(next === searchAddress("ferment", []) ? address : next)}
        {...(top ? {} : { current: "memora://note/00000000-0000-4000-8000-000000000021" })}
      />
    </PanelFrame>
  );
}

/** The panel as the stack draws it at the window minimum: compact beside it when there is room. */
function Stack() {
  const width = useViewportWidth();
  return (
    <div
      className="flex h-full bg-background"
      style={layoutCustomProperties(width) as CSSProperties}
    >
      <div className="w-(--spine-w) shrink-0 border-r border-border" aria-hidden="true" />
      <div className="flex min-w-0 flex-1">
        <FramedSearch mode="full" />
      </div>
    </div>
  );
}

export function render() {
  return <Stack />;
}

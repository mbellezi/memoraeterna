import { useCallback, useState, type CSSProperties } from "react";

import type { PanelPlace } from "../PanelStack";
import { PanelFrame, type PanelLoadState } from "../PanelFrame";
import type { RibbonPlace } from "../PathRibbon";
import { screenTranslator } from "../screen-locale";
import { layoutCustomProperties } from "../shell-model";
import type { ScreenModule } from "../surfaces";
import { useViewportWidth } from "../use-workspace";
import { Component } from "./entity.panel";
import { entityFixture, entityFixtures } from "./entity/entity-fixtures";

export const surface = "entity";

const t = screenTranslator();
const noop = () => undefined;

export const fixtures: ScreenModule["fixtures"] = {
  success: entityFixtures(false),
  empty: entityFixtures(true)
};

/** One entity panel in its frame: the real component, the real frame and its path ribbon. */
function FramedEntity({ mode }: { mode: "full" | "compact" }) {
  const [state, setState] = useState<PanelLoadState>("loading");
  const [place, setPlace] = useState<RibbonPlace>("placed");
  const [focusMode, setFocusMode] = useState(false);
  const report = useCallback((next: PanelLoadState) => setState(next), []);
  const reportPlace = useCallback((next: PanelPlace) => setPlace(next.place), []);
  const top = mode === "full";
  return (
    <PanelFrame
      t={t}
      surface={surface}
      address={entityFixture.address}
      kind="entity"
      kindLabel={t("objects.kinds.entity")}
      title="Lactobacillus"
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
      ribbonPlace={place}
    >
      <Component
        t={t}
        address={entityFixture.address}
        mode={mode}
        active
        onState={report}
        onPlace={reportPlace}
        onOpen={noop}
        {...(top ? {} : { current: entityFixture.noteAddress })}
      />
    </PanelFrame>
  );
}

/**
 * The entity as the stack draws it at the window minimum: the previous panel in its compact form
 * (its list of notes, the one that was opened marked) and the top panel in full, on the desk with
 * the layout constants the shell writes.
 */
function Stack() {
  const width = useViewportWidth();
  return (
    <div
      className="flex h-full bg-background"
      style={layoutCustomProperties(width) as CSSProperties}
    >
      <div className="w-(--spine-w) shrink-0 border-r border-border" aria-hidden="true" />
      <div className="flex w-(--prev-w) shrink-0 border-r border-border">
        <FramedEntity mode="compact" />
      </div>
      <div className="flex min-w-0 flex-1">
        <FramedEntity mode="full" />
      </div>
    </div>
  );
}

export function render() {
  return <Stack />;
}

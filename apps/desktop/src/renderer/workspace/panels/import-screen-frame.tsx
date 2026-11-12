import { useCallback, useEffect, useState, type CSSProperties } from "react";

import { PanelFrame, type PanelLoadState } from "../PanelFrame";
import { screenTranslator } from "../screen-locale";
import { layoutCustomProperties } from "../shell-model";
import { useViewportWidth } from "../use-workspace";
import { Component } from "./import.panel";

const t = screenTranslator();
const noop = () => undefined;

/** `ImportView` looks metadata up 900 ms after the title settles; the frame waits for that answer. */
const enrichmentSettleMs = 1300;

/**
 * The advanced import panel in its real frame, on the desk beside one spine. Shared by the two
 * import screens (the new import and the edit address). A settled form looks things up after a
 * pause, so success shows once that answer is in; `onSettled` then runs, for a screen that wants
 * the form scrolled somewhere before it is captured.
 */
export function FramedImport({
  surface,
  address,
  onSettled
}: {
  surface: string;
  address: string;
  onSettled?: () => void;
}) {
  const [reported, setState] = useState<PanelLoadState>("loading");
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (reported !== "success") return undefined;
    const timer = window.setTimeout(() => setSettled(true), enrichmentSettleMs);
    return () => window.clearTimeout(timer);
  }, [reported]);
  const state: PanelLoadState = reported === "success" && !settled ? "loading" : reported;
  useEffect(() => {
    if (state !== "success" || !onSettled) return undefined;
    const frame = window.requestAnimationFrame(onSettled);
    return () => window.cancelAnimationFrame(frame);
  }, [state, onSettled]);
  const [focusMode, setFocusMode] = useState(false);
  const report = useCallback((next: PanelLoadState) => setState(next), []);
  const width = useViewportWidth();
  return (
    <div
      className="flex h-full bg-background"
      style={layoutCustomProperties(width) as CSSProperties}
    >
      <div className="w-(--spine-w) shrink-0 border-r border-border" aria-hidden="true" />
      <div className="flex min-w-0 flex-1">
        <PanelFrame
          t={t}
          surface={surface}
          address={address}
          kind={null}
          kindLabel={t("addFlow.importPanel.title")}
          title={t("addFlow.importPanel.title")}
          mode="full"
          top
          state={state}
          canBack={false}
          canForward={false}
          onBack={noop}
          onForward={noop}
          onClose={noop}
          focusMode={focusMode}
          onToggleFocusMode={() => setFocusMode((value) => !value)}
          onOpen={noop}
        >
          <Component
            t={t}
            address={address}
            mode="full"
            active
            onState={report}
            onPlace={noop}
            onOpen={noop}
          />
        </PanelFrame>
      </div>
    </div>
  );
}

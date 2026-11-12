import { useCallback, useEffect, useState, type CSSProperties, type ComponentType } from "react";

import type { PanelPlace, PanelProps } from "../../PanelStack";
import { PanelFrame, type PanelLoadState } from "../../PanelFrame";
import type { RibbonPlace } from "../../PathRibbon";
import { screenTranslator } from "../../screen-locale";
import { layoutCustomProperties } from "../../shell-model";
import { useViewportWidth } from "../../use-workspace";
import type { ObjectKind } from "@app/domain";

/**
 * What the screen modules of the Ask and Question panels share: the panel in its real frame, the
 * stack around it as the window draws it (the previous panel in its compact form and the top panel
 * in full), a hand that delivers bus events (the screens tool's fake `window.app` never delivers
 * one), and the focus that puts a citation chip, and so its passage, in reach for a capture. Only
 * the screen modules import this file.
 */

const noop = () => undefined;
export const t = screenTranslator();

export interface FramedPanelProps {
  surface: string;
  address: string;
  kind: ObjectKind | null;
  kindLabel: string;
  title: string;
  Component: ComponentType<PanelProps>;
  mode: "full" | "compact";
  current?: string;
}

/** What a frame in the stack shares with the others: the top panel's state, and who follows it. */
interface StackState {
  /** The top panel tells the stack what it reports. */
  report?: (state: PanelLoadState) => void;
  /** The state to write on this frame instead of the panel's own (the previous panel's frame). */
  follow?: PanelLoadState;
}

function FramedPanel({
  surface,
  address,
  kind,
  kindLabel,
  title,
  Component,
  mode,
  current,
  report: tell,
  follow
}: FramedPanelProps & StackState) {
  const [own, setState] = useState<PanelLoadState>("loading");
  const state = follow ?? own;
  const [place, setPlace] = useState<RibbonPlace>("placed");
  const [focusMode, setFocusMode] = useState(false);
  const report = useCallback(
    (next: PanelLoadState) => {
      setState(next);
      tell?.(next);
    },
    [tell]
  );
  const reportPlace = useCallback((next: PanelPlace) => setPlace(next.place), []);
  const top = mode === "full";
  return (
    <PanelFrame
      t={t}
      surface={surface}
      address={address}
      kind={kind}
      kindLabel={kindLabel}
      title={title}
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
        address={address}
        mode={mode}
        active
        onState={report}
        onPlace={reportPlace}
        onOpen={noop}
        {...(current === undefined ? {} : { current })}
      />
    </PanelFrame>
  );
}

/**
 * What the Question was opened beside: a topic panel in its compact form. It reads nothing (no
 * `window.app` call), so a failed read in a capture is the top panel's alone: one cause shows one
 * failure. Its title and the notes it lists stand for the person's own content.
 */
function TopicStandIn({ onState }: PanelProps) {
  useEffect(() => onState("success"), [onState]);
  return (
    <div className="grid min-w-0 gap-3">
      <h1 className="m-0 font-reading text-lg font-semibold leading-snug text-foreground">
        Lactic fermentation
      </h1>
      <ul className="m-0 grid list-none gap-2 p-0 text-sm text-secondary-foreground">
        <li>Lactic acid inhibits pathogens by lowering the pH</li>
        <li>Temperature controls the final acidity</li>
        <li>Sauerkraut starts with a salt brine, not with a starter</li>
      </ul>
    </div>
  );
}

/** The panel the Question or the Ask was opened from, drawn beside it as the stack does. */
export const openedFrom: Omit<FramedPanelProps, "mode"> = {
  // Not an object address: the stand-in has no place to read, so its frame draws no ribbon. The
  // stack names its own surface on both frames.
  surface: "",
  address: "memora://topic",
  kind: "topic",
  kindLabel: t("objects.kinds.topic"),
  title: "Lactic fermentation",
  Component: TopicStandIn
};

/** A panel as the stack draws it at the window's width: the previous one compact, the top one full. */
export function PanelStackScreen(
  props: Omit<FramedPanelProps, "mode" | "current"> & { previous?: Omit<FramedPanelProps, "mode"> }
) {
  const width = useViewportWidth();
  const { previous, ...top } = props;
  // The frame of the previous panel writes the state of the top one: a capture reads one state for
  // the stack, and the previous panel's stand-in has no read of its own to fail.
  const [topState, setTopState] = useState<PanelLoadState>("loading");
  return (
    <div
      className="flex h-full bg-background"
      style={layoutCustomProperties(width) as CSSProperties}
    >
      <div className="w-(--spine-w) shrink-0 border-r border-border" aria-hidden="true" />
      <div className="flex w-(--prev-w) shrink-0 border-r border-border">
        <FramedPanel
          {...(previous ?? top)}
          surface={top.surface}
          mode="compact"
          {...(previous ? { follow: topState } : {})}
        />
      </div>
      <div className="flex min-w-0 flex-1">
        <FramedPanel {...top} mode="full" report={setTopState} />
      </div>
    </div>
  );
}

type Handler = (event: unknown) => void;

/**
 * Wraps the fake `window.app` so `onAppEvent` delivers what `script` says, after the handler of
 * each type is registered: the screens tool answers every subscription with a no-op. `script` maps
 * an event type to the payloads to deliver, in order, one `stepMs` apart.
 */
export function deliverEvents(
  script: Readonly<Record<string, readonly unknown[]>>,
  stepMs = 60
): void {
  const base = (window as unknown as { app: object }).app;
  const wrapped = new Proxy(base, {
    get(target, key, receiver) {
      if (key !== "onAppEvent") return Reflect.get(target, key, receiver) as unknown;
      return (type: string, handler: Handler) => {
        const events = script[type] ?? [];
        const timers = events.map((event, index) =>
          setTimeout(() => handler(event), stepMs * (index + 1))
        );
        return () => timers.forEach((timer) => clearTimeout(timer));
      };
    }
  });
  (window as unknown as { app: object }).app = wrapped;
}

/**
 * Reaches the chip `number` as soon as the answer has drawn it, so its passage is open in the list
 * (or the tray) in the capture. An offscreen window has no focus, so a focus event never fires
 * there: the pointer's own event does the same work (a chip answers to either).
 */
export function useFocusCitation(number: number): void {
  useEffect(() => {
    let done = false;
    const reach = () => {
      const chip = document.querySelector<HTMLElement>(`[data-citation="${number}"]`);
      if (!chip || done) return;
      done = true;
      chip.focus({ preventScroll: true });
      chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    };
    const observer = new MutationObserver(reach);
    observer.observe(document.body, { childList: true, subtree: true });
    reach();
    return () => observer.disconnect();
  }, [number]);
}

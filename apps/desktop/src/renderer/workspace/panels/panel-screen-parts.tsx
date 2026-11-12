import { useCallback, useState, type CSSProperties } from "react";
import type { ObjectKind, ObjectLocateResult, ObjectRef } from "@app/domain";

type TopicRef = ObjectRef & { kind: "topic" };

import { PanelFrame, type PanelLoadState } from "../PanelFrame";
import type { PanelPlace, PanelProps } from "../PanelStack";
import type { RibbonPlace } from "../PathRibbon";
import { screenTranslator } from "../screen-locale";
import { layoutCustomProperties } from "../shell-model";
import { useViewportWidth } from "../use-workspace";

/**
 * What the Note and Topic panels' screen modules share: the ribbon's read (`objects.locate`) over
 * the library of design record 17, and the stack as the window minimum draws it (a spine, the
 * previous panel in its compact form, the top panel in full), made of the real frame and the real
 * panel. Only the screen modules import this file.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const topicRef = (n: number, title: string): TopicRef => ({ kind: "topic", id: uuid(n), title });

/** Root, Life sciences, Microbiology, Fermentation: where the fixtures' objects sit. */
export const placePath: TopicRef[] = [
  topicRef(1, ""),
  topicRef(2, "Life sciences"),
  topicRef(3, "Microbiology"),
  topicRef(5, "Fermentation")
];

/** The answer of `objects.locate` for an object placed under `path`, with a second place. */
export function located(
  kind: ObjectKind,
  id: string,
  title: string,
  options: { path?: TopicRef[]; alsoIn?: TopicRef[] } = {}
): ObjectLocateResult {
  const path = options.path ?? placePath;
  const object: ObjectRef = { kind, id, title };
  const alsoIn = options.alsoIn ?? [];
  return {
    object,
    primaryPath: kind === "topic" ? path : [...path, object],
    alsoIn,
    citedBy: [],
    counts: { alsoIn: alsoIn.length, citedBy: 0, notes: 0, passages: 0, children: 0 }
  };
}

const t = screenTranslator();
const noop = () => undefined;

interface FramedProps {
  surface: string;
  kind: ObjectKind;
  address: string;
  title: string;
  mode: "full" | "compact";
  Component: (props: PanelProps) => React.ReactNode;
  /** For the compact form: the address of the panel that was opened from it. */
  current?: string;
}

/** One panel in its frame, the way the stack draws it: the frame writes the surface and state. */
function Framed({ surface, kind, address, title, mode, Component, current }: FramedProps) {
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
      address={address}
      kind={kind}
      kindLabel={t(`objects.kinds.${kind}`)}
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
        {...(current ? { current } : {})}
      />
    </PanelFrame>
  );
}

export interface PanelStackScreenProps {
  surface: string;
  kind: ObjectKind;
  Component: FramedProps["Component"];
  /** The previous panel (compact) and the top panel (full). */
  previous: { address: string; title: string };
  top: { address: string; title: string };
}

/** The window minimum's stack: a spine, the previous panel compact, and the top panel in full. */
export function PanelStackScreen({
  surface,
  kind,
  Component,
  previous,
  top
}: PanelStackScreenProps) {
  const width = useViewportWidth();
  return (
    <div
      className="flex h-full bg-background"
      style={layoutCustomProperties(width) as CSSProperties}
    >
      <div className="w-(--spine-w) shrink-0 border-r border-border" aria-hidden="true" />
      <div className="flex w-(--prev-w) shrink-0 border-r border-border">
        <Framed
          surface={surface}
          kind={kind}
          Component={Component}
          mode="compact"
          address={previous.address}
          title={previous.title}
          current={top.address}
        />
      </div>
      <div className="flex min-w-0 flex-1">
        <Framed
          surface={surface}
          kind={kind}
          Component={Component}
          mode="full"
          address={top.address}
          title={top.title}
        />
      </div>
    </div>
  );
}

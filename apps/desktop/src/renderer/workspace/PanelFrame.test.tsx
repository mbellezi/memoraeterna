import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, type Translator } from "@app/i18n";
import type { ObjectLocateResult } from "@app/domain";

import { PanelFrame, panelStates, pressFocusesPanel, type PanelFrameProps } from "./PanelFrame";
import {
  foldMiddle,
  isUnsorted,
  PathRibbon,
  PathRibbonView,
  ribbonSegments,
  type Located
} from "./PathRibbon";
import { defaultWorkspace } from "./state";
import { focusedPanel } from "./use-workspace";

const en = createTranslator("en");
const pt = createTranslator("pt-BR");
const noop = () => undefined;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const noteAddress = `memora://note/${uuid(1)}`;

function frame(props: Partial<PanelFrameProps> = {}, t: Translator = en) {
  return renderToString(
    <PanelFrame
      t={t}
      surface="note"
      address={noteAddress}
      kind="note"
      kindLabel="Note"
      title="Lactic acid lowers the pH"
      mode="full"
      top
      state="success"
      canBack={false}
      canForward={false}
      onBack={noop}
      onForward={noop}
      onClose={noop}
      onOpen={noop}
      onToggleFocusMode={noop}
      {...props}
    >
      <h1>Lactic acid lowers the pH</h1>
    </PanelFrame>
  );
}

describe("the panel frame", () => {
  it.each(panelStates)("writes the panel's own %s state on its frame", (state) => {
    const html = frame({ state });
    expect(html).toContain('data-surface="note"');
    expect(html).toContain(`data-state="${state}"`);
  });

  it("shows the path ribbon above an object page, and none on a view panel", () => {
    expect(frame()).toContain("data-path-ribbon");
    expect(frame()).toContain('aria-label="Place in the tree"');
    expect(
      frame({
        address: "memora://search?q=salt",
        kind: null,
        kindLabel: "Search",
        surface: "search"
      })
    ).not.toContain("data-path-ribbon");
  });

  it("gives the top panel Foco and close, and the arrows only where history exists", () => {
    const top = frame({}, pt);
    expect(top).toContain("Foco");
    expect(top).toContain('aria-label="Fechar painel"');
    expect(top).not.toContain("Voltar neste painel");
    const history = frame({ canBack: true, canForward: true }, pt);
    expect(history).toContain('aria-label="Voltar neste painel"');
    expect(history).toContain('aria-label="Avançar neste painel"');
    expect(frame({ focusMode: true }, pt)).toContain("Modo foco · Esc sai");
  });

  it("shows only the kind and close on the previous panel, at its compact size", () => {
    const html = frame({ mode: "compact", top: false, canBack: true }, pt);
    expect(html).toContain('data-panel-mode="compact"');
    expect(html).not.toContain("Foco");
    expect(html).not.toContain("Voltar neste painel");
    expect(html).toContain('aria-label="Fechar painel"');
  });

  it("returns to the previous panel on a press of its surface, never of its controls", () => {
    const frameNode = { closest: () => null };
    const row = { role: "row button" };
    // A press on a list row or on × reaches the control itself: the panel does not jump first.
    expect(pressFocusesPanel({ closest: () => row }, frameNode)).toBe(false);
    // A press on the panel's text or padding makes it the top.
    expect(pressFocusesPanel({ closest: () => null }, frameNode)).toBe(true);
    expect(pressFocusesPanel({ closest: () => frameNode }, frameNode)).toBe(true);
    expect(pressFocusesPanel(null, frameNode)).toBe(true);
  });

  it("offers the pin only where a pin action exists", () => {
    expect(frame({}, pt)).not.toContain("Fixar no navegador");
    expect(frame({ onPin: noop }, pt)).toContain('aria-label="Fixar no navegador"');
  });
});

describe("the path ribbon", () => {
  const ref = (kind: "topic" | "source" | "note", n: number, title: string) => ({
    kind,
    id: uuid(n),
    title
  });
  const located = (path: ObjectLocateResult["primaryPath"], object = path.at(-1)!) =>
    ({
      object,
      primaryPath: path,
      alsoIn: [],
      citedBy: [],
      counts: { alsoIn: 0, citedBy: 0, notes: 0, passages: 0, children: 0 }
    }) as ObjectLocateResult;

  it("lists the topics from the root down, without the untitled root, the sources or the note", () => {
    const segments = ribbonSegments(
      located([
        ref("topic", 1, ""),
        ref("topic", 2, "Life sciences"),
        ref("topic", 3, "Fermentation"),
        ref("source", 4, "Food microbiology"),
        ref("note", 5, "Lactic acid")
      ])
    );
    expect(segments.map((segment) => segment.title)).toEqual(["Life sciences", "Fermentation"]);
    expect(segments[0]?.address).toBe(`memora://topic/${uuid(2)}`);
  });

  it("lists a topic's ancestors, not the topic itself", () => {
    const segments = ribbonSegments(
      located([
        ref("topic", 1, ""),
        ref("topic", 2, "Life sciences"),
        ref("topic", 3, "Fermentation")
      ])
    );
    expect(segments.map((segment) => segment.title)).toEqual(["Life sciences"]);
  });

  it("keeps the root and the leaf when the middle folds", () => {
    const crumbs = ["a", "b", "c", "d", "e"];
    expect(foldMiddle(crumbs, 0)).toEqual(crumbs);
    expect(foldMiddle(crumbs, 2)).toEqual(["a", { folded: 2 }, "d", "e"]);
    expect(foldMiddle(crumbs, 99)).toEqual(["a", { folded: 3 }, "e"]);
    expect(foldMiddle(["a", "b"], 5)).toEqual(["a", "b"]);
  });

  const ribbon = (address: string, read: Located, props: { place?: "tentativeSource" } = {}) =>
    renderToString(
      <PathRibbonView
        t={pt}
        address={address}
        onOpen={noop}
        located={read}
        onRetry={noop}
        {...props}
      />
    );

  it("draws a top-level topic as placed, never as unsorted", () => {
    const topic = ref("topic", 2, "Life sciences");
    const read = located([ref("topic", 1, ""), topic]);
    expect(ribbonSegments(read)).toEqual([]);
    expect(isUnsorted(read)).toBe(false);
    const html = ribbon(`memora://topic/${topic.id}`, { status: "ready", located: read });
    expect(html).toContain('data-ribbon-state="placed"');
    expect(html).toContain("No primeiro nível da árvore");
    expect(html).not.toContain("Sem lugar");
  });

  it("draws an object with no topic in its path as unsorted", () => {
    const loose = located([ref("source", 4, "Food microbiology"), ref("note", 5, "Lactic acid")]);
    expect(isUnsorted(loose)).toBe(true);
    expect(isUnsorted(null)).toBe(true);
    const html = ribbon(noteAddress, { status: "ready", located: loose });
    expect(html).toContain('data-ribbon-state="unsorted"');
    expect(html).toContain("Sem lugar");
  });

  it("draws the place a panel reports as tentative with a dashed path", () => {
    const read = located([
      ref("topic", 1, ""),
      ref("topic", 2, "Life sciences"),
      ref("note", 5, "Lactic acid")
    ]);
    const html = ribbon(
      noteAddress,
      { status: "ready", located: read },
      { place: "tentativeSource" }
    );
    expect(html).toContain('data-ribbon-state="tentative"');
    expect(html).toContain("Lugar provável:");
  });

  it("shows a busy skeleton while it reads the place", () => {
    const html = renderToString(<PathRibbon t={pt} address={noteAddress} onOpen={noop} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Procurando lugar na árvore…");
  });
});

describe("the stack's window commands", () => {
  it("act on the focused panel of the destination on screen, never on a root or Settings", () => {
    const state = defaultWorkspace("2026-11-11");
    expect(focusedPanel(state)).toBeNull();
    state.destination = "explore";
    state.stacks.explore = {
      ...state.stacks.explore,
      panels: [{ id: "p0", history: [noteAddress], index: 0 }],
      focus: 0
    };
    expect(focusedPanel(state)).toBe(0);
    expect(focusedPanel({ ...state, destination: "settings" })).toBeNull();
  });
});

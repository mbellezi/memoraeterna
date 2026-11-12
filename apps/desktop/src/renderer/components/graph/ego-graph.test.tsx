import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ObjectNeighborhood } from "@app/domain";
import { createTranslator, supportedLanguageCodes, type Translator } from "@app/i18n";

import { EgoGraphBody } from "./EgoGraph";
import type { Load, Reread } from "./ego-graph-reads";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const node = (n: number, depth: 0 | 1 | 2) => ({
  id: id(n),
  kind: "note" as const,
  title: `Note ${n}`,
  ideaStatement: `Idea ${n}.`,
  language: null,
  depth
});
const edge = (
  n: number,
  lo: number,
  hi: number,
  overrides: Partial<ObjectNeighborhood["edges"][number]> = {}
): ObjectNeighborhood["edges"][number] => ({
  id: id(100 + n),
  lo: id(lo),
  hi: id(hi),
  direction: "lo_to_hi",
  type: "supports",
  state: "kept",
  band: null,
  ...overrides
});
const answer = (overrides: Partial<ObjectNeighborhood> = {}): ObjectNeighborhood => ({
  focus: id(1),
  depth: 1,
  nodes: [node(1, 0), node(2, 1), node(3, 1)],
  edges: [
    edge(1, 1, 2, { state: "suggested", band: "suggest" }),
    edge(2, 1, 3, { type: "contradicts", direction: "symmetric" })
  ],
  neighbourTotal: 2,
  truncated: false,
  ...overrides
});

const noop = () => undefined;
function render(
  load: Load,
  t: Translator = createTranslator("en"),
  reread: Reread = "idle"
): string {
  return renderToString(
    <EgoGraphBody
      t={t}
      load={load}
      reread={reread}
      onDepth={noop}
      onRetry={noop}
      onRetryReread={noop}
      onOpenNote={noop}
      onUnavailable={noop}
      onShowList={noop}
    />
  ).replaceAll("<!-- -->", "");
}
const ready = (value: ObjectNeighborhood = answer()): Load => ({ status: "ready", answer: value });
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("the relation graph states", () => {
  it("is a busy placeholder with a spoken label while loading", () => {
    const html = render({ status: "loading" });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(text(html)).toContain("Loading the connection graph…");
  });

  it("is a retryable alert when the answer failed", () => {
    const html = render({ status: "error" });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("The connection graph could not be loaded.");
    expect(html).toContain(">Retry<");
  });

  it("says there is nothing to draw for a note with no shown relation, and offers the list", () => {
    const html = render(ready(answer({ nodes: [node(1, 0)], edges: [], neighbourTotal: 0 })));
    expect(text(html)).toContain("This note has no connections to draw yet.");
    expect(text(html)).toContain("See as a list");
    expect(html).not.toContain('role="application"');
  });

  it("draws the canvas for a note with relations: named, keyboard-reachable and described", () => {
    const html = render(ready());
    expect(html).toContain('role="application"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(
      'aria-label="Connection graph: 3 notes and 2 connections. Drag the background to pan; the List shows this note&#x27;s connections as text."'
    );
    expect(text(html)).toContain("3 notes · 2 connections");
    // One word to show the list, the context panel's own.
    expect(text(html)).toContain("See as a list");
    expect(text(html)).toContain("Keyboard: Tab to the graph");
    // The canvas names a hint element that exists.
    const hint = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(hint).toBeDefined();
    expect(html).toContain(`id="${hint}"`);
    for (const label of ["Fit graph to view", "Zoom in", "Zoom out"])
      expect(html).toContain(`aria-label="${label}"`);
  });

  it("toggles the second ring with a pressed button and says so", () => {
    expect(render(ready())).toContain('aria-pressed="false"');
    // The toggle says what is drawn: a graph of depth 2 is pressed.
    expect(render(ready(answer({ depth: 2 })))).toContain('aria-pressed="true"');
    expect(text(render(ready()))).toContain("Include the connections of linked notes");
  });
});

describe("a read made while the graph is shown", () => {
  const toggle = (html: string) => /<button[^>]*aria-pressed[^>]*>/u.exec(html)?.[0] ?? "";

  it("marks the toggle busy while the depth the person asked for is read, and never otherwise", () => {
    expect(toggle(render(ready(), createTranslator("en"), "pending"))).toContain(
      'aria-busy="true"'
    );
    for (const reread of ["idle", "failed"] as const)
      expect(toggle(render(ready(), createTranslator("en"), reread))).not.toContain("aria-busy");
  });

  it("keeps the last graph, says the read failed and offers it again after a failed reread", () => {
    const html = render(ready(), createTranslator("en"), "failed");
    // The toggle still says what is drawn (depth 1) and can be pressed again.
    expect(toggle(html)).toContain('aria-pressed="false"');
    expect(toggle(html)).not.toMatch(/\sdisabled[=\s>]/u);
    expect(html).toContain('role="application"');
    const notice = /<div role="status"[^>]*>(?:(?!<\/div>).)*<\/div>/u.exec(html)?.[0] ?? "";
    expect(text(notice)).toContain(
      "The graph could not be updated, so it still shows the last connections it read."
    );
    expect(notice).toContain(">Retry<");
    expect(text(render(ready()))).not.toContain("could not be updated");
  });

  it("says when relations among the notes were left out of the drawing", () => {
    const many = Array.from({ length: 130 }, (_, n) => edge(n + 10, 2, 3, { id: id(500 + n) }));
    const html = render(ready(answer({ edges: [edge(1, 1, 2), ...many] })));
    expect(text(html)).toContain("Connections between these notes that are not drawn: 11.");
    expect(text(render(ready()))).not.toContain("not drawn");
  });
});

describe("the legend", () => {
  it("tells suggestions from kept relations in words and in a pattern, not by colour alone", () => {
    const html = render(ready());
    expect(text(html)).toContain("Solid line: a connection you kept or that was applied");
    expect(text(html)).toContain("Dashed line: a suggestion nobody has kept yet");
    // The dashed sample is the pattern the canvas draws.
    expect(html).toContain('stroke-dasharray="7 5"');
    expect(text(html)).toContain("Arrow: the connection reads from one note to the other");
    // Each stance drawn has its word and glyph next to its colour.
    expect(text(html)).toContain("supports");
    expect(text(html)).toContain("contradicts");
    expect(text(html)).toContain("Larger node: this note");
  });

  it("lists only what is drawn", () => {
    const keptOnly = render(
      ready(answer({ edges: [edge(1, 1, 2, { type: "contradicts", direction: "symmetric" })] }))
    );
    expect(text(keptOnly)).toContain("Solid line");
    expect(text(keptOnly)).not.toContain("Dashed line");
    expect(text(keptOnly)).not.toContain("Arrow:");
    const suggestionsOnly = render(
      ready(
        answer({
          edges: [
            edge(1, 1, 2, {
              state: "suggested",
              band: "suggest",
              type: "contradicts",
              direction: "symmetric"
            })
          ]
        })
      )
    );
    expect(text(suggestionsOnly)).toContain("Dashed line");
    expect(text(suggestionsOnly)).not.toContain("Solid line");
  });

  it("says how many related notes the list has beyond the ones drawn", () => {
    expect(text(render(ready(answer({ neighbourTotal: 57, truncated: true }))))).toContain(
      "Showing 2 of 57 linked notes. The List has all of them."
    );
    expect(text(render(ready()))).not.toContain("related notes. The List has");
  });
});

describe("the relation graph in every interface language", () => {
  it("leaves no message key or placeholder on screen", () => {
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      for (const load of [
        { status: "loading" } as const,
        { status: "error" } as const,
        ready(),
        ready(answer({ neighbourTotal: 50, truncated: true })),
        ready(answer({ nodes: [node(1, 0)], edges: [] }))
      ]) {
        for (const reread of ["idle", "failed"] as const) {
          const visible = text(render(load, t, reread));
          expect(visible, locale).not.toMatch(/notePage\.|knowledgeGraph\.|shell\.|\{[a-z]+\}/u);
        }
      }
      // The notice, the omitted-relations line and the lost-context message are written in each language.
      const many = Array.from({ length: 130 }, (_, n) => edge(n + 10, 2, 3, { id: id(500 + n) }));
      const wide = text(render(ready(answer({ edges: [edge(1, 1, 2), ...many] })), t, "failed"));
      expect(wide, locale).not.toMatch(/notePage\.|knowledgeGraph\.|shell\.|\{[a-z]+\}/u);
      for (const key of ["rereadError", "contextLost", "omitted", "label"] as const)
        expect(
          t(`notePage.graph.${key}`, { values: { count: 1, notes: 2, relations: 3 } })
        ).not.toBe(`notePage.graph.${key}`);
    }
  });
});

// The ego graph and the Map › Grafo canvas (T151) draw from the same tokens.
const sources = import.meta.glob<string>(
  [
    "./EgoGraph.tsx",
    "./LineSamples.tsx",
    "./labels.ts",
    "../../workspace/destinations/map/relations/RelationsCanvas.tsx",
    "../../workspace/destinations/map/relations/RelationsLens.tsx",
    "../../workspace/destinations/map/relations/branch-sigma.ts"
  ],
  { query: "?raw", import: "default", eager: true }
);

describe("the graph styles", () => {
  it("use tokens only: no raw palette class, hex colour, rgba or arbitrary font size", () => {
    expect(Object.keys(sources)).toHaveLength(6);
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toMatch(
        /\b(slate|gray|zinc|cyan|violet|amber|rose|red|green|blue|emerald|sky)-\d{2,3}\b/u
      );
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
      expect(source, file).not.toMatch(/rgba?\(/u);
      expect(source, file).not.toMatch(/text-\[/u);
    }
  });

  it("never touch the window history or poll", () => {
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toContain("window.history");
      expect(source, file).not.toContain("setInterval");
    }
  });
});

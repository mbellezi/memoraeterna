import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { branchId, branchNotes, branchTopics, sampleBranch } from "./branch-fixtures";
import { buildBranchModel } from "./branch-model";
import { BranchNotices, DisplayToggle, GroupLinks, OutsideTopics } from "./lens-controls";
import { RelationsAside, RelationsTable } from "./RelationsTable";

const en = createTranslator("en");
const pt = createTranslator("pt-BR");
const scope = { kind: "topic", id: branchTopics.fermentation } as const;
const built = (t = en, answer = sampleBranch()) =>
  buildBranchModel(answer, { scope, colourDepth: 1, t });
const noop = () => undefined;

const table = (props: Partial<Parameters<typeof RelationsTable>[0]> = {}, t = en) =>
  renderToString(
    <RelationsTable
      t={t}
      model={built(t)}
      selected={null}
      onSelect={noop}
      onOpenNote={noop}
      {...props}
    />
  );

describe("the relations table", () => {
  it("is a grid named for its rows, with the columns De, Conexão and Para", () => {
    const html = table({}, pt);
    expect(html).toContain('role="grid"');
    expect(html).toContain("As mesmas conexões do grafo, uma linha por conexão");
    for (const word of ["De", "Conexão", "Para"]) expect(html).toContain(`>${word}</th>`);
    expect(html.match(/data-row-id=/g)).toHaveLength(7);
    expect(html).toContain("7 conexões");
  });

  it("wraps a title instead of truncating it, and shows the stance as glyph and word", () => {
    const html = table();
    expect(html).not.toContain("truncate");
    expect(html).toContain("break-words");
    expect(html).toContain(branchNotes.acid.title);
    expect(html).toContain("supports");
    expect(html).toContain("suggested");
  });

  it("holds one tab stop, on the first row when nothing is selected", () => {
    const html = table();
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(6);
  });

  it("marks the selected row with the accent bar and moves the tab stop to it", () => {
    const html = table({ selected: { type: "edge", id: branchId("edge:yeast-kombucha") } });
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(
      new RegExp(
        `data-row-id="${branchId("edge:yeast-kombucha")}"[^>]*aria-selected="true"[^>]*tabindex="0"`
      )
    );
    expect(html).toContain("var(--accent)");
  });

  it("marks the rows of a note selected on the canvas, apart from a selected row", () => {
    const html = table({ selected: { type: "node", id: branchNotes.acid.id } });
    expect(html).not.toContain('aria-selected="true"');
    expect(html.match(/var\(--border-strong\)/g)).toHaveLength(4);
  });

  it("says how its keys work, beside the table", () => {
    const html = renderToString(
      <RelationsAside
        t={pt}
        model={built(pt)}
        selected={null}
        onSelect={noop}
        onOpenNote={noop}
        onChoose={noop}
      />
    );
    expect(html).toContain("Mesmas conexões em tabela");
    expect(html).toContain("abrir a primeira nota ao lado");
    expect(html).toContain("Fora do ramo");
  });
});

describe("the lens controls", () => {
  it("switches between the chart with its table and the table alone, as the Árvore does", () => {
    const html = renderToString(<DisplayToggle t={pt} value="table" onChange={noop} />);
    expect(html).toContain("Gráfico e tabela");
    expect(html).toContain("Só tabela");
    expect(html).toMatch(/aria-pressed="true"[^>]*>(?:(?!<button).)*Só tabela/s);
  });

  it("tells a truncated read quietly, as a note and not a warning", () => {
    const html = renderToString(
      <BranchNotices t={pt} model={built(pt, sampleBranch({ truncated: true }))} />
    );
    expect(html).toContain('role="note"');
    expect(html).toContain("Este ramo é maior do que cabe no grafo");
    expect(html).not.toContain('role="alert"');
    expect(renderToString(<BranchNotices t={pt} model={built(pt)} />)).toBe("");
  });

  it("names the outside topics with their counts, each a way to its branch, and says when the list is capped", () => {
    const html = renderToString(<OutsideTopics t={pt} model={built(pt)} onChoose={noop} />);
    expect(html).toContain("Fora do ramo");
    expect(html).toContain("História da ciência");
    expect(html).toContain("2 conexões");
    expect(html).toContain("Ver o ramo História da ciência");
    expect(html).not.toContain("mais conectados");
    const capped = built(
      pt,
      sampleBranch({
        outside: Array.from({ length: 40 }, (_, index) => ({
          topicId: branchId(`topic:o${index}`),
          title: `Tópico ${index}`,
          edgeCount: 1
        }))
      })
    );
    expect(renderToString(<OutsideTopics t={pt} model={capped} onChoose={noop} />)).toContain(
      "Os 40 tópicos mais conectados."
    );
    expect(
      renderToString(
        <OutsideTopics t={pt} model={built(pt, sampleBranch({ outside: [] }))} onChoose={noop} />
      )
    ).toBe("");
  });

  it("lists the lines between groups only for a branch whose canvas has the groups' view", () => {
    // The fixture's eight notes are read as notes: no group view, no list.
    expect(renderToString(<GroupLinks t={pt} model={built(pt)} />)).toBe("");
    const big = built(pt);
    big.nodes = Array.from({ length: 20 }, () => big.nodes[0]!);
    const html = renderToString(<GroupLinks t={pt} model={big} />);
    expect(html).toContain("Entre os tópicos");
    expect(html).toContain("2 conexões");
  });
});

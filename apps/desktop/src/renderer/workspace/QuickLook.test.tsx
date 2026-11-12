import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";
import type { ObjectResolved } from "@app/domain";

import { QuickLookView, type RelatedNote } from "./QuickLook";
import type { PreviewState } from "./ObjectLinkModel";

const pt = createTranslator("pt-BR");
const en = createTranslator("en");
const noop = () => undefined;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function source(overrides: Partial<ObjectResolved> = {}): ObjectResolved {
  return {
    address: `memora://source/${uuid(1)}`,
    kind: "source",
    title: "Food microbiology, chapter 3",
    status: "current",
    preview: "The chapter explains how lactic bacteria compete in foods.",
    updatedAt: "2026-11-03T09:12:00.000Z",
    counts: { notes: 14, passages: 38 },
    path: [
      { kind: "topic", id: uuid(10), title: "Life sciences" },
      { kind: "topic", id: uuid(11), title: "Fermentation" }
    ],
    ...overrides
  };
}

const notes: RelatedNote[] = [
  { address: `memora://note/${uuid(21)}`, title: "Lactic acid inhibits pathogens" },
  { address: `memora://note/${uuid(22)}`, title: "Temperature controls the final acidity" }
];

const sheet = (state: PreviewState, extra: { notes?: RelatedNote[]; current?: boolean } = {}) =>
  renderToString(
    <QuickLookView
      t={pt}
      preview={{ state, current: extra.current ?? true, retry: noop }}
      notes={extra.notes ?? []}
      onClose={noop}
      portal={false}
    />
  );

describe("quick-look", () => {
  it("shows the keys in the head and what stays in the foot, in pt-BR", () => {
    const html = sheet({ status: "ready", item: source() });
    expect(html).toContain("Espiando");
    expect(html).toContain("Espaço");
    expect(html).toContain("fecha");
    expect(html).toContain("abre ao lado");
    expect(html).toContain("espiar a próxima");
    expect(html).toContain("abrir neste painel");
    expect(html).toContain("Esc");
    expect(html).toContain("Tudo continua onde estava; nada foi aberto.");
  });

  it("shows the object: kind, place, title, summary, counts and the first notes", () => {
    const html = sheet({ status: "ready", item: source() }, { notes });
    expect(html).toContain('data-surface="quick-look"');
    expect(html).toContain('data-state="success"');
    expect(html).toContain("Fonte");
    expect(html).toContain("Life sciences");
    expect(html).toContain("Food microbiology, chapter 3");
    expect(html).toContain("The chapter explains");
    expect(html).toContain("14 notas");
    expect(html).toContain("38 trechos");
    expect(html).toContain("Notas desta fonte");
    expect(html).toContain("Lactic acid inhibits pathogens");
    expect(html).toContain("última atualização");
  });

  it("is a non-modal sheet: no scrim, no trap, no title drawn, the row keeps the keyboard", () => {
    const html = renderToString(
      <QuickLookView
        t={en}
        preview={{ state: { status: "ready", item: source() }, current: true, retry: noop }}
        onClose={noop}
        portal={false}
      />
    );
    expect(html).toContain('role="dialog"');
    // A modal dialog hides the page from assistive tech and sets a scroll lock; this one does not.
    expect(html).not.toContain("aria-modal");
    expect(html).not.toContain("data-aria-hidden");
    expect(html).not.toContain("autofocus");
    // Its name is the object's, read by screen readers, never drawn twice.
    expect(html).toContain('class="sr-only"');
  });

  it("holds its size while loading", () => {
    const html = sheet({ status: "loading" });
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('aria-busy="true"');
    // The bars come after 150 ms (design record 5.12), so a fast answer never flashes them.
    expect(html).not.toContain("data-sheet-skeleton");
    // The keys stay, so the sheet does not jump when the object arrives.
    expect(html).toContain("Espiando");
    expect(html).toContain("Esc");
  });

  it("says what failed once, with one way back, and what is kept", () => {
    const html = sheet({ status: "error" });
    expect(html).toContain('data-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Não foi possível ler este item.");
    expect(html).toContain("Nada foi alterado; a lista continua aqui.");
    expect(html.match(/Tentar de novo/gu)).toHaveLength(1);
    // The foot keeps Esc but does not say a second time that nothing changed.
    expect(html).toContain("Esc");
    expect(html).not.toContain("Tudo continua onde estava");
  });

  it("is empty for an object that is gone, and for one with no text yet", () => {
    const gone = sheet({ status: "missing" });
    expect(gone).toContain('data-state="empty"');
    expect(gone).toContain("Isto não está mais na biblioteca.");
    const bare = sheet({ status: "ready", item: source({ preview: "" }) });
    expect(bare).toContain('data-state="empty"');
    expect(bare).toContain("Ainda sem resumo. Abra ao lado para ler tudo.");
    expect(bare).toContain("Food microbiology, chapter 3");
  });

  it("says it is busy while the next row's read is on its way (peeking with ↓), and keeps the text at full contrast", () => {
    // The design has no opacity on text: a dimmed summary reads below 4.5:1 (3.7:1 in light).
    const busy = sheet({ status: "ready", item: source() }, { current: false });
    expect(busy).toContain('aria-busy="true"');
    expect(busy).not.toContain("opacity-");
    const settled = sheet({ status: "ready", item: source() }, { current: true });
    expect(settled).not.toContain("aria-busy");
    expect(settled).not.toContain("opacity-");
  });

  it("names an entity's notes as the ones that mention it", () => {
    const html = sheet(
      {
        status: "ready",
        item: source({ kind: "entity", title: "Lactobacillus plantarum", counts: { notes: 6 } })
      },
      { notes }
    );
    expect(html).toContain("Notas que o mencionam");
    expect(html).toContain("Entidade");
  });
});

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";
import type { ObjectResolved } from "@app/domain";

import { MarkdownPreview } from "../components/MarkdownEditor";
import { hoverCardOpenDelayMs } from "../components/ui/hover-card";
import { ObjectCard, ObjectLink, ObjectLinkProvider } from "./ObjectLink";
import {
  anchorsPassage,
  countKey,
  isRelationLink,
  objectOfAddress,
  parseMarkdownObjectLink,
  previewCounts,
  surfaceState,
  type PreviewState
} from "./ObjectLinkModel";
import { createPreviewBatcher } from "./preview-batcher";

const en = createTranslator("en");
const pt = createTranslator("pt-BR");
const noop = () => undefined;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const note = `memora://note/${uuid(1)}`;
const topic = `memora://topic/${uuid(2)}`;
const passage = `memora://source/${uuid(3)}#passage=${uuid(4)}`;
const relation = `memora://note/${uuid(5)}#relation=${uuid(6)}`;

function resolved(overrides: Partial<ObjectResolved> = {}): ObjectResolved {
  return {
    address: note,
    kind: "note",
    title: "Lactic acid lowers the pH",
    status: "current",
    preview: "The acid they produce brings the pH down to about 4.",
    updatedAt: "2026-11-03T09:12:00.000Z",
    counts: { sources: 2 },
    path: [
      { kind: "topic", id: uuid(10), title: "Life sciences" },
      { kind: "topic", id: uuid(11), title: "Microbiology" }
    ],
    ...overrides
  };
}

const card = (state: PreviewState, address = note, t = pt) =>
  renderToString(<ObjectCard t={t} address={address} preview={{ state, retry: noop }} />);

describe("the object link", () => {
  it("is a link that carries its address and what a peek reads, and no card until it is asked", () => {
    const html = renderToString(
      <ObjectLink t={en} address={note} onOpen={noop}>
        Lactic acid
      </ObjectLink>
    );
    expect(html).toContain(`href="${note}"`);
    expect(html).toContain(`data-quick-look="${note}"`);
    expect(html).toContain(`data-object-link="${note}"`);
    expect(html).toContain(">Lactic acid</a>");
    // The card is not in the page until it opens (300 ms of hover or focus).
    expect(html).not.toContain("object-card");
    expect(html).toContain('data-state="closed"');
  });

  it("opens its card after 300 ms of hover or focus, which the primitive owns", () => {
    expect(hoverCardOpenDelayMs).toBe(300);
    const open = renderToString(
      <ObjectLink t={en} address={note} onOpen={noop} previewOpen portal={false}>
        Lactic acid
      </ObjectLink>
    );
    expect(open).toContain('data-surface="object-card"');
    expect(open).toContain('role="group"');
  });

  it("shows no card where it must not: a link with preview off is a bare link", () => {
    const html = renderToString(
      <ObjectLink t={en} address={note} onOpen={noop} preview={false} previewOpen>
        Chip
      </ObjectLink>
    );
    expect(html).not.toContain("object-card");
    expect(html).not.toContain("data-state");
    expect(html).toContain(`data-quick-look="${note}"`);
  });

  it("takes its translator and opener from the panel around it", () => {
    const html = renderToString(
      <ObjectLinkProvider t={pt} onOpen={noop}>
        <ObjectLink address={note} previewOpen portal={false}>
          Ácido lático
        </ObjectLink>
      </ObjectLinkProvider>
    );
    expect(html).toContain("Prévia");
    expect(html).toContain("abrir ao lado");
  });
});

describe("a Markdown memora:// link", () => {
  const read = (markdown: string, provided = true) =>
    renderToString(
      provided ? (
        <ObjectLinkProvider t={en} onOpen={noop}>
          <MarkdownPreview markdown={markdown} emptyLabel="" />
        </ObjectLinkProvider>
      ) : (
        <MarkdownPreview markdown={markdown} emptyLabel="" />
      )
    );

  it("becomes an object link", () => {
    const html = read(`See [Fermentation](${topic}) for the base.`);
    expect(html).toContain(`data-object-link="${topic}"`);
    expect(html).toContain(">Fermentation</a>");
    expect(html).not.toContain("](memora");
  });

  it("keeps its anchors, so a passage link previews the passage", () => {
    const html = read(`As [chapter 3](${passage}) says.`);
    expect(html).toContain(`data-object-link="${passage}"`);
    expect(anchorsPassage(passage)).toBe(true);
    expect(objectOfAddress(passage)).toBe(`memora://source/${uuid(3)}`);
  });

  it("is not taken for a bare citation, which has no address", () => {
    const html = read(`Salt [1](${note}) and acid [2].`);
    expect(html).toContain(`data-object-link="${note}"`);
    expect(html).toContain(">1</a>");
    expect(html).toContain("[2]");
  });

  it("is its text outside a panel, never a dead link, and an invalid address stays as typed", () => {
    expect(read(`See [Fermentation](${topic}).`, false)).not.toContain("<a ");
    expect(read(`See [Fermentation](${topic}).`, false)).toContain("Fermentation");
    expect(parseMarkdownObjectLink(`[x](memora://note/${uuid(1)}#passage=nope)`)).toBeNull();
    expect(read("See [x](memora://note/not-a-uuid).")).not.toContain("<a ");
  });

  it("leaves web links and legacy tokens as they were", () => {
    const html = read("Read [the web](https://example.com/x) now.");
    expect(html).toContain('href="https://example.com/x"');
    expect(html).not.toContain("data-object-link");
  });
});

describe("the card", () => {
  it("shows kind, title, place, the first lines and the counts, in pt-BR", () => {
    const html = card({ status: "ready", item: resolved() });
    expect(html).toContain('data-state="success"');
    expect(html).toContain("Nota");
    expect(html).toContain("Lactic acid lowers the pH");
    expect(html).toContain("Life sciences");
    expect(html).toContain("Microbiology");
    expect(html).toContain("The acid they produce");
    expect(html).toContain("2 fontes");
    expect(html).toContain("abrir ao lado");
    expect(html).toContain("espiar");
  });

  it("previews the passage of an anchored address, labelled and in italic", () => {
    const html = card(
      { status: "ready", item: resolved({ kind: "source", address: passage }) },
      passage
    );
    expect(html).toContain("Trecho");
    expect(html).toContain("italic");
    expect(html).toContain("The acid they produce");
  });

  it("says where a relation leads: 'Vai para <path>' in a soft box", () => {
    const html = card({ status: "ready", item: resolved({ address: relation }) }, relation);
    expect(html).toContain("data-go-to");
    expect(html).toContain("Vai para");
    expect(html).toContain("Life sciences");
    expect(html).toContain("Conexão");
    expect(isRelationLink(relation)).toBe(true);
    expect(isRelationLink(note)).toBe(false);
    // A plain link has no such box.
    expect(card({ status: "ready", item: resolved() })).not.toContain("data-go-to");
  });

  it("reads a relation to a topic as the topic itself", () => {
    const html = card(
      {
        status: "ready",
        item: resolved({
          kind: "topic",
          title: "Fermentation",
          address: `memora://topic/${uuid(2)}#relation=${uuid(6)}`
        })
      },
      `memora://topic/${uuid(2)}#relation=${uuid(6)}`
    );
    expect(html).toContain("Fermentation");
    expect(html).toContain("data-go-to");
  });

  it("holds the layout while loading: a busy status and bars shaped like the card", () => {
    const html = card({ status: "loading" });
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Carregando");
    // The keys are always there, so the card does not change size when the object arrives.
    expect(html).toContain("abrir ao lado");
  });

  it("says plainly what failed and keeps one way back", () => {
    const html = card({ status: "error" });
    expect(html).toContain('data-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Não foi possível ler a prévia.");
    expect(html).toContain("nada foi alterado");
    expect(html.match(/Tentar de novo/gu)).toHaveLength(1);
  });

  it("is empty for an object that is gone or has no text yet, and teaches what to do", () => {
    const gone = card({ status: "missing" });
    expect(gone).toContain('data-state="empty"');
    expect(gone).toContain("Isto não está mais na biblioteca.");
    const bare = card({ status: "ready", item: resolved({ preview: "" }) });
    expect(bare).toContain('data-state="empty"');
    expect(bare).toContain("Ainda sem resumo. Abra ao lado para ler tudo.");
    expect(bare).toContain("Lactic acid lowers the pH");
  });

  it("words a topic's count as the items placed in it, never as an exact number of notes", () => {
    const counts = previewCounts({ kind: "topic", counts: { notes: 18, children: 1 } });
    expect(counts).toEqual([
      { name: "items", count: 18 },
      { name: "subtopics", count: 1 }
    ]);
    expect(en(countKey(counts[0]!), { values: { count: 18 } })).toBe("18 items in the topic");
    expect(en(countKey(counts[1]!), { values: { count: 1 } })).toBe("1 subtopic");
  });

  it("counts what suits each kind and leaves out zeros", () => {
    expect(previewCounts({ kind: "source", counts: { notes: 14, passages: 38 } })).toHaveLength(2);
    expect(previewCounts({ kind: "source", counts: { notes: 0, passages: 3 } })).toEqual([
      { name: "passages", count: 3 }
    ]);
    expect(previewCounts({ kind: "note", counts: { sources: 1 } })).toEqual([
      { name: "sources", count: 1 }
    ]);
    expect(previewCounts({ kind: "entity", counts: { notes: 6 } })).toEqual([
      { name: "notes", count: 6 }
    ]);
    expect(previewCounts({ kind: "question", counts: { answers: 2 } })).toEqual([
      { name: "answers", count: 2 }
    ]);
    expect(previewCounts({ kind: "note" })).toEqual([]);
  });

  it("maps the read to the four states", () => {
    expect(surfaceState({ status: "loading" })).toBe("loading");
    expect(surfaceState({ status: "error" })).toBe("error");
    expect(surfaceState({ status: "missing" })).toBe("empty");
    expect(surfaceState({ status: "ready", item: resolved() })).toBe("success");
    expect(surfaceState({ status: "ready", item: resolved({ preview: "  " }) })).toBe("empty");
  });
});

describe("the read behind the card", () => {
  it("goes through the batcher with the anchored address, path included", async () => {
    const asked: unknown[] = [];
    const batcher = createPreviewBatcher({
      resolveMany: (input) => {
        asked.push(input);
        return Promise.resolve({
          items: Object.fromEntries(
            input.addresses.map((address) => [address, resolved({ address })])
          ),
          missing: []
        });
      },
      setTimer: (run) => {
        queueMicrotask(run);
        return 0;
      },
      clearTimer: noop
    });
    const result = await batcher.request(passage);
    expect(result.status).toBe("ready");
    expect(asked).toEqual([{ addresses: [passage], include: { path: true } }]);
  });
});

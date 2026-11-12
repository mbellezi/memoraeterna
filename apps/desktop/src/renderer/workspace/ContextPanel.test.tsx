import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";
import type { NotePageRelation, ObjectLocateResult } from "@app/domain";

import {
  ContextPanel,
  ContextTabs,
  LocateLines,
  contextTabRegistry,
  headerCrumbs,
  registerContextTabs
} from "./ContextPanel";
import { NoteConnectionsView } from "./context/connections-tab";
import { ConnectionsTab } from "./context/connections-tab";
import { relations as fixtureRelations } from "./context/context-fixtures";
import {
  EvidenceTab,
  NoteEvidenceView,
  QuestionEvidenceView,
  SourceEvidenceView,
  TopicEvidenceView
} from "./context/evidence-tab";
import { GraphTab, NoteGraphView } from "./context/graph-tab";
import { MentionsView } from "./context/mentions-tab";
import { MetaLine } from "./context/context-parts";

const en = createTranslator("en");
const pt = createTranslator("pt-BR");
const noop = () => undefined;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const noteAddress = `memora://note/${uuid(22)}`;

const ready = <T,>(value: T) => ({ status: "ready" as const, value });
const paged = (items: NotePageRelation[], extra = {}) =>
  ready({ items, total: items.length, hasMore: false, more: "idle" as const, ...extra });

function connections(
  read: Parameters<typeof NoteConnectionsView>[0]["read"],
  t = pt,
  onLink?: () => void
) {
  return renderToString(
    <NoteConnectionsView
      t={t}
      read={read}
      {...(onLink ? { onLink } : {})}
      resolved={new Map()}
      review={null}
      onOpen={noop}
      onMore={noop}
      onRetry={noop}
      onReview={noop}
      onTab={noop}
      mapAddress="memora://map/relations"
    />
  );
}

describe("tab registration", () => {
  it("finds the four tabs of T143 by file", () => {
    expect(contextTabRegistry.map((entry) => entry.tab).sort()).toEqual(
      ["connections", "evidence", "graph", "mentions"].sort()
    );
  });

  it("fails loudly for a file that is not a tab", () => {
    expect(() => registerContextTabs({ "./context/x-tab.tsx": {} })).toThrow(/must export tab/);
  });
});

describe("the tab row", () => {
  const row = (active: Parameters<typeof ContextTabs>[0]["active"], t = pt) =>
    renderToString(
      <ContextTabs
        t={t}
        available={["connections", "evidence", "ask", "mentions", "graph", "history"]}
        active={active}
        onTab={noop}
        panelId="p"
      />
    );

  it("is a tablist of worded tabs with the selected one marked, and Mais holding the rest", () => {
    const html = row("connections");
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain("Conexões");
    expect(html).toContain("Evidência");
    expect(html).toContain("Perguntar");
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain("Mais");
    expect(html).not.toContain("Histórico");
  });

  it("shows a tab chosen under Mais in the third slot", () => {
    const html = row("graph");
    expect(html).toContain("Grafo");
    expect(html).not.toContain("Perguntar</button>");
  });

  it("names the Option-digit of each tab", () => {
    expect(row("connections")).toContain("Conexões (⌥1)");
  });
});

describe("the connections list", () => {
  it("loads as four rows shaped like the content, in a busy region", () => {
    const html = connections({ status: "loading" });
    expect(html).toContain('data-surface="context-connections"');
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Conexões desta nota");
  });

  it("offers the next action in empty only where it is wired", () => {
    expect(connections(paged([]))).not.toContain("Ligar a outra nota");
    const html = connections(paged([]), pt, noop);
    expect(html).toContain("Ligar a outra nota");
    // The action sits between the sentence and the legend.
    expect(html.indexOf("Ligar a outra nota")).toBeGreaterThan(html.indexOf("Ainda sem conexões."));
    expect(html.indexOf("Ligar a outra nota")).toBeLessThan(
      html.indexOf("As seis formas de conexão")
    );
  });

  it("teaches in empty: the sentence and the six stances", () => {
    const html = connections(paged([]));
    expect(html).toContain('data-state="empty"');
    expect(html).toContain("Ainda sem conexões. O Jardineiro procura quando o Mac está ocioso.");
    for (const word of ["apoia", "contradiz", "estende", "depende de", "exemplo de", "relacionada"])
      expect(html).toContain(word);
  });

  it("fails in place: one sentence, what is kept, one retry", () => {
    const html = connections({ status: "error" });
    expect(html).toContain('data-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Não foi possível carregar as conexões.");
    expect(html).toContain("A nota continua aberta.");
    expect(html.match(/Tentar de novo/g)).toHaveLength(1);
  });

  it("lists the groups, counts and the dashed suggestion box in success", () => {
    const html = connections(paged(fixtureRelations as unknown as NotePageRelation[]));
    expect(html).toContain('data-state="success"');
    for (const heading of [
      "Apoiam esta nota",
      "Esta nota estende",
      "Esta nota depende de",
      "Esta nota é exemplo de"
    ])
      expect(html).toContain(heading);
    expect(html).toContain("5 conexões");
    expect(html).toContain("1 sugestão");
    expect(html).toContain("border-dashed");
    expect(html).toContain("também na Caixa de entrada");
    expect(html).toContain("Manter");
    expect(html).toContain("Remover");
    expect(html).toContain("você manteve");
    // Relation rows show no hover card (A3): they are plain buttons.
    expect(html).not.toContain("data-hover-card");
  });

  it("offers Mostrar mais only while there is more, and says when it failed", () => {
    const rows = fixtureRelations.slice(0, 2) as unknown as NotePageRelation[];
    expect(connections(paged(rows))).not.toContain("Mostrar mais");
    expect(connections(paged(rows, { hasMore: true }))).toContain("Mostrar mais");
    const failed = connections(paged(rows, { hasMore: true, more: "error" }));
    expect(failed).toContain("Não foi possível carregar mais.");
    expect(failed).toContain("Tentar de novo");
  });

  it("asks the suggestion as a question with a quiet tag and a two-line meta", () => {
    const html = connections(paged(fixtureRelations as unknown as NotePageRelation[]));
    // The other note would support this one: "Apoia esta nota?", then the tag that says it is a suggestion.
    expect(html).toContain("Apoia esta nota?");
    expect(html).toContain("sugestão");
    // The meta repeats nothing the heading says, and carries the routing words in the same run.
    expect(html).not.toContain("sugestão do Jardineiro");
    expect(html).toContain("Jardineiro");
    expect(html).toContain("confiança média");
    expect(html).toContain("também na Caixa de entrada");
  });

  it("speaks English when the person does", () => {
    const html = connections(paged(fixtureRelations as unknown as NotePageRelation[]), en);
    expect(html).toContain("Notes that support this one");
    expect(html).toContain("also in the Inbox");
    expect(html).toContain("Supports this note?");
  });
});

describe("a meta line", () => {
  it("draws each separator inside the item it leads, so no wrapped line starts or ends on one", () => {
    const html = renderToString(<MetaLine parts={["a", "b", "c"]} />);
    // The row is clipped and pulled left by one separator's width; every item carries its own dot.
    expect(html).toContain("overflow-clip");
    expect(html).toContain("-ml-4");
    expect(html.match(/before:content-/g)).toHaveLength(3);
    // The dot is drawn by the stylesheet, never written as text that could end a line.
    expect(html).not.toMatch(/>\s*·/);
    expect(html.indexOf(">a<")).toBeLessThan(html.indexOf(">b<"));
  });
});

describe("mentions", () => {
  const backlink = (via: string, from: string, snippet = "text") => ({ from, via, snippet });
  const items = [
    backlink("overview_citation", `memora://topic/${uuid(4)}`),
    backlink("question_citation", `memora://question/${uuid(31)}`)
  ];
  const view = (read: Parameters<typeof MentionsView>[0]["read"]) =>
    renderToString(
      <MentionsView
        t={pt}
        kind="note"
        read={read}
        resolved={new Map()}
        onOpen={noop}
        onMore={noop}
        onRetry={noop}
      />
    );

  it("groups by what cites the object", () => {
    const html = view(
      ready({ items: items as never, total: null, hasMore: false, more: "idle" as const })
    );
    expect(html).toContain('data-surface="context-mentions"');
    expect(html).toContain("Tópicos cuja visão geral cita esta nota");
    expect(html).toContain("Perguntas cujas respostas citam esta nota");
    expect(html).toContain("2 menções");
  });

  it("has its four states", () => {
    expect(view({ status: "loading" })).toContain('data-state="loading"');
    expect(view({ status: "error" })).toContain("Não foi possível carregar as menções.");
    const empty = view(ready({ items: [], total: null, hasMore: false, more: "idle" as const }));
    expect(empty).toContain('data-state="empty"');
    expect(empty).toContain("Nada cita isto fora das conexões.");
  });

  it("is not empty while a page the read skipped still lies ahead", () => {
    // The arms before the one the tab shows can fill every request the read makes.
    const skipped = view(ready({ items: [], total: null, hasMore: true, more: "idle" as const }));
    expect(skipped).not.toContain('data-state="empty"');
    expect(skipped).not.toContain("Nada cita isto fora das conexões.");
    expect(skipped).toContain('data-state="success"');
    expect(skipped).toContain("Mostrar mais");
  });
});

describe("evidence", () => {
  const evidence = (n: number) => ({
    chunkId: uuid(40 + n),
    sourceItemId: uuid(11),
    documentId: null,
    sourceSpanId: null,
    sourceTitle: "Food microbiology",
    workTitle: null,
    chunkIndex: n,
    range: null,
    page: 40 + n,
    excerpt: `Passage ${n}`,
    language: "en",
    primary: n === 0,
    current: true,
    sourceAvailable: true
  });
  const page = (items: ReturnType<typeof evidence>[]) =>
    ({
      note: {
        authorship: "ai",
        generationModel: "local model",
        createdAt: "2026-11-03T21:14:00.000Z",
        updatedAt: "2026-11-03T21:14:00.000Z",
        lastEditedAt: null
      },
      evidence: { items, total: items.length }
    }) as never;

  it("numbers a note's passages and says who wrote it", () => {
    const html = renderToString(
      <NoteEvidenceView
        t={pt}
        read={ready(page([evidence(0), evidence(1)]))}
        onOpen={noop}
        onRetry={noop}
      />
    );
    expect(html).toContain('data-surface="context-evidence"');
    expect(html).toContain("Evidência desta nota");
    expect(html).toContain("Passage 0");
    expect(html).toContain("2 trechos");
    expect(html).toContain("Quem escreveu");
    expect(html).toContain("data-object=");
  });

  it("has its states for a note", () => {
    const view = (read: Parameters<typeof NoteEvidenceView>[0]["read"]) =>
      renderToString(<NoteEvidenceView t={pt} read={read} onOpen={noop} onRetry={noop} />);
    expect(view({ status: "loading" })).toContain('data-state="loading"');
    expect(view({ status: "error" })).toContain("Não foi possível carregar a evidência.");
    expect(view(ready(page([])))).toContain('data-state="empty"');
  });

  it("offers the connections from an empty note, when the panel can switch tabs", () => {
    const view = (onTab?: () => void) =>
      renderToString(
        <NoteEvidenceView
          t={pt}
          read={ready(page([]))}
          onOpen={noop}
          onRetry={noop}
          {...(onTab ? { onTab } : {})}
        />
      );
    expect(view(noop)).toContain("Ver as conexões");
    expect(view()).not.toContain("Ver as conexões");
  });

  it("shows a source's passages with who cites them", () => {
    const anchor = `passage=${uuid(41)}`;
    const html = renderToString(
      <SourceEvidenceView
        t={pt}
        sourceId={uuid(11)}
        read={ready({
          items: [
            { from: `memora://note/${uuid(1)}`, via: "evidence", anchor, snippet: "the words" },
            { from: `memora://question/${uuid(2)}`, via: "question_citation", anchor }
          ] as never,
          total: null,
          hasMore: false,
          more: "idle" as const
        })}
        resolved={new Map()}
        onOpen={noop}
        onMore={noop}
        onRetry={noop}
      />
    );
    expect(html).toContain("the words");
    expect(html).toContain("citado por 1 nota e 1 pergunta");
    expect(html).toContain(`data-object="memora://source/${uuid(11)}#${anchor}"`);
  });

  it("is not empty while a source's passages may still lie on a later page", () => {
    const html = renderToString(
      <SourceEvidenceView
        t={pt}
        sourceId={uuid(11)}
        read={ready({ items: [], total: null, hasMore: true, more: "idle" as const })}
        resolved={new Map()}
        onOpen={noop}
        onMore={noop}
        onRetry={noop}
      />
    );
    expect(html).toContain('data-state="success"');
    expect(html).toContain("Mostrar mais");
  });

  it("lists an answer's sources by number and says when one is gone or may be out of date", () => {
    const html = renderToString(
      <QuestionEvidenceView
        t={pt}
        read={ready({
          citations: [
            { number: 1, address: `memora://source/${uuid(1)}`, unavailable: false, stale: true },
            { number: 2, address: null, unavailable: true, stale: false }
          ]
        })}
        resolved={new Map()}
        onOpen={noop}
        onRetry={noop}
      />
    );
    expect(html).toContain("Evidência desta resposta");
    expect(html).toContain("pode estar desatualizada");
    expect(html).toContain("este trecho não está mais na biblioteca");
    expect(html).toContain("2 fontes");
  });

  it("lists the passages a topic's overview rests on", () => {
    const html = renderToString(
      <TopicEvidenceView
        t={pt}
        read={ready({
          citations: [
            {
              n: 1,
              sourceId: uuid(1),
              chunkId: uuid(2),
              sourceTitle: "Book",
              excerpt: "words",
              available: true
            }
          ]
        })}
        onOpen={noop}
        onRetry={noop}
      />
    );
    expect(html).toContain("Evidência deste tópico");
    expect(html).toContain("words");
  });

  it("tells an entity that its notes carry the passages", () => {
    const html = renderToString(
      <EvidenceTab
        t={pt}
        address={`memora://entity/${uuid(7)}`}
        kind="entity"
        id={uuid(7)}
        active
        onOpen={noop}
      />
    );
    expect(html).toContain('data-state="empty"');
    expect(html).toContain("Uma entidade não tem trechos próprios.");
  });
});

describe("the graph tab", () => {
  it("links other kinds to the Map and shows the legend", () => {
    const html = renderToString(
      <GraphTab
        t={pt}
        address={`memora://topic/${uuid(4)}`}
        kind="topic"
        id={uuid(4)}
        active
        onOpen={noop}
      />
    );
    expect(html).toContain('data-surface="context-graph"');
    expect(html).toContain("Abrir no Mapa › Grafo");
    expect(html).toContain("relacionada");
  });

  it("says why a note's graph is not drawn when the window cannot, and offers the list", () => {
    const answer = {
      focus: uuid(22),
      depth: 1 as const,
      nodes: [
        {
          id: uuid(22),
          kind: "note" as const,
          title: "A",
          ideaStatement: "A",
          language: "en",
          depth: 0 as const
        },
        {
          id: uuid(23),
          kind: "note" as const,
          title: "B",
          ideaStatement: "B",
          language: "en",
          depth: 1 as const
        }
      ],
      edges: [
        {
          id: uuid(300),
          lo: uuid(22),
          hi: uuid(23),
          direction: "unknown" as const,
          type: "supports",
          state: "applied" as const,
          band: "apply" as const
        }
      ],
      neighbourTotal: 1,
      truncated: false
    };
    const html = renderToString(
      <NoteGraphView
        t={pt}
        load={{ status: "ready", answer }}
        webgl={false}
        onDepth={noop}
        onRetry={noop}
        onOpenNote={noop}
        onUnavailable={noop}
        onShowList={noop}
      />
    );
    expect(html).toContain("Este computador não consegue desenhar o grafo.");
    expect(html).toContain("Ver como lista");
    expect(html).toContain('data-state="success"');
  });

  it("says so and offers the list when there is nothing to draw, instead of the graph's controls", () => {
    const html = renderToString(
      <NoteGraphView
        t={pt}
        load={{
          status: "ready",
          answer: {
            focus: uuid(22),
            depth: 1,
            nodes: [
              {
                id: uuid(22),
                kind: "note",
                title: "N",
                ideaStatement: "N",
                language: "en",
                depth: 0
              }
            ],
            edges: [],
            neighbourTotal: 0,
            truncated: false
          }
        }}
        webgl
        onDepth={noop}
        onRetry={noop}
        onOpenNote={noop}
        onUnavailable={noop}
        onShowList={noop}
      />
    );
    expect(html).toContain('data-state="empty"');
    expect(html).toContain("Ainda não há nada para desenhar");
    // With no way to link a note the tab sends the person to the list instead.
    expect(html).toContain("Ver como lista");
    expect(html).not.toContain("Ligar a outra nota");
    expect(html).not.toContain("notas ·");
  });

  it("offers to link the note when nothing is drawn and the panel can start a link", () => {
    const html = renderToString(
      <NoteGraphView
        t={pt}
        load={{
          status: "ready",
          answer: {
            focus: uuid(22),
            depth: 1,
            nodes: [],
            edges: [],
            neighbourTotal: 0,
            truncated: false
          }
        }}
        webgl
        onDepth={noop}
        onRetry={noop}
        onOpenNote={noop}
        onUnavailable={noop}
        onShowList={noop}
        onLink={noop}
      />
    );
    expect(html).toContain("Ligar a outra nota");
    expect(html).not.toContain("Ver como lista");
  });

  it("loads and fails like the other tabs", () => {
    const view = (load: Parameters<typeof NoteGraphView>[0]["load"]) =>
      renderToString(
        <NoteGraphView
          t={pt}
          load={load}
          webgl
          onDepth={noop}
          onRetry={noop}
          onOpenNote={noop}
          onUnavailable={noop}
          onShowList={noop}
        />
      );
    expect(view({ status: "loading" })).toContain('data-state="loading"');
    const failed = view({ status: "error" });
    expect(failed).toContain("Não foi possível carregar o grafo.");
    expect(failed.match(/role="alert"/g)).toHaveLength(1);
  });
});

describe("a source's, topic's and entity's connections", () => {
  it("says what a question has instead of connections", () => {
    const html = renderToString(
      <ConnectionsTab
        t={pt}
        address={`memora://question/${uuid(31)}`}
        kind="question"
        id={uuid(31)}
        active
        onOpen={noop}
      />
    );
    expect(html).toContain('data-state="empty"');
    expect(html).toContain("Uma pergunta não tem conexões próprias.");
  });
});

describe("the locate header", () => {
  const located = (over: Partial<ObjectLocateResult> = {}): ObjectLocateResult => ({
    object: { kind: "note", id: uuid(22), title: "N" },
    primaryPath: [
      { kind: "topic", id: uuid(1), title: "" },
      { kind: "topic", id: uuid(2), title: "Life sciences" },
      { kind: "topic", id: uuid(3), title: "Microbiology" },
      { kind: "note", id: uuid(22), title: "N" }
    ],
    alsoIn: [{ kind: "topic", id: uuid(7), title: "Nutrition" }],
    citedBy: [{ kind: "topic", id: uuid(3), title: "Microbiology" }],
    counts: { alsoIn: 3, citedBy: 1, notes: 0, passages: 1, children: 0 },
    ...over
  });

  it("shows the path, also in with the rest counted, and what cites it", () => {
    const html = renderToString(<LocateLines t={pt} located={located()} onOpen={noop} />);
    expect(html).toContain("Life sciences");
    expect(html).toContain("também em");
    expect(html).toContain("e mais 2");
    expect(html).toContain("citado pela visão geral de");
  });

  it("writes its crumbs and the objects it names as inline links, so a line wraps at a word", () => {
    const html = renderToString(<LocateLines t={pt} located={located()} onOpen={noop} />);
    expect(html).not.toContain("<button");
    expect(html).toContain('href="memora://topic/');
    expect(html).toContain("citado pela visão geral de");
  });

  it("folds a deep path to its last three crumbs", () => {
    expect(headerCrumbs([1, 2, 3])).toEqual({ folded: false, shown: [1, 2, 3] });
    expect(headerCrumbs([1, 2, 3, 4, 5])).toEqual({ folded: true, shown: [3, 4, 5] });
  });

  it("is absent for an object with no place and nothing citing it", () => {
    const html = renderToString(
      <LocateLines
        t={pt}
        located={located({
          primaryPath: [{ kind: "note", id: uuid(22), title: "N" }],
          alsoIn: [],
          citedBy: [],
          counts: { alsoIn: 0, citedBy: 0, notes: 0, passages: 0, children: 0 }
        })}
        onOpen={noop}
      />
    );
    expect(html).toBe("");
  });
});

describe("the panel", () => {
  const panel = (props: Partial<Parameters<typeof ContextPanel>[0]> = {}) =>
    renderToString(
      <ContextPanel
        t={pt}
        focus={{ kind: "note", id: uuid(22), address: noteAddress }}
        tab="connections"
        onTab={noop}
        mode="docked"
        open={false}
        onOpenChange={noop}
        onOpen={noop}
        {...props}
      />
    );

  it("docks as a context region with its frame", () => {
    const html = panel();
    expect(html).toContain('data-region="context"');
    expect(html).toContain('data-surface="context-panel"');
    expect(html).toContain('aria-label="Contexto"');
    expect(html).toContain('role="tabpanel"');
  });

  it("says nothing is in focus when no object is, and its state is empty", () => {
    const html = panel({ focus: null });
    expect(html).toContain('data-state="empty"');
    expect(html).toContain("Nada em foco");
  });

  it("is a 40 px strip below 1280 px, written top to bottom, with the overlay closed", () => {
    const html = panel({ mode: "strip" });
    expect(html).toContain('data-context-mode="strip"');
    expect(html).toContain("writing-mode:vertical-rl");
    expect(html).toContain("Contexto");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("hidden");
    expect(html).toContain('aria-label="Abrir o contexto: Conexões"');
  });

  it("marks the strip as selected and shows the overlay while it is open", () => {
    const html = panel({ mode: "strip", open: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="Fechar o contexto"');
    expect(html).toContain("right-full");
    expect(html).toContain("inset_2px_0_0_var(--accent)");
  });

  it("reads nothing while it is not shown", () => {
    expect(panel({ shown: false })).toContain("hidden");
  });
});

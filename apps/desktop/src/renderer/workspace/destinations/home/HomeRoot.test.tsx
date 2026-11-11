import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { uuid } from "../../../components/inbox/inbox-fixtures";
import { homeDigest } from "./home-fixtures";
import type { HomeData } from "./home-model";
import type { HomeSnapshot } from "./home-store";
import { HomeView, homeState } from "./HomeRoot";

const now = new Date(2026, 10, 11, 9, 0).getTime();
const en = createTranslator("en");
const pt = createTranslator("pt-BR");

const data = (
  options: Parameters<typeof homeDigest>[1] = {},
  rest: Partial<HomeData> = {}
): HomeData => ({
  digest: homeDigest(now, options),
  generating: { total: 1, ids: [uuid(101)] },
  progress: { [uuid(101)]: { done: 7, estimate: 18 } },
  lastVisit: new Date(2026, 10, 10, 22, 40).toISOString(),
  readAt: now,
  ...rest
});

const ready = (value: HomeData, undo: HomeSnapshot["undo"] = {}): HomeSnapshot => ({
  read: { status: "ready", data: value },
  undo
});

const view = (
  t: typeof en,
  snapshot: HomeSnapshot,
  width = 1440,
  actions: Parameters<typeof HomeView>[0]["actions"] = {}
) => renderToString(<HomeView t={t} snapshot={snapshot} width={width} actions={actions} />);

/** The text of the html, with tags removed and no-break spaces as plain spaces. */
const text = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&quot;|&#x27;/gu, "'")
    .replace(/[\u00a0\s]+/gu, " ")
    .replace(/ ([;.,:])/gu, "$1");

describe("the frame's state", () => {
  it("is loading, error, empty (first run) or success", () => {
    expect(homeState({ read: { status: "loading" }, undo: {} })).toBe("loading");
    expect(homeState({ read: { status: "error", unavailable: false }, undo: {} })).toBe("error");
    expect(homeState(ready(data({ firstRun: true })))).toBe("empty");
    expect(homeState(ready(data()))).toBe("success");
    expect(homeState(ready(data({ calm: true }, { generating: { total: 0, ids: [] } })))).toBe(
      "success"
    );
  });

  it("writes the surface and the state on its frame", () => {
    const html = view(en, ready(data()));
    expect(html).toContain('data-surface="destination-home"');
    expect(html).toContain('data-state="success"');
    expect(view(en, { read: { status: "loading" }, undo: {} })).toContain('data-state="loading"');
  });
});

describe("the briefing as the person reads it", () => {
  it("is true to the digest on the design's day, in Portuguese", () => {
    const words = text(view(pt, ready(data())));
    expect(words).toContain("Quarta-feira, 11 de novembro");
    expect(words).toContain("última visita ontem, 22:40");
    expect(words).toContain("Bom dia. Enquanto você esteve fora:");
    expect(words).toContain("Chegaram 3 fontes e já geraram 30 notas;");
    expect(words).toContain("29 já têm lugar na árvore e 1 ainda procura.");
    expect(words).toContain("Uma fonte ainda está gerando notas.");
    expect(words).toContain("O Jardineiro fez 9 mudanças;");
    expect(words).toContain("3 decisões esperam por você, entre elas");
    expect(words).toContain("Nada foi apagado.");
  });

  it("drops each clause whose count is zero", () => {
    const base = data();
    const words = text(
      view(
        pt,
        ready({
          ...base,
          generating: { total: 0, ids: [] },
          digest: {
            ...base.digest,
            gardener: { count: 0, top: [] },
            inbox: { total: 0, top: [] }
          }
        })
      )
    );
    expect(words).toContain("Chegaram 3 fontes");
    expect(words).not.toContain("gerando notas.");
    expect(words).not.toContain("Jardineiro fez");
    expect(words).not.toContain("esperam por você");
  });

  it("says all notes have a place when none looks for one", () => {
    const base = data();
    const words = text(
      view(
        pt,
        ready({
          ...base,
          digest: {
            ...base.digest,
            new: { ...base.digest.new, notes: { total: 30, placed: 30, unplaced: 0, items: [] } }
          }
        })
      )
    );
    expect(words).toContain("todas com lugar na árvore.");
  });

  it("uses the singular for one source", () => {
    const base = data();
    const words = text(
      view(
        pt,
        ready({
          ...base,
          digest: {
            ...base.digest,
            new: {
              sources: { total: 1, items: base.digest.new.sources.items.slice(0, 1) },
              notes: { total: 7, placed: 6, unplaced: 1, items: [] }
            }
          }
        })
      )
    );
    expect(words).toContain("Chegou 1 fonte e já gerou 7 notas;");
    expect(words).toContain("6 já têm lugar na árvore e 1 ainda procura.");
  });

  it("links the counts only where there is somewhere to go, and keeps the Jardineiro's count plain", () => {
    const html = view(en, ready(data()), 1440, { go: vi.fn() });
    expect(html).toMatch(/<button[^>]*>3\u00a0sources<\/button>/u);
    expect(html).toMatch(/<button[^>]*>3\u00a0decisions<\/button>/u);
    expect(html).toContain("<strong");
    const bare = view(en, ready(data()));
    expect(bare).not.toMatch(/<button[^>]*>3\u00a0sources<\/button>/u);
  });

  it("says the calm day plainly and offers the questions and the trail", () => {
    const calm = ready(data({ calm: true }, { generating: { total: 0, ids: [] } }));
    const words = text(view(pt, calm));
    expect(words).toContain("Nada mudou desde a sua última visita.");
    expect(words).toContain(
      "Sem fontes novas, sem mudanças do Jardineiro e nada esperando por você."
    );
    expect(words).toContain("Perguntas recentes");
    expect(words).toContain("Continuar de onde parou");
    expect(words).not.toContain("Precisa de você");
    expect(words).not.toContain("Nada foi apagado.");
  });

  it("looks back a week when Home was never opened", () => {
    const words = text(view(pt, ready(data({}, { lastVisit: null }))));
    expect(words).toContain("Nos últimos 7 dias:");
    expect(words).not.toContain("última visita");
    expect(words).toContain("9 mudanças nos últimos 7 dias");
  });
});

describe("the parts of the day's page", () => {
  const html = view(pt, ready(data()), 1440, { go: vi.fn(), openObject: vi.fn(), resume: vi.fn() });
  const words = text(html);

  it("offers Retomar with the trail and the one primary button", () => {
    expect(words).toContain("Continuar de onde parou");
    expect(words).toContain("Microbiologia dos alimentos, cap. 3");
    expect(words).toContain("3 painéis em Explorar");
    expect(html.match(/border-accent bg-accent/gu)).toHaveLength(1);
    expect(words).toContain("Retomar ↵");
  });

  it("draws the Shape strip with the topic that is too big and the way to the Map", () => {
    expect(words).toContain("Sua árvore");
    expect(words).toContain("412 notas em 38 tópicos");
    expect(words).toContain("4 níveis de profundidade");
    expect(words).toContain("41 notas novas esta semana");
    expect(words).toContain("1 tópico grande demais");
    expect(words).toContain("Ver no Mapa");
    expect(words).toContain("Nutrição 96");
  });

  it("draws the four columns with one header pattern", () => {
    for (const title of [
      "Precisa de você",
      "O que o Jardineiro fez",
      "Chegou",
      "Perguntas recentes"
    ])
      expect(words).toContain(title);
    expect(words).toContain("3 decisões · maior risco primeiro");
    expect(words).toContain("9 mudanças desde a sua última visita");
    expect(words).toContain("3 fontes · 30 notas");
  });

  it("shows the decisions by risk, the Jardineiro's rows with Desfazer, and the arrivals with their paths", () => {
    expect(words).toContain("Alto");
    expect(words).toContain("Médio");
    expect(words).toContain("Baixo");
    expect(words).toContain("Desfazer");
    expect(words).toContain("Não dá para desfazer agora");
    expect(words).toContain("gerando notas");
    expect(words).toContain("7 de ~18");
    expect(words).toContain("Teoria musical › Ritmo");
    expect(words).toContain("… › Fermentação › Fermentação lática");
  });

  it("shows no English chrome in pt-BR", () => {
    for (const english of [
      "Needs you",
      "Arrived",
      "Recent questions",
      "Continue where",
      "Resume",
      "See in Map"
    ])
      expect(words).not.toContain(english);
  });
});

describe("Desfazer", () => {
  it("says it is under way, then that the change is undone, then names what blocks it", () => {
    const base = data();
    const key = `topic:${uuid(801)}`;
    const body = (undo: HomeSnapshot["undo"]) =>
      text(view(en, ready(base, undo), 1440, { undo: vi.fn() }));
    expect(body({})).toContain("Undo");
    expect(body({ [key]: { status: "pending" } })).toContain("Undoing...");
    expect(body({ [key]: { status: "undone" } })).toContain("Change undone.");
    expect(
      body({ [key]: { status: "blocked", messageKey: "changes.blockers.later_change" } })
    ).toContain("later");
  });

  it("offers no Desfazer on a proposal and says where it is decided", () => {
    const base = data();
    const proposed = {
      ...base,
      digest: {
        ...base.digest,
        gardener: {
          count: 1,
          top: [{ ...base.digest.gardener.top[0]!, status: "pending_review" as const }]
        }
      }
    };
    const words = text(view(en, ready(proposed), 1440, { undo: vi.fn() }));
    expect(words).toContain("proposal · decide in the Inbox");
    expect(words).not.toContain("Undo");
  });
});

describe("the compact form", () => {
  it("is two columns, `need arr` over `gard back`, below 1180 px", () => {
    const compact = view(en, ready(data()), 960);
    expect(compact).toContain("grid-template-areas:&quot;need arr&quot; &quot;gard back&quot;");
    expect(compact).toContain("repeat(2, minmax(0, 1fr))");
    const wide = view(en, ready(data()), 1440);
    expect(wide).toContain(
      "grid-template-areas:&quot;need gard arr&quot; &quot;need gard back&quot;"
    );
    expect(wide).toContain("repeat(3, minmax(0, 1fr))");
  });

  it("changes tier at the layout's compact width", () => {
    expect(view(en, ready(data()), 1179)).toContain("&quot;need arr&quot;");
    expect(view(en, ready(data()), 1180)).toContain("&quot;need gard arr&quot;");
  });
});

describe("first run", () => {
  it("teaches what this is and offers the one action", () => {
    const html = view(pt, ready(data({ firstRun: true })), 1440, { addSource: vi.fn() });
    const words = text(html);
    expect(words).toContain("Pronto para a primeira fonte");
    expect(words).toContain("Adicionar a primeira fonte");
    expect(words).toContain("O que acontece depois");
    expect(words).toContain("Combinado");
    expect(words).toContain("⌘N");
    expect(html).toContain("border-dashed");
    expect(html.match(/border-accent bg-accent/gu)).toHaveLength(1);
    expect(words).not.toContain("Continuar de onde parou");
  });
});

describe("the states", () => {
  it("keeps the layout while it loads, with a status region and no spinner", () => {
    const html = view(en, { read: { status: "loading" }, undo: {} });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("animate-spin");
  });

  it("says what failed once, what is kept, and offers one retry", () => {
    const retry = vi.fn();
    const html = view(pt, { read: { status: "error", unavailable: true }, undo: {} }, 1440, {
      retry
    });
    const words = text(html);
    expect(html).toContain('role="alert"');
    expect(words).toContain("Não deu para carregar o Início.");
    expect(words).toContain("Suas fontes e notas continuam como estavam.");
    expect(html.match(/Tentar de novo/gu)).toHaveLength(1);
    expect(words).toContain("Detalhes");
  });
});

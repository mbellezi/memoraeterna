import type { RelationsBranchResult } from "../../../../../shared/ipc-relations-branch";

/**
 * A branch of the design record's fixture (7.5, `#map-graph`): Fermentação with two subtopics and
 * one level below lática. Object titles stand for the person's content and stay as they are in
 * every language; the app's own words come from `@app/i18n`.
 */

let counter = 0;
const ids = new Map<string, string>();
/** A stable UUID per fixture name. */
export function branchId(name: string): string {
  let id = ids.get(name);
  if (!id) {
    counter += 1;
    id = `5b0a7c3e-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
    ids.set(name, id);
  }
  return id;
}

export const branchTopics = {
  fermentation: branchId("topic:fermentation"),
  lactic: branchId("topic:lactic"),
  alcoholic: branchId("topic:alcoholic"),
  kefir: branchId("topic:kefir"),
  history: branchId("topic:history")
} as const;

const note = (name: string, title: string, topicId: string | null, degree: number) => ({
  id: branchId(`note:${name}`),
  title,
  topicId,
  degree
});

export const branchNotes = {
  acid: note("acid", "O ácido lático inibe patógenos", branchTopics.lactic, 4),
  bacteria: note("bacteria", "Bactérias láticas toleram meio ácido", branchTopics.lactic, 1),
  temperature: note("temperature", "Temperatura controla a acidez", branchTopics.lactic, 1),
  kefir: note("kefir", "Kefir reúne bactérias e leveduras", branchTopics.kefir, 1),
  kombucha: note("kombucha", "Kombucha fica mais ácida a cada dia", branchTopics.alcoholic, 2),
  yeast: note("yeast", "Leveduras produzem gás carbônico", branchTopics.alcoholic, 1),
  hours: note("hours", "A fermentação começa em horas", branchTopics.fermentation, 2),
  pasteur: note("pasteur", "Pasteur e os germes", branchTopics.fermentation, 1)
} as const;

const edge = (
  name: string,
  a: string,
  b: string,
  type: string,
  stance: RelationsBranchResult["edges"][number]["stance"],
  band: "apply" | "suggest" | null = "apply"
) => {
  const [low, high] = a < b ? [a, b] : [b, a];
  return { id: branchId(`edge:${name}`), a: low, b: high, type, stance, band };
};

/** The branch as `relations.branch` answers it for Fermentação at colour depth 1. */
export function sampleBranch(
  overrides: Partial<RelationsBranchResult> = {}
): RelationsBranchResult {
  const n = branchNotes;
  return {
    topics: [
      {
        id: branchTopics.fermentation,
        title: "Fermentação",
        colourIndex: 2,
        parentId: branchId("topic:nutrition"),
        noteCount: 2
      },
      {
        id: branchTopics.alcoholic,
        title: "Fermentação alcoólica",
        colourIndex: 0,
        parentId: branchTopics.fermentation,
        noteCount: 2
      },
      {
        id: branchTopics.lactic,
        title: "Fermentação lática",
        colourIndex: 1,
        parentId: branchTopics.fermentation,
        noteCount: 3
      },
      {
        id: branchTopics.kefir,
        title: "Kefir",
        colourIndex: 1,
        parentId: branchTopics.lactic,
        noteCount: 1
      }
    ],
    nodes: [n.acid, n.kombucha, n.hours, n.bacteria, n.temperature, n.kefir, n.yeast, n.pasteur],
    edges: [
      edge("hours-acid", n.hours.id, n.acid.id, "supports", "supports"),
      edge("acid-temperature", n.acid.id, n.temperature.id, "extends", "extends"),
      edge("acid-bacteria", n.acid.id, n.bacteria.id, "depends_on", "depends_on"),
      edge("kefir-kombucha", n.kefir.id, n.kombucha.id, "extends", "extends", "suggest"),
      edge("yeast-kombucha", n.yeast.id, n.kombucha.id, "depends_on", "depends_on"),
      edge("pasteur-hours", n.pasteur.id, n.hours.id, "related", "related", null),
      edge("acid-kefir", n.acid.id, n.kefir.id, "contrasts", "contradicts", "suggest")
    ],
    outside: [{ topicId: branchTopics.history, title: "História da ciência", edgeCount: 2 }],
    superEdges: [
      {
        a:
          branchTopics.alcoholic < branchTopics.lactic
            ? branchTopics.alcoholic
            : branchTopics.lactic,
        b:
          branchTopics.alcoholic < branchTopics.lactic
            ? branchTopics.lactic
            : branchTopics.alcoholic,
        weight: 2
      },
      {
        a:
          branchTopics.fermentation < branchTopics.lactic
            ? branchTopics.fermentation
            : branchTopics.lactic,
        b:
          branchTopics.fermentation < branchTopics.lactic
            ? branchTopics.lactic
            : branchTopics.fermentation,
        weight: 1
      }
    ],
    truncated: false,
    ...overrides
  };
}

/** A branch with notes and no connection among them: the graph has nothing to draw. */
export const unconnectedBranch = (): RelationsBranchResult =>
  sampleBranch({ edges: [], superEdges: [], outside: [] });

const largeTitles = [
  "Fermentação espontânea começa com bactérias do ar",
  "O sal controla quais micro-organismos crescem",
  "Kimchi amadurece em geladeira por semanas",
  "O pH cai durante os primeiros dias",
  "Leveduras selvagens vivem na casca das frutas",
  "Vinho precisa de açúcar para virar álcool",
  "A cerveja separa a fermentação em duas etapas",
  "Pão de fermentação natural guarda uma cultura viva",
  "O iogurte usa duas bactérias que trabalham juntas",
  "Pasteur mostrou que fermentar é obra de seres vivos",
  "Temperatura alta acelera, mas estraga o sabor",
  "Chucrute dispensa qualquer fermento comprado",
  "Salmoura de 2% é suficiente para vegetais",
  "O gás carbônico faz a massa crescer",
  "Vinagre é a segunda fermentação do vinho",
  "A mãe do vinagre é uma cultura de bactérias",
  "Missô fermenta por meses com fungos",
  "Tempeh depende de um fungo que une os grãos",
  "Probióticos sobrevivem melhor em alimentos frios",
  "O oxigênio decide entre vinagre e álcool",
  "Fermentos industriais padronizam o resultado",
  "Cultura iniciadora acelera o começo",
  "Alimentos fermentados duram mais tempo",
  "A acidez protege contra patógenos"
] as const;

/**
 * A large branch as `relations.branch` answers it when the read hit its limits: 24 notes in four
 * topic groups (enough for the zoomed-out view), 30 relations of every stance, five topics outside
 * and `truncated`. Titles stand for the person's content.
 */
export function largeBranch(overrides: Partial<RelationsBranchResult> = {}): RelationsBranchResult {
  const base = sampleBranch();
  const homes = [
    branchTopics.fermentation,
    branchTopics.lactic,
    branchTopics.alcoholic,
    branchTopics.kefir
  ];
  const nodes = largeTitles.map((title, index) => ({
    id: branchId(`large:${index}`),
    title,
    topicId: homes[index % homes.length]!,
    degree: 1 + ((index * 5) % 6)
  }));
  const kinds = [
    ["supports", "supports"],
    ["extends", "extends"],
    ["depends_on", "depends_on"],
    ["contrasts", "contradicts"],
    ["related", "related"],
    ["example_of", "example_of"]
  ] as const;
  const edges = Array.from({ length: 30 }, (_, index) => {
    const [type, stance] = kinds[index % kinds.length]!;
    const from = nodes[index % nodes.length]!;
    // A different partner for each relation, so no pair repeats (the filter below drops a self-link).
    const to = nodes[(index * 3 + 5 + Math.floor(index / nodes.length) * 7) % nodes.length]!;
    const [low, high] = from.id < to.id ? [from.id, to.id] : [to.id, from.id];
    return {
      id: branchId(`large-edge:${index}`),
      a: low,
      b: high,
      type,
      stance,
      band: index % 7 === 3 ? ("suggest" as const) : ("apply" as const)
    };
  }).filter((entry) => entry.a !== entry.b);
  const ordered = (a: string, b: string) => (a < b ? { a, b } : { a: b, b: a });
  return {
    ...base,
    nodes,
    edges,
    outside: [
      { topicId: branchTopics.history, title: "História da ciência", edgeCount: 7 },
      { topicId: branchId("topic:nutrition"), title: "Nutrição e saúde intestinal", edgeCount: 5 },
      { topicId: branchId("topic:preservation"), title: "Conservação de alimentos", edgeCount: 3 },
      { topicId: branchId("topic:cooking"), title: "Técnicas de cozinha", edgeCount: 2 },
      { topicId: branchId("topic:microbes"), title: "Microbiologia", edgeCount: 1 }
    ],
    superEdges: [
      { ...ordered(branchTopics.alcoholic, branchTopics.lactic), weight: 6 },
      { ...ordered(branchTopics.fermentation, branchTopics.lactic), weight: 4 },
      { ...ordered(branchTopics.fermentation, branchTopics.alcoholic), weight: 3 },
      { ...ordered(branchTopics.kefir, branchTopics.alcoholic), weight: 1 }
    ],
    truncated: true,
    ...overrides
  };
}

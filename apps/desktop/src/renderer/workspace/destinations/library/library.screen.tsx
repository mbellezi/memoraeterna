import type { LibraryRow, LibraryRowsInput } from "../../../../shared/ipc-library";
import { screenTranslator } from "../../screen-locale";
import type { ScreenModule } from "../../surfaces";
import { LibraryRoot, librarySurface } from "./LibraryRoot";

/**
 * The Library root over a fake `window.app`: the design record's fixture (§17: 48 sources, five
 * root topics and two sources with no place), with the table's own reads answered from it. The
 * frame is the root's own; this module never writes the state. Titles are the person's content
 * and stay as the design wrote them; every other word comes from `@app/i18n`.
 */

export const surface = librarySurface;

const t = screenTranslator();
const noop = () => undefined;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** An instant `days` ago today at `hh:mm` local, so "hoje" and "ontem" read right whenever it runs. */
function at(days: number, hh: number, mm: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hh, mm, 0, 0);
  return date.toISOString();
}

const topic = (n: number, title: string) => ({ id: uuid(100 + n), title });
const life = topic(1, "Ciências da vida");
const micro = topic(2, "Microbiologia");
const ferment = topic(3, "Fermentação");
const lactic = topic(4, "Fermentação lática");
const urban = topic(5, "Planejamento urbano");
const active = topic(6, "Mobilidade ativa");
const music = topic(7, "Teoria musical");
const rhythm = topic(8, "Ritmo");
const harmony = topic(9, "Harmonia");
const history = topic(10, "História da ciência");
const conserv = topic(11, "Conservação de alimentos");
const nutrition = topic(12, "Nutrição");
const diets = topic(13, "Dietas");

const row = (
  n: number,
  fields: Pick<LibraryRow, "title" | "type" | "authors" | "status" | "noteCount" | "place"> &
    Partial<Pick<LibraryRow, "reason">> & { added: string }
): LibraryRow => ({
  id: uuid(n),
  title: fields.title,
  type: fields.type,
  authors: fields.authors,
  addedAt: fields.added,
  updatedAt: fields.added,
  status: fields.status,
  reason: fields.reason ?? null,
  noteCount: fields.noteCount,
  place: fields.place,
  hasCover: false
});

const rows: LibraryRow[] = [
  row(1, {
    title: "Ruas completas: lições de duas cidades andinas",
    type: "AcademicPaper",
    authors: ["R. Andrade", "L. Quispe"],
    status: "processing",
    noteCount: 7,
    place: { path: [urban, active], tentative: true },
    added: at(0, 9, 12)
  }),
  row(2, {
    title: "Ritmo e síncope no choro",
    type: "Video",
    authors: [],
    status: "ready",
    noteCount: 9,
    place: { path: [music, rhythm], tentative: false },
    added: at(0, 6, 10)
  }),
  row(3, {
    title: "Kefir e kombucha em casa",
    type: "GenericDocument",
    authors: [],
    status: "ready",
    noteCount: 14,
    place: { path: [life, micro, ferment, lactic], tentative: false },
    added: at(1, 22, 35)
  }),
  row(4, {
    title: "aula-04.txt",
    type: "GenericDocument",
    authors: [],
    status: "needsYou",
    reason: "no_model.no_route",
    noteCount: 0,
    place: null,
    added: at(1, 18, 20)
  }),
  row(5, {
    title: "Microbiologia dos alimentos, cap. 3",
    type: "BookChapter",
    authors: ["M. Vilela"],
    status: "ready",
    noteCount: 14,
    place: { path: [life, micro, ferment], tentative: false },
    added: at(3, 11, 0)
  }),
  row(6, {
    title: "Conservas e salgas no século XIX",
    type: "Book",
    authors: ["H. Duarte"],
    status: "ready",
    noteCount: 12,
    place: { path: [history, conserv], tentative: false },
    added: at(4, 15, 40)
  }),
  row(7, {
    title: "Harmonia funcional em dez lições",
    type: "GenericDocument",
    authors: ["C. Moura"],
    status: "ready",
    noteCount: 33,
    place: { path: [music, harmony], tentative: false },
    added: at(14, 10, 5)
  }),
  row(8, {
    title: "Chucrute em casa",
    type: "Video",
    authors: [],
    status: "ready",
    noteCount: 5,
    place: { path: [life, micro, ferment, lactic], tentative: false },
    added: at(15, 19, 30)
  }),
  row(9, {
    title: "Revisão: gordura saturada e coração (2020)",
    type: "AcademicPaper",
    authors: ["P. Almeida", "S. Costa", "J. Lima"],
    status: "ready",
    noteCount: 6,
    place: { path: [nutrition, diets], tentative: false },
    added: at(21, 8, 50)
  }),
  row(10, {
    title: "Mapa cicloviário de Bogotá",
    type: "GenericDocument",
    authors: [],
    status: "storedOnly",
    noteCount: 0,
    place: null,
    added: at(22, 14, 15)
  }),
  row(11, {
    title: "Tempo, tempero e temperatura: um guia para fermentados lentos de bairro",
    type: "WebArticle",
    authors: ["A. Ferraz"],
    status: "ready",
    noteCount: 11,
    place: { path: [life, micro, ferment], tentative: false },
    added: at(30, 12, 0)
  }),
  row(12, {
    title: "Escalas modais para iniciantes",
    type: "PersonalNote",
    authors: [],
    status: "storedOnly",
    noteCount: 0,
    place: { path: [music, harmony], tentative: false },
    added: at(31, 17, 25)
  })
];

const facets = {
  territories: [
    { topic: life, count: 13 },
    { topic: nutrition, count: 9 },
    { topic: urban, count: 11 },
    { topic: music, count: 8 },
    { topic: history, count: 5 },
    { topic: null, count: 2 }
  ],
  statuses: { processing: 1, ready: 43, failed: 0, needsYou: 1, storedOnly: 3 }
};

function answerRows(input: LibraryRowsInput | undefined) {
  const status = input?.filter?.status;
  const kept = status ? rows.filter((entry) => entry.status === status) : rows;
  return {
    rows: kept,
    total: status ? kept.length : 48,
    ...(input?.facets ? { facets } : {})
  };
}

const question = (
  n: number,
  text: string,
  scope: unknown,
  status: string,
  answerCount: number,
  days: number
) => ({
  id: uuid(300 + n),
  text,
  language: "pt-BR",
  scope,
  status,
  createdAt: at(days, 20, 15),
  updatedAt: at(days, 20, 20),
  answerCount
});

const questions = [
  question(
    1,
    "Por que alimentos fermentados duram mais fora da geladeira?",
    { kind: "library" },
    "complete",
    1,
    1
  ),
  question(
    2,
    "O que mudou na minha dieta depois de cortar o açúcar?",
    { kind: "topic", topicId: nutrition.id },
    "complete",
    2,
    3
  ),
  question(
    3,
    "Quais autores falam de síncope no choro?",
    { kind: "sources", sourceIds: [uuid(2), uuid(7)] },
    "complete",
    1,
    9
  )
];

const resolved = (address: string) => {
  const id = address.slice(address.lastIndexOf("/") + 1);
  const found = [
    life,
    micro,
    ferment,
    lactic,
    urban,
    active,
    music,
    rhythm,
    harmony,
    history,
    conserv,
    nutrition,
    diets
  ].find((entry) => entry.id === id);
  return {
    address,
    kind: "topic" as const,
    title: found?.title ?? "",
    status: "current" as const,
    preview: "",
    updatedAt: at(2, 10, 0)
  };
};

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "library.rows": (input?: LibraryRowsInput) => answerRows(input),
    "questions.list": { items: questions },
    "objects.get": ({ address }: { address: string }) => ({
      address,
      kind: "source" as const,
      title: "Microbiologia dos alimentos, cap. 3",
      status: "current" as const,
      preview:
        "O capítulo explica como bactérias láticas, leveduras e bolores competem nos alimentos e por que a acidez, o sal e a falta de oxigênio decidem quem vence.",
      updatedAt: at(3, 11, 0),
      counts: { notes: 14, passages: 31 }
    }),
    "objects.resolveMany": ({ addresses }: { addresses: string[] }) => ({
      items: Object.fromEntries(addresses.map((address) => [address, resolved(address)])),
      missing: []
    })
  },
  empty: {
    "library.rows": (input?: LibraryRowsInput) => ({
      rows: [],
      total: 0,
      ...(input?.facets
        ? {
            facets: {
              territories: [],
              statuses: { processing: 0, ready: 0, failed: 0, needsYou: 0, storedOnly: 0 }
            }
          }
        : {})
    }),
    "questions.list": { items: [] },
    "objects.resolveMany": { items: {}, missing: [] }
  }
};

export function render() {
  return (
    <LibraryRoot
      t={t}
      address="memora://library"
      mode="full"
      active
      onState={noop}
      onPlace={noop}
      onOpen={noop}
    />
  );
}

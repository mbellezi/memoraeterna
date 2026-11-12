import type { LanguageCode } from "@app/i18n";

/**
 * The app's own sentences inside the panel stack's and the panel frame's stand-in pages: the meta
 * line, the error and the empty state. A fixture's object titles and body text stand for the
 * person's content and stay in English; these words are the app's chrome, so they follow the
 * language the screen renders in (en and pt-BR, English for any other language). Only the screen
 * fixtures import this file.
 */

type PageKey = "source" | "topic" | "note" | "question" | "topNote" | "extra";
type Kind = "source" | "topic" | "note" | "question" | "entity";

export interface StandInCopy {
  /** The line under each page's title. */
  readonly meta: Readonly<Record<PageKey, string>>;
  /** One plain sentence saying what failed, and the muted line saying what is kept. */
  readonly error: Readonly<Record<Kind, { message: string; kept: string }>>;
  /** What a page says when its object has nothing in it yet. */
  readonly empty: Readonly<Record<Kind, { headline: string; body: string }>>;
  /** The source page's empty-state action. */
  readonly generate: string;
}

const en: StandInCopy = {
  meta: {
    source: "Book · 214 pages · 18 notes",
    topic: "18 notes · 2 sources",
    note: "Written by the local AI on 3 Nov · 1 source",
    question: "Asked on 4 Nov · 6 citations",
    topNote: "Written by the local AI on 3 Nov · reviewed by you on 5 Nov · 2 sources",
    extra: "Written by the local AI on 3 Nov · 1 source"
  },
  error: {
    source: {
      message: "This source could not be opened.",
      kept: "Nothing was changed. The source is still in your library."
    },
    topic: {
      message: "This topic could not be opened.",
      kept: "Nothing was changed. The topic is still in your library."
    },
    note: {
      message: "This note could not be opened.",
      kept: "Nothing was changed. The note is still in your library."
    },
    question: {
      message: "This question could not be opened.",
      kept: "Nothing was changed. The question is still in your library."
    },
    entity: {
      message: "This entity could not be opened.",
      kept: "Nothing was changed. The entity is still in your library."
    }
  },
  empty: {
    source: {
      headline: "Nothing is written here yet.",
      body: "The notes of this source appear here as they are written. You can already ask it a question."
    },
    topic: {
      headline: "Nothing is placed here yet.",
      body: "Notes and sources land here when the tree places them."
    },
    note: {
      headline: "This note has no text yet.",
      body: "Its text appears here when it is written."
    },
    question: {
      headline: "This question has no answer yet.",
      body: "The answer appears here as it is written, with its citations."
    },
    entity: {
      headline: "Nothing is written here yet.",
      body: "Notes that mention this entity appear here as they are written."
    }
  },
  generate: "Generate notes"
};

const ptBR: StandInCopy = {
  meta: {
    source: "Livro · 214 páginas · 18 notas",
    topic: "18 notas · 2 fontes",
    note: "Escrita pela IA local em 3 de nov. · 1 fonte",
    question: "Perguntada em 4 de nov. · 6 citações",
    topNote: "Escrita pela IA local em 3 de nov. · revisada por você em 5 de nov. · 2 fontes",
    extra: "Escrita pela IA local em 3 de nov. · 1 fonte"
  },
  error: {
    source: {
      message: "Não foi possível abrir esta fonte.",
      kept: "Nada foi alterado. A fonte continua na sua biblioteca."
    },
    topic: {
      message: "Não foi possível abrir este tópico.",
      kept: "Nada foi alterado. O tópico continua na sua biblioteca."
    },
    note: {
      message: "Não foi possível abrir esta nota.",
      kept: "Nada foi alterado. A nota continua na sua biblioteca."
    },
    question: {
      message: "Não foi possível abrir esta pergunta.",
      kept: "Nada foi alterado. A pergunta continua na sua biblioteca."
    },
    entity: {
      message: "Não foi possível abrir esta entidade.",
      kept: "Nada foi alterado. A entidade continua na sua biblioteca."
    }
  },
  empty: {
    source: {
      headline: "Ainda não há nada escrito aqui.",
      body: "As notas desta fonte aparecem aqui conforme são escritas. Você já pode fazer uma pergunta sobre ela."
    },
    topic: {
      headline: "Nada foi colocado aqui ainda.",
      body: "As notas e as fontes chegam aqui quando a árvore as coloca."
    },
    note: {
      headline: "Esta nota ainda não tem texto.",
      body: "O texto aparece aqui quando for escrito."
    },
    question: {
      headline: "Esta pergunta ainda não tem resposta.",
      body: "A resposta aparece aqui conforme é escrita, com as citações."
    },
    entity: {
      headline: "Ainda não há nada escrito aqui.",
      body: "As notas que mencionam esta entidade aparecem aqui conforme são escritas."
    }
  },
  generate: "Gerar notas"
};

const byLocale: Partial<Record<LanguageCode, StandInCopy>> = { "pt-BR": ptBR };

export const standInCopy = (locale: LanguageCode): StandInCopy => byLocale[locale] ?? en;
export const standInCopyTables = { en, "pt-BR": ptBR } as const;

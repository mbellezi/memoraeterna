import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { entityEmptyPage, entityFirstPage, entityFixture } from "./entity-fixtures";
import type { EntityLoad } from "./entity-model";
import { EntityPageView, type EntityPageViewProps } from "./EntityPageView";

const en = createTranslator("en");
const pt = createTranslator("pt-BR");
const noop = () => undefined;

const ready = (
  page = entityFirstPage,
  more: "idle" | "loading" | "error" = "idle"
): EntityLoad => ({
  status: "ready",
  page,
  more
});

function view(props: Partial<EntityPageViewProps> = {}) {
  return renderToString(
    <EntityPageView
      t={en}
      load={ready()}
      mode="full"
      onOpen={noop}
      onRetry={noop}
      onLoadMore={noop}
      {...props}
    />
  );
}

describe("the entity page", () => {
  it("takes the punctuation of the other names label from the translation", () => {
    const strip = (html: string) => html.replace(/<!-- -->/gu, "");
    expect(strip(view())).toContain("Other names: ");
    expect(strip(view({ t: createTranslator("fr") }))).toContain("Autres noms : ");
    expect(strip(view({ t: createTranslator("fr") }))).not.toContain("noms ::");
  });

  it("shows the name, the kind and the counts, the other names and the description", () => {
    const html = view();
    expect(html).toContain("<h1");
    expect(html).toContain("Lactobacillus");
    expect(html).toContain("Concept");
    expect(html).toContain("cited in 11 notes");
    expect(html).toContain("4 sources");
    expect(html).toContain("Other names");
    expect(html).toContain("lactobacilli, lactic acid bacteria");
    expect(html).toContain("A genus of rod-shaped bacteria");
  });

  it("groups the mentions under their topics, each topic opening beside, with the note's source", () => {
    const html = view();
    expect(html).toContain("Mentions");
    expect(html).toContain("11 notes, by topic");
    expect(html).toContain("Lactic fermentation");
    expect(html).toContain("Immunology");
    expect(html).toContain("Lactic acid inhibits pathogens by lowering the pH");
    expect(html).toContain("Food microbiology, ch. 3");
  });

  it("offers the notes that are not loaded yet, and says when loading them failed", () => {
    expect(view()).toContain("Show 3 more notes");
    expect(view({ load: ready(entityFirstPage, "loading") })).toContain("Loading more mentions");
    const failed = view({ load: ready(entityFirstPage, "error") });
    expect(failed).toContain("More mentions could not be loaded.");
    expect(failed).toContain("Retry");
  });

  it("lists who appears with it, its topics and its sources, and says the sources are those loaded", () => {
    const html = view();
    expect(html).toContain("Often appears with");
    expect(html).toContain("Louis Pasteur");
    expect(html).toContain("4 notes in common");
    expect(html).toContain("1 note in common");
    expect(html).toContain("Topics");
    expect(html).toContain("most cited");
    expect(html).toContain("Sources");
    expect(html).toContain("Sources of the mentions loaded so far.");
  });

  it("reads in the person's language, with no English left", () => {
    const html = view({ t: pt });
    for (const word of [
      "Conceito",
      "citada em 11 notas",
      "Outros nomes",
      "Menções",
      "11 notas, por tópico",
      "Mostrar mais 3 notas",
      "Costuma aparecer com",
      "Tópicos",
      "mais citada",
      "Fontes"
    ])
      expect(html, word).toContain(word);
    expect(html).not.toContain("Mentions");
    expect(html).not.toContain("Often appears");
  });

  it("names itself for assistive technology", () => {
    expect(view()).toContain('aria-label="Entity: Lactobacillus"');
  });
});

describe("the four states", () => {
  it("loading keeps a busy region and the shape of the page", () => {
    const html = view({ load: { status: "loading" } });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading");
  });

  it("empty says there are no direct mentions yet and what happens next, and keeps the header", () => {
    const html = view({ load: ready(entityEmptyPage) });
    expect(html).toContain("Lactobacillus");
    expect(html).toContain("No direct mentions yet.");
    expect(html).toContain("appear here as soon as they are written");
    expect(html).not.toContain("cited in");
    expect(html).not.toContain("Mentions");
  });

  it("a gone entity says so", () => {
    const html = view({ load: { status: "missing" } });
    expect(html).toContain("This entity is no longer in the library.");
  });

  it("error is one sentence, one line of what is kept and one retry", () => {
    const html = view({ load: { status: "error" }, t: pt });
    expect(html).toContain("Não foi possível abrir esta entidade.");
    expect(html).toContain("Suas notas e fontes continuam como estavam.");
    expect(html.match(/Tentar de novo/g)).toHaveLength(1);
  });
});

describe("the compact form (the previous panel)", () => {
  it("lists the notes and marks the one that was opened", () => {
    const html = view({
      mode: "compact",
      current: entityFixture.noteAddress
    });
    expect(html).toContain('aria-label="Notes that cite this entity"');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain("Lactic acid inhibits pathogens by lowering the pH");
    expect(html).not.toContain("Often appears with");
    expect(html).not.toContain("Other names");
  });

  it("marks no row when the opened panel is not one of the notes", () => {
    expect(view({ mode: "compact" })).not.toContain("aria-current");
  });
});

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, type LanguageCode } from "@app/i18n";

import { fixtureId, idleMore, notePage, relationItem } from "./note-page-fixtures";
import { NoteRelations } from "./NoteRelations";

const noop = () => undefined;

function relations(language: LanguageCode, view: "full" | "summary") {
  const items = [
    relationItem({ id: fixtureId(60), type: "supports" }),
    relationItem({ id: fixtureId(61), type: "supports" }),
    relationItem({ id: fixtureId(62), type: "extends" }),
    // Medium confidence: the Inbox takes this suggestion too.
    relationItem({ id: fixtureId(63), type: "supports", state: "suggested", probability: 0.7 }),
    // High confidence: it stays inline.
    relationItem({ id: fixtureId(64), type: "supports", state: "suggested", probability: 0.92 }),
    // A contradiction always goes to the Inbox, whatever its confidence.
    relationItem({ id: fixtureId(65), type: "contradicts", state: "suggested", probability: 0.95 }),
    // No probability is not "high".
    relationItem({ id: fixtureId(66), type: "extends", state: "suggested", probability: null })
  ];
  const page = notePage({ relations: { items, total: items.length + 3 } });
  return renderToString(
    <NoteRelations
      t={createTranslator(language)}
      thisId={fixtureId(1)}
      thisPrimary={null}
      relations={page.relations}
      withdrawn={page.withdrawn}
      earlierVersions={page.earlierVersions}
      openCard={null}
      explanations={{}}
      reviews={{}}
      more={idleMore}
      withdrawnOpen={false}
      focusRequest={null}
      view={view}
      onCardEvent={noop}
      onOpenNote={noop}
      onRetryExplanation={noop}
      onReview={noop}
      onToggleWithdrawn={noop}
      onFocusHandled={noop}
      onShowMore={noop}
    />
  );
}

const plain = (html: string) => html.replaceAll("<!-- -->", "");

describe("a note's relations beside a docked context panel", () => {
  it("show the stance summary, with the suggestions counted and what is not loaded yet", () => {
    const html = plain(relations("en", "summary"));
    expect(html).toContain("Each connection, with its evidence, is in the context panel.");
    // One chip per stance with its count: four supports, two extends, one contradicts.
    expect(html).toMatch(/supports<\/span>\s*<span[^>]*>4<\/span>/u);
    expect(html).toMatch(/extends<\/span>\s*<span[^>]*>2<\/span>/u);
    expect(html).toContain("4 suggestions");
    expect(html).toContain("3 more");
    // No row is listed: the context panel lists them.
    expect(html).not.toContain("data-relation-id");
  });

  it("read in pt-BR with no English chrome", () => {
    const html = plain(relations("pt-BR", "summary"));
    expect(html).toContain("Cada conexão, com a sua evidência, está no painel de contexto.");
    expect(html).toContain("4 sugestões");
    expect(html).toContain("mais 3");
    expect(html).not.toContain("suggestions");
  });
});

describe("a note's relations with the context panel a strip or hidden", () => {
  it("list every relation in full", () => {
    const html = plain(relations("en", "full"));
    expect(html.match(/data-relation-id=/gu)).toHaveLength(7);
    expect(html).not.toContain("Each connection, with its evidence, is in the context panel.");
  });

  it("say a suggestion also reaches the Inbox exactly when the rule routes it there (D33)", () => {
    const html = plain(relations("pt-BR", "full"));
    // Medium confidence, a contradiction and an unknown confidence route to the Inbox.
    expect(html.match(/também na Caixa de entrada/gu)).toHaveLength(3);
    // High confidence stays inline.
    expect(html.match(/sugestão do Jardineiro · decida quando quiser/gu)).toHaveLength(1);
  });
});

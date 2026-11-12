import { renderToString } from "react-dom/server";
import { describe, it } from "vitest";
import { expect } from "vitest";
import { createTranslator } from "@app/i18n";

import { SourceDetailView } from "../../../components/LibraryView";
import { sourceFixture, sourceFixtureIds } from "./source-fixture";

const noop = () => undefined;

// React's generated ids (`_R_5_`) count the components rendered before them; the page's own markup
// is what the goldens pin.
const withoutGeneratedIds = (html: string) => html.replace(/_R_[0-9a-z]+_/g, "_R_");

function render(props: Partial<Parameters<typeof SourceDetailView>[0]>, language = "en"): string {
  return withoutGeneratedIds(
    renderToString(
      <SourceDetailView
        detail={sourceFixture()}
        active
        focusedAtomicNoteId={null}
        allSources={[]}
        backLabel="Back"
        t={createTranslator(language)}
        onOpen={noop}
        onOpenPath={noop}
        onGoToLibrary={noop}
        onBack={noop}
        onProcess={noop}
        onDeleted={noop}
        onRefresh={noop}
        onPage={noop}
        offset={0}
        loading={false}
        loadError={false}
        metadataEnrichmentEnabled
        onOpenNote={noop}
        onNavigateObject={noop}
        focusedPassage={null}
        onPassageShown={noop}
        {...props}
      />
    )
  );
}

// The Source page was moved out of LibraryView into the source panel parts (F5 T139): the markup of
// every tab the page can open on stays what it was. The goldens were written from the page as it
// was before the move.
describe("the Source page markup survives its extraction", () => {
  it("overview", async () => {
    await expect(render({})).toMatchFileSnapshot("__parity__/overview.golden.txt");
  });
  it("overview in pt-BR", async () => {
    await expect(render({}, "pt-BR")).toMatchFileSnapshot("__parity__/overview.pt-BR.golden.txt");
  });
  it("content on a cited passage", async () => {
    const html = render({
      focusedPassage: {
        passage: { chunkId: sourceFixtureIds.chunks[1]!, sourceSpanId: null, documentId: null },
        token: 1
      }
    });
    await expect(html).toMatchFileSnapshot("__parity__/content.golden.txt");
  });
  it("notes", async () => {
    const html = render({ focusedAtomicNoteId: sourceFixtureIds.note });
    await expect(html).toMatchFileSnapshot("__parity__/notes.golden.txt");
  });
  it("graph", async () => {
    const html = render({ focusedSourceRelationId: sourceFixtureIds.relation });
    await expect(html).toMatchFileSnapshot("__parity__/graph.golden.txt");
  });
});

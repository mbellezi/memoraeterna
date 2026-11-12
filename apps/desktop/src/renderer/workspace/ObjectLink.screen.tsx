import { createPreviewBatcher } from "./preview-batcher";
import { ObjectLink } from "./ObjectLink";
import { previewAddresses, previewFixtures } from "./preview-screen-fixtures";
import { screenTranslator } from "./screen-locale";
import type { ScreenModule } from "./surfaces";

export const surface = "object-card";

const t = screenTranslator();

export const fixtures: ScreenModule["fixtures"] = {
  success: previewFixtures(false),
  empty: previewFixtures(true)
};

/** The calls go to the fake `window.app` of the mode: a fresh batcher per mount shares no pending read. */
function screenBatcher() {
  return createPreviewBatcher({
    resolveMany: (input) => window.app.objects.resolveMany(input)
  });
}

/**
 * Two links in running text with their hover cards held open: a plain object link (the card shows
 * the place, the first lines and the counts) and a relation link (the card says "Vai para" and
 * the place it leads to). The text is a reading column at its measure and each card hangs in the margin beside it,
 * past the end of the paragraph, so no running text is covered.
 */
export function render() {
  const batcher = screenBatcher();
  return (
    <div className="grid max-w-(--measure) gap-80 font-reading text-reading leading-relaxed">
      <p className="m-0">
        Sauerkraut keeps for weeks outside the fridge because{" "}
        <ObjectLink
          t={t}
          address={previewAddresses.note}
          onOpen={() => undefined}
          previewOpen
          portal={false}
          batcher={batcher}
        >
          lactic acid lowers the pH and inhibits pathogens
        </ObjectLink>
        , and the same barrier explains the old pantry.
      </p>
      <p className="m-0">
        The old pantry relied on salt and acid, as the note{" "}
        <ObjectLink
          t={t}
          address={previewAddresses.relatedNote}
          onOpen={() => undefined}
          previewOpen
          portal={false}
          batcher={batcher}
        >
          on the 19th century
        </ObjectLink>{" "}
        says.
      </p>
    </div>
  );
}

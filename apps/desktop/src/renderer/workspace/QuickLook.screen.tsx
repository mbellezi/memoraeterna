import { QuickLook } from "./QuickLook";
import { createPreviewBatcher } from "./preview-batcher";
import { previewAddresses, previewFixtures } from "./preview-screen-fixtures";
import { screenTranslator } from "./screen-locale";
import type { ScreenModule } from "./surfaces";

export const surface = "quick-look";

const t = screenTranslator();

export const fixtures: ScreenModule["fixtures"] = {
  success: previewFixtures(false),
  empty: previewFixtures(true)
};

/** A few rows of a list behind the sheet, as it is in use: the person's titles, nothing of the app's own chrome. */
const rows = [
  "Street grids: lessons from two hundred cities",
  "Rhythm and syncopation in choro",
  "Kefir and kombucha at home",
  "Food microbiology, chapter 3",
  "Preserves and salting in the 19th century",
  "Functional harmony in ten lessons"
];

/**
 * The sheet over a list, in place (the app renders it in a portal): it peeks at a source. The
 * keyboard is on the row underneath, so the list is drawn but never focused here.
 */
export function render() {
  const batcher = createPreviewBatcher({
    resolveMany: (input) => window.app.objects.resolveMany(input)
  });
  return (
    <div className="h-full min-h-[640px]">
      <ul className="m-0 grid max-w-3xl list-none gap-0 p-0 text-sm text-secondary-foreground">
        {rows.map((row) => (
          <li key={row} className="border-b border-border py-4">
            {row}
          </li>
        ))}
      </ul>
      <QuickLook
        t={t}
        address={previewAddresses.source}
        onClose={() => undefined}
        portal={false}
        batcher={batcher}
      />
    </div>
  );
}

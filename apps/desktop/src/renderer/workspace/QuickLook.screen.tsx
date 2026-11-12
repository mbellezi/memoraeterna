import { cn } from "../lib/cn";
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
  "Kefir and kombucha at home",
  "Food microbiology, chapter 3",
  "Street grids: lessons from two hundred cities",
  "Rhythm and syncopation in choro",
  "Preserves and salting in the 19th century",
  "Functional harmony in ten lessons"
];
/** The row the keyboard is on, the one the sheet peeks at: it sits above the sheet, so the capture shows it. */
const peeked = "Food microbiology, chapter 3";

/**
 * The sheet over a list, in place (the app renders it in a portal): it peeks at a source. The
 * keyboard is on the row underneath: the peeked row wears the selected-row style (tint and 2 px
 * accent bar) and its focus ring, drawn here without moving focus.
 */
export function render() {
  const batcher = createPreviewBatcher({
    resolveMany: (input) => window.app.objects.resolveMany(input)
  });
  return (
    <div className="h-full min-h-[640px]">
      <ul className="m-0 grid max-w-3xl list-none gap-0 p-0 text-sm text-secondary-foreground">
        {rows.map((row) => (
          <li
            key={row}
            aria-current={row === peeked ? "true" : undefined}
            className={cn(
              "border-b border-border px-4 py-3",
              row === peeked &&
                "bg-surface-selected text-foreground [box-shadow:inset_2px_0_0_var(--accent)] outline-2 -outline-offset-2 outline-accent"
            )}
          >
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

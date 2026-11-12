import { createPreviewBatcher } from "../preview-batcher";
import { screenTranslator } from "../screen-locale";
import { defaultWorkspace } from "../state";
import type { ScreenModule } from "../surfaces";
import { Palette } from "./Palette";
import { backdropRows, omniFixture, recentFixture, resolveManyFixture } from "./palette-fixtures";

export const surface = "palette";

/** The palette is an overlay on the whole window: the screens tool shows it with no stand around it. */
export const fullWindow = true;

const t = screenTranslator();
const noop = () => undefined;

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "search.omni": omniFixture(false),
    "objects.resolveMany": resolveManyFixture(),
    "viewHistory.list": recentFixture(false)
  },
  empty: {
    "search.omni": omniFixture(true),
    "objects.resolveMany": resolveManyFixture(),
    "viewHistory.list": recentFixture(true)
  }
};

/**
 * The palette open over a list, with "ferment" typed: the real component over the fake `window.app`.
 * Success lists the groups, empty is the answer with nothing in it, error is a search that fails
 * (the actions still work) and loading is a search that has not answered.
 */
export function render() {
  const batcher = createPreviewBatcher({
    resolveMany: (input) => window.app.objects.resolveMany(input)
  });
  return (
    <div className="h-full min-h-[640px] bg-background">
      <ul className="m-0 grid max-w-3xl list-none gap-0 p-8 text-sm text-secondary-foreground">
        {backdropRows.map((row) => (
          <li key={row} className="border-b border-border py-4">
            {row}
          </li>
        ))}
      </ul>
      <Palette
        t={t}
        state={defaultWorkspace("2026-11-11")}
        initialQuery="ferment"
        onEffect={noop}
        onClose={noop}
        portal={false}
        batcher={batcher}
      />
    </div>
  );
}

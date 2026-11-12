import { screenTranslator } from "../../screen-locale";
import type { ScreenModule } from "../../surfaces";
import { libraryCompactSurface } from "./LibraryList";
import { LibraryRoot } from "./LibraryRoot";
import { fixtures as libraryFixtures, uuid } from "./library.screen";

/**
 * The Library as the previous panel (design record §3, §7.3): once a Source is open beside it, the
 * table is its list of titles in a narrow column, with the open row marked. The column is the
 * stack's previous-panel width (216 px below 1180 px, 240 px above), and the third source is open.
 */

export const surface = libraryCompactSurface;
export const fixtures: ScreenModule["fixtures"] = libraryFixtures;

const t = screenTranslator();
const noop = () => undefined;

export function render() {
  const width = window.innerWidth < 1180 ? 216 : 240;
  return (
    <div
      style={{ width, height: 640 }}
      className="overflow-hidden rounded-lg border border-border bg-background"
    >
      <LibraryRoot
        t={t}
        address="memora://library"
        mode="compact"
        active
        current={`memora://source/${uuid(3)}`}
        surfaceId={libraryCompactSurface}
        onState={noop}
        onPlace={noop}
        onOpen={noop}
      />
    </div>
  );
}

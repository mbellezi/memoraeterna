import { screenTranslator } from "../../screen-locale";
import type { ScreenModule } from "../../surfaces";
import { fixtures as libraryFixtures } from "./library.screen";
import { libraryPeekSurface } from "./LibraryPeek";
import { LibraryRoot } from "./LibraryRoot";

/**
 * Quick-look in the Library (design record §7.3, `#peek`): the table with its first row looked at,
 * the centred non-modal sheet drawn in place so a capture shows its heading line, ribbon, serif
 * summary and foot. It reads the same fixtures as the Library root; the frame is the root's own and
 * reports `library-peek`. With no rows (loading, empty, error) there is nothing to look at and the
 * sheet stays closed.
 */

export const surface = libraryPeekSurface;
export const fixtures: ScreenModule["fixtures"] = libraryFixtures;

const t = screenTranslator();
const noop = () => undefined;

export function render() {
  return (
    <LibraryRoot
      t={t}
      address="memora://library"
      mode="full"
      active
      preview="peek"
      onState={noop}
      onPlace={noop}
      onOpen={noop}
    />
  );
}

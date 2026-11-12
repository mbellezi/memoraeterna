import { screenTranslator } from "../../screen-locale";
import type { ScreenModule } from "../../surfaces";
import { libraryDenseSurface } from "./LibraryGrid";
import { LibraryRoot } from "./LibraryRoot";
import { fixtures as libraryFixtures } from "./library.screen";

/**
 * The Fontes table in the Compacto density (design record §7.3: the header's toggle, 8 px of
 * padding): the same rows, closer together.
 */

export const surface = libraryDenseSurface;
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
      density="compact"
      surfaceId={libraryDenseSurface}
      onState={noop}
      onPlace={noop}
      onOpen={noop}
      onAdd={noop}
    />
  );
}

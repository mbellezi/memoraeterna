import { screenTranslator } from "../../screen-locale";
import type { ScreenModule } from "../../surfaces";
import { fixtures as libraryFixtures } from "./library.screen";
import { libraryPeekSurface } from "./LibraryPeek";
import { LibraryRoot } from "./LibraryRoot";

/**
 * Quick-look in the Library (design record §7.3, `#peek`): the table with its first row looked at,
 * the centred non-modal sheet drawn in place so a capture shows its heading line, ribbon, serif
 * summary and foot. The rows are answered in every state, and the states are the sheet's own: the
 * frame reports what the sheet's read says. Loading keeps `objects.get` pending, error makes it
 * fail, and empty answers an object with no summary and no counts yet.
 */

export const surface = libraryPeekSurface;

const success = libraryFixtures.success;
const rowsAnswered = {
  "library.rows": success["library.rows"],
  "questions.list": success["questions.list"],
  "objects.resolveMany": success["objects.resolveMany"]
};

export const fixtures: ScreenModule["fixtures"] = {
  success,
  loading: rowsAnswered,
  error: { ...rowsAnswered, "objects.locate": success["objects.locate"] },
  empty: {
    ...success,
    "objects.get": ({ address }: { address: string }) => ({
      address,
      kind: "source" as const,
      title: "Ruas completas: lições de duas cidades andinas",
      status: "current" as const,
      preview: "",
      updatedAt: new Date(0).toISOString()
    })
  }
};

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

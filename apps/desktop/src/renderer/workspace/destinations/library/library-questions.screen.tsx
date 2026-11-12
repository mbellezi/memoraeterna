import { screenTranslator } from "../../screen-locale";
import type { ScreenModule } from "../../surfaces";
import { libraryQuestionsSurface } from "./LibraryQuestions";
import { LibraryRoot } from "./LibraryRoot";
import { fixtures as libraryFixtures } from "./library.screen";

/**
 * The Library's Perguntas tab (design record §7.3: the same table grammar as Fontes), opened as
 * `memora://library?tab=questions`: saved questions with what they were asked about, their answers,
 * their state and when they were asked.
 */

export const surface = libraryQuestionsSurface;
export const fixtures: ScreenModule["fixtures"] = libraryFixtures;

const t = screenTranslator();
const noop = () => undefined;

export function render() {
  return (
    <LibraryRoot
      t={t}
      address="memora://library?tab=questions"
      mode="full"
      active
      surfaceId={libraryQuestionsSurface}
      onState={noop}
      onPlace={noop}
      onOpen={noop}
      onAdd={noop}
    />
  );
}

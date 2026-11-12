import { screenLocale } from "../../../workspace/screen-locale";
import type { ScreenModule } from "../../../workspace/surfaces";
import { section } from "./GeneralSection";
import { SectionScreen, describeFixture } from "./section-screen";

/** General and appearance, inside the Settings surface (fullWindow: the rail's width stands empty). */
export const fullWindow = true;

export const surface = "settings-general";

const here = screenLocale();
// The notes are written in another language than the macOS one: the row shows the marker, the
// default and the pointer to Knowledge.
const notes = here === "en" ? "pt-BR" : "en";

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "settings.describe": describeFixture({
      themeMode: { value: "system", default: "system" },
      contentLanguage: { value: notes, default: here, changed: true },
      language: { value: here, default: here }
    })
  },
  empty: { "settings.describe": { entries: [] } }
};

export function render() {
  return <SectionScreen surface={surface} section={section.id} />;
}

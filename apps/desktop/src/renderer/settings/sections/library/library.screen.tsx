import { screenLocale } from "../../../workspace/screen-locale";
import type { ScreenModule } from "../../../workspace/surfaces";
import { SectionScreen, describeFixture } from "../general/section-screen";
import { section } from "./LibrarySection";

/** Library and storage, inside the Settings surface. */
export const fullWindow = true;

export const surface = "settings-library";

const here = screenLocale();
const plan = (id: string, name: string, stages: string[]) => ({
  id,
  name,
  requestedStages: stages
});

const now = "2026-11-12T09:00:00.000Z";

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "settings.describe": describeFixture({
      // The copy is on: the row carries the marker, "Default: Off" and the way back.
      uploadCopies: { value: true, default: false, changed: true }
    }),
    "library.rows": { rows: [], total: 214 },
    "settings.get": {
      obsidianVaultPath: null,
      managedRoot: "Memora",
      obsidianSyncEnabled: false,
      obsidianSyncPaused: false,
      uploadCopiesEnabled: true,
      uploadCopiesFolderPath: "/Users/you/Documents/Memora copies",
      updatedAt: now
    },
    "settings.getApp": {
      language: here,
      contentLanguage: here,
      themeMode: "system",
      processingPresets: [
        plan("0b2a4a7e-5f6e-4c8b-9a3b-1c2d3e4f5a61", "Short articles (example)", [
          "parse",
          "segment",
          "embed"
        ]),
        plan("1c3b5b8f-6a7f-4d9c-8b4c-2d3e4f5a6b72", "Large books (example)", [
          "parse",
          "segment",
          "embed",
          "summarize",
          "notes",
          "graph"
        ])
      ],
      updatedAt: now
    }
  },
  empty: { "settings.describe": { entries: [] } }
};

export function render() {
  return <SectionScreen surface={surface} section={section.id} />;
}

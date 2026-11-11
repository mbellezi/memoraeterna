import { createTranslator } from "@app/i18n";

import type { ScreenModule } from "../../workspace/surfaces";
import { fixtureId, notePage } from "./note-page-fixtures";
import { NotePage } from "./NotePage";

export const surface = "note-page";

const t = createTranslator("en");
const noop = () => undefined;

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "notes.page": notePage(),
    "notes.relations": { items: [], total: 0 },
    "objects.locate": null,
    "viewHistory.record": null,
    "knowledge.reviewNote": null
  },
  empty: {
    // A note that nothing supports or connects yet: no evidence and no relations.
    "notes.page": notePage({
      evidence: { items: [], total: 0 },
      relations: { items: [], total: 0 }
    }),
    "notes.relations": { items: [], total: 0 },
    "objects.locate": null,
    "viewHistory.record": null
  }
};

export function render() {
  return (
    <NotePage
      noteId={fixtureId(1)}
      active
      backLabel="Back to library"
      t={t}
      onBack={noop}
      onOpenNote={noop}
      onOpenPassage={noop}
      onNavigate={noop}
    />
  );
}

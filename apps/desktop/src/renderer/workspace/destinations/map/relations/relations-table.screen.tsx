import { screenTranslator } from "../../../screen-locale";
import type { ScreenModule } from "../../../surfaces";
import { branchTopics, largeBranch, unconnectedBranch } from "./branch-fixtures";
import { RelationsLens } from "./RelationsLens";
import { tableSurfaceId } from "./RelationsTable";

export const surface = tableSurfaceId;

const t = screenTranslator();
const noop = () => undefined;

const settings = { graphWheelZoomSensitivity: 1 };

/**
 * The Map › Grafo in "Só tabela" (design record 7.5): a large branch the read cut short, so the
 * notice, the table, the lines between topics and the topics outside the branch all show. The
 * canvas is not mounted: the table carries every connection on its own.
 */
export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "relations.branch": largeBranch(),
    "settings.getApp": settings
  },
  empty: {
    "relations.branch": unconnectedBranch(),
    "settings.getApp": settings
  }
};

export function render() {
  return (
    <div className="min-h-[720px] bg-background px-6 py-5 max-[1179px]:px-4">
      <RelationsLens
        t={t}
        active
        scope={{ kind: "topic", id: branchTopics.fermentation }}
        onOpenNote={noop}
        onShowTree={noop}
        frame={{ surface, display: "table" }}
      />
    </div>
  );
}

import type { ScreenModule } from "../surfaces";
import { ContextColumn, contextFixtures, focusedNote, t } from "./context-fixtures";
import { GraphTab } from "./graph-tab";

export const surface = "context-graph";

export const fixtures: ScreenModule["fixtures"] = {
  success: contextFixtures(false),
  empty: contextFixtures(true)
};

const noop = () => undefined;

export function render() {
  return (
    <ContextColumn>
      <GraphTab
        t={t}
        address={focusedNote.address}
        kind="note"
        id={focusedNote.id}
        active
        onOpen={noop}
        onTab={noop}
        onLink={noop}
      />
    </ContextColumn>
  );
}

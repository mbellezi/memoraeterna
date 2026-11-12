import type { ScreenModule } from "../surfaces";
import { ConnectionsTab } from "./connections-tab";
import { ContextColumn, contextFixtures, focusedNote, t } from "./context-fixtures";

export const surface = "context-connections";

export const fixtures: ScreenModule["fixtures"] = {
  success: contextFixtures(false),
  empty: contextFixtures(true)
};

const noop = () => undefined;

export function render() {
  return (
    <ContextColumn>
      <ConnectionsTab
        t={t}
        address={focusedNote.address}
        kind="note"
        id={focusedNote.id}
        active
        onOpen={noop}
        onTab={noop}
      />
    </ContextColumn>
  );
}

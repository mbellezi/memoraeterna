import type { ScreenModule } from "../surfaces";
import { ContextColumn, contextFixtures, focusedNote, t } from "./context-fixtures";
import { MentionsTab } from "./mentions-tab";

export const surface = "context-mentions";

export const fixtures: ScreenModule["fixtures"] = {
  success: contextFixtures(false),
  empty: contextFixtures(true)
};

const noop = () => undefined;

export function render() {
  return (
    <ContextColumn>
      <MentionsTab
        t={t}
        address={focusedNote.address}
        kind="note"
        id={focusedNote.id}
        active
        onOpen={noop}
      />
    </ContextColumn>
  );
}

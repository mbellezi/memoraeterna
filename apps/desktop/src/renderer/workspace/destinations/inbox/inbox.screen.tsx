import { fixtures as inboxFixtures } from "../../../components/inbox/inbox.screen";
import { screenTranslator } from "../../screen-locale";
import { formatView } from "../../route";
import type { ScreenModule } from "../../surfaces";
import { InboxRoot } from "./InboxRoot";

export const surface = "destination-inbox";

const t = screenTranslator();
const noop = () => undefined;

/** The same items as the Inbox screen's capture: the suggestions at their medium risk, then one of every other kind. */
export const fixtures: ScreenModule["fixtures"] = inboxFixtures;

export function render() {
  return (
    <div className="h-full min-h-[640px] bg-background">
      <InboxRoot
        t={t}
        address={formatView({ view: "inbox" })}
        mode="full"
        active
        onState={noop}
        onPlace={noop}
        onOpen={noop}
      />
    </div>
  );
}

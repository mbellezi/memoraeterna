import { fixtures as inboxFixtures } from "../../../components/inbox/inbox.screen";
import type { InboxViewProps } from "../../../components/inbox/InboxView";
import { screenTranslator } from "../../screen-locale";
import { formatView } from "../../route";
import type { ScreenModule } from "../../surfaces";
import { compactSurfaceId, InboxRoot } from "./InboxRoot";

export const surface = compactSurfaceId;

const t = screenTranslator();
const noop = () => undefined;

/** The Inbox as the previous panel (design record §8): its item list in the 240 px column. */
const compact = { compact: true } satisfies Pick<InboxViewProps, "compact">;

export const fixtures: ScreenModule["fixtures"] = inboxFixtures;

export function render() {
  return (
    <div className="h-full min-h-[640px] w-60 overflow-hidden rounded-lg border border-border bg-background">
      <InboxRoot
        t={t}
        address={formatView({ view: "inbox" })}
        mode={compact.compact ? "compact" : "full"}
        active
        onState={noop}
        onPlace={noop}
        onOpen={noop}
      />
    </div>
  );
}

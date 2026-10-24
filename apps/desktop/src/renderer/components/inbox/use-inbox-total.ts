import { useEffect, useState, useSyncExternalStore } from "react";

import { InboxBadge } from "./inbox-badge";

/** How many items wait in the Inbox (null until known); `enabled` is false until the library is open. */
export function useInboxTotal(enabled: boolean): number | null {
  const [badge] = useState(() => new InboxBadge(() => window.app));
  useEffect(() => {
    if (!enabled) return undefined;
    badge.start();
    return () => badge.stop();
  }, [badge, enabled]);
  return useSyncExternalStore(badge.subscribe, badge.getSnapshot, badge.getSnapshot);
}

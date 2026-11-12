import { useEffect, useState } from "react";

import { useStableCallback } from "../../../lib/stable-callback";
import { readOnEvents, type ReadSource } from "../../../lib/status-followers";
import { useSettings } from "../../settings-context";

export type SectionRead<V> =
  { status: "loading" } | { status: "error" } | { status: "ready"; value: V };

/**
 * What a part of a Settings section reads besides `settings.describe` (a count, a status, a list of
 * saved plans): one read when Settings is shown, again after each event of `sources` (the bus, never a
 * timer) and again when Settings is shown after another place. A hidden Settings reads and listens
 * to nothing. A failed first read says so (`error`) and `retry` asks again; a value that was read
 * stays when a later read fails. `set` puts in a value the caller already holds (the answer of its own
 * write), so the part does not wait for the event that confirms it.
 */
export function useSectionRead<V>(
  read: () => Promise<V>,
  sources: readonly ReadSource[] = []
): { state: SectionRead<V>; retry: () => void; set: (value: V) => void } {
  const { active } = useSettings();
  const [state, setState] = useState<SectionRead<V>>({ status: "loading" });
  const [round, setRound] = useState(0);
  const stableRead = useStableCallback(read);
  const sourcesKey = sources.map((source) => source.type).join(",");

  useEffect(() => {
    if (!active) return undefined;
    const follower = readOnEvents<V>({
      api: () => (typeof window === "undefined" ? undefined : window.app),
      sources,
      read: stableRead,
      onValue: (value) => setState({ status: "ready", value }),
      onError: () =>
        setState((current) => (current.status === "ready" ? current : { status: "error" }))
    });
    return () => follower.stop();
    // `sources` are module constants, named by `sourcesKey`.
  }, [active, round, sourcesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    state,
    retry: () => {
      setState({ status: "loading" });
      setRound((value) => value + 1);
    },
    set: (value) => setState({ status: "ready", value })
  };
}

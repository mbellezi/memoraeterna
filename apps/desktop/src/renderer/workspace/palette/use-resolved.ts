import { useEffect, useRef, useState } from "react";
import type { ObjectResolved } from "@app/domain";

import { previewBatcher, type PreviewBatcher } from "../preview-batcher";

/**
 * What `objects.resolveMany` knows about a list of addresses (their place and counts), for the rows
 * of Cmd-K and of the search results panel. Every address of a render is asked in one window
 * through the preview batcher, so a list of thirty rows is one call. A row the read could not
 * answer simply has no place: the list never waits for it and never fails for it.
 */
export function useResolved(
  addresses: readonly string[],
  batcher?: PreviewBatcher
): ReadonlyMap<string, ObjectResolved> {
  const [resolved, setResolved] = useState<ReadonlyMap<string, ObjectResolved>>(new Map());
  const asked = useRef(new Set<string>());
  // An answer that arrives after the list changed still belongs to its rows; only an unmount drops it.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const key = addresses.join("\n");
  useEffect(() => {
    const wanted =
      key === "" ? [] : key.split("\n").filter((address) => !asked.current.has(address));
    if (wanted.length === 0) return undefined;
    for (const address of wanted) asked.current.add(address);
    const reader = batcher ?? previewBatcher();
    void Promise.all(
      wanted.map((address) =>
        reader.request(address).then(
          (result) => (result.status === "ready" ? ([address, result.item] as const) : null),
          () => {
            // Asked again with the next render: a failed read leaves the row without a place.
            asked.current.delete(address);
            return null;
          }
        )
      )
    ).then((entries) => {
      if (!mounted.current) return;
      const found = entries.filter((entry) => entry !== null);
      if (found.length === 0) return;
      setResolved((current) => new Map([...current, ...found]));
    });
    return undefined;
  }, [key, batcher]);
  return resolved;
}

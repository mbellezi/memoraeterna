import { useEffect } from "react";
import type { ObjectSummary } from "@app/domain";
import type { Translator } from "@app/i18n";

import { useOmni } from "../../lib/use-omni";
import type { PanelProps } from "../PanelStack";
import { parseViewAddress } from "../route";
import { SearchResultsView } from "./search/SearchResultsView";
import {
  parseSearchAddress,
  reportedState,
  searchAddress,
  searchParams
} from "./search/search-model";

/**
 * The search results panel (design record §11, spec 3.5): the full answer to a Cmd-K query, in full
 * mode, narrowed to some kinds when it was opened from a group's "mostrar mais". The address
 * carries the query and the kinds (`memora://search?q=…&kinds=…`), so Back and the closed list
 * bring a search back as it was. A hidden panel asks for nothing.
 */

export const kind = "search";

export function match(address: string): boolean {
  return parseViewAddress(address)?.view === "search";
}

/** A view panel has no object to name it: the header says what it is. */
export function title(_summary: ObjectSummary | null, t: Translator): string {
  return t("palette.results.title");
}

export function Component({ t, address, mode, active, onState, onOpen, current }: PanelProps) {
  const ask = parseSearchAddress(address);
  const omni = useOmni(ask === null ? null : searchParams(ask), { enabled: active });
  const reported = ask === null ? "error" : reportedState(omni);
  useEffect(() => onState(reported), [onState, reported]);
  if (ask === null) return null;
  return (
    <SearchResultsView
      t={t}
      ask={ask}
      omni={omni}
      mode={mode}
      current={current}
      onOpen={onOpen}
      onFilter={(kinds) => onOpen(searchAddress(ask.query, kinds), { replace: true })}
      onRetry={omni.retry}
    />
  );
}

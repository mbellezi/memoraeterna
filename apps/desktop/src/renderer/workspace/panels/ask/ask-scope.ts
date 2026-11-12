import { formatObjectAddress, type AskScope as StoredAskScope } from "@app/domain";

import { questionAskTextLimits } from "../../../../shared/ipc-questions";
import { parseViewAddress, type AskScope as ViewAskScope } from "../../route";

/**
 * What an Ask is about, in the two forms it travels in: the view address's scope (any object
 * address, `memora://ask?scope=…`) and the stored scope `questions.ask` takes (the whole library, one
 * topic or chosen sources). Only a topic and a source can be asked about; any other object is
 * refused here, before `questions.ask` is called, so the panel never widens a scope without saying
 * so (the context panel's Ask tab maps a note, an entity or a question to a scope before it opens
 * one).
 */

export type ScopeRead =
  | {
      status: "ok";
      scope: StoredAskScope;
      /** The object to name in the scope line; null for the library. */
      object: string | null;
    }
  | { status: "unsupported" };

export function scopeOfView(scope: ViewAskScope | undefined): ScopeRead {
  if (scope === undefined) return { status: "ok", scope: { kind: "library" }, object: null };
  const object = formatObjectAddress({ kind: scope.kind, id: scope.id });
  if (scope.kind === "topic")
    return { status: "ok", scope: { kind: "topic", topicId: scope.id }, object };
  if (scope.kind === "source")
    return { status: "ok", scope: { kind: "sources", sourceIds: [scope.id] }, object };
  return { status: "unsupported" };
}

/** The object a stored scope names, for the scope line, or null for the library. */
export function objectOfScope(scope: StoredAskScope): string | null {
  if (scope.kind === "topic") return formatObjectAddress({ kind: "topic", id: scope.topicId });
  if (scope.kind === "sources" && scope.sourceIds.length === 1)
    return formatObjectAddress({ kind: "source", id: scope.sourceIds[0] as string });
  return null;
}

/**
 * An Ask as an address says it: the words that are asked at once (`text`), the words that only
 * fill the field (`draft`), and the scope.
 */
export interface AskRequest {
  text: string;
  draft: string;
  scope: ScopeRead;
}

export function readAskAddress(address: string): AskRequest | null {
  const view = parseViewAddress(address);
  if (!view || view.view !== "ask") return null;
  return { text: view.question ?? "", draft: view.draft ?? "", scope: scopeOfView(view.scope) };
}

/** Whether the words can be sent: 3 to 1000 characters once trimmed (`questions.ask`'s own bound). */
export function askTextState(text: string): "ok" | "short" | "long" {
  const length = text.trim().length;
  return length < questionAskTextLimits.min
    ? "short"
    : length > questionAskTextLimits.max
      ? "long"
      : "ok";
}

export { questionAskTextLimits };

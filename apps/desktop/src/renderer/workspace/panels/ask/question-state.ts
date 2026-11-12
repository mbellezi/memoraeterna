import { foundNothing, shownAnswer } from "./answer-model";
import type { QuestionSnapshot } from "./question-controller";

/**
 * What the panel's frame is told: the page's state in the four words of the contract. A Question
 * that is not there is empty, so is an Ask that found nothing in the library to rest on; an Ask
 * that failed is an error (its one quiet sentence is drawn in place, with the partial answer kept
 * under the title), and the frame, which says a failure once, draws no ribbon over it.
 */
export function questionState(
  snapshot: QuestionSnapshot
): "loading" | "empty" | "error" | "success" {
  const { load, stream } = snapshot;
  if (load.status === "loading") return "loading";
  if (load.status === "error") return "error";
  if (load.status === "missing") return "empty";
  const shown = shownAnswer(load.question, stream);
  if (foundNothing(shown)) return "empty";
  return shown.stage === "failed" ? "error" : "success";
}

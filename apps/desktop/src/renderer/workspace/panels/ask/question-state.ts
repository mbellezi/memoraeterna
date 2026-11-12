import { shownAnswer } from "./answer-model";
import type { QuestionSnapshot } from "./question-controller";

/**
 * What the panel's frame is told: the page's state in the four words of the contract. A Question
 * that is not there is empty, so is an answer that found nothing in the library to rest on; a
 * failed Ask still has its page (the failure is drawn in place, with the partial answer kept), so
 * the ribbon and the Question stay.
 */
export function questionState(
  snapshot: QuestionSnapshot
): "loading" | "empty" | "error" | "success" {
  const { load, stream } = snapshot;
  if (load.status === "loading") return "loading";
  if (load.status === "error") return "error";
  if (load.status === "missing") return "empty";
  const shown = shownAnswer(load.question, stream);
  return shown.stage === "done" && shown.paragraphs.length === 0 ? "empty" : "success";
}

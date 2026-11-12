/**
 * What this window remembers of the Asks it started, so a panel that comes back never asks twice:
 * `memora://ask?q=…` is an instruction ("ask this"), and Back can return to it after the Question
 * took its place. Memory only, per window: a reload forgets it, and a reload never restores an
 * `ask` panel, because the panel replaces itself with `memora://question/<id>` as soon as the
 * Question exists.
 */

const asked = new Map<string, string>();
const requests = new Map<string, string>();

/** The key of one Ask: its words and scope, exactly as the address wrote them. */
export const askKey = (address: string): string => address;

export function rememberAsked(key: string, questionId: string): void {
  asked.set(key, questionId);
}

/** The Question an `ask` address already made in this window, if any. */
export function askedQuestion(key: string): string | undefined {
  return asked.get(key);
}

/** The request that writes a Question's answer, as `questions.ask` and `askAgain` returned it. */
export function rememberRequest(questionId: string, requestId: string): void {
  requests.set(questionId, requestId);
}

export function requestOf(questionId: string): string | undefined {
  return requests.get(questionId);
}

/** For tests: forget everything. */
export function forgetAsks(): void {
  asked.clear();
  requests.clear();
}

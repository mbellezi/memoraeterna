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

/** One passage the Ask read and did not cite: where it is, and why it did not bear on the answer. */
export interface ReadNotCited {
  /** The passage's address (`memora://source/<id>#passage=<chunk>`). */
  address: string;
  /** The Ask's own words for leaving it out; absent, the page says it did not bear on the question. */
  reason?: string | undefined;
}

/** What the Ask's retrieval reported of what it read, for the sources list's "Lidas, não citadas". */
export interface ReadSummary {
  /** Every passage read, cited or not. */
  passages: number;
  /** The sources those passages sit in. */
  sources: number;
  notCited: readonly ReadNotCited[];
}

const reads = new Map<string, ReadSummary>();

/**
 * Keeps what the retrieval of a Question's Ask reported it had read. Nothing in the bus or in the
 * stored Question carries it yet (the data gap of the card report), so until the Ask reports it
 * the page says it is not kept; the page reads the same record once it exists.
 */
export function rememberRead(questionId: string, read: ReadSummary): void {
  reads.set(questionId, read);
}

export function readOf(questionId: string): ReadSummary | undefined {
  return reads.get(questionId);
}

/** For tests: forget everything. */
export function forgetAsks(): void {
  asked.clear();
  requests.clear();
  reads.clear();
}

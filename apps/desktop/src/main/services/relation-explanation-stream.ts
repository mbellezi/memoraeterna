import { relationExplanationLimits } from "@app/domain";

import {
  beginsWithSentinel,
  resolveRelationExplanationReferences,
  sentinelWordIndex,
  withoutLeadingMarks
} from "./relation-explanation.js";

// What a streamed explanation shows while it is written (F3 D22, C10). The text on screen is a
// preview of the answer that is validated at the end: the preview never shows the sentinel, a tag, a
// half-written note alias or more than the answer may have, and the validated text replaces it.

/** A tag the validator would refuse: nothing from its `<` on is shown. */
const tagStart = /<(?:\/|[A-Za-z]|$)/u;

/**
 * An alias that may still become one: a standalone `n`, `n1` or `n2`, or `n1.` / `n1-`, which a digit
 * would turn into content (`n1.5`). It is held until the next piece says which it is.
 */
const partialAlias = /(?<![\p{L}\p{N}_])n(?:[12][-.]?)?$/u;

/**
 * The start of the sentinel that the end of the text may be: `n`, `no`, `not`, `not_`, `not_r` ...
 * It is held until the next piece says whether the sentinel follows (a labelled answer such as
 * "Answer: NOT_RELATED" must not show the start of the sentinel before the end of it arrives).
 */
const partialSentinel =
  /(?<![\p{L}\p{N}_])n(?:o(?:t(?:[\s_-]+(?:r(?:e(?:l(?:a(?:t(?:e(?:d)?)?)?)?)?)?)?)?)?)?$/iu;

/** The text as the validator reads it: no leading space, every run of space one space. */
function normalized(raw: string): string {
  return raw.replace(/\s+/gu, " ").trimStart();
}

/**
 * The preview of one streamed answer. It takes the pieces the writer sends and says what may be
 * shown so far, with the note aliases already turned into the canonical references the stored text
 * has. Pieces arrive from one attempt; `restart` (a retried attempt) clears what came before.
 */
export class RelationExplanationStream {
  private raw = "";
  private shown: string | null = null;
  private everShown = false;

  public constructor(private readonly ids: { first: string; second: string }) {}

  /** Adds a piece of the answer. */
  public push(delta: string, restart = false): void {
    if (restart) this.clear();
    this.raw += delta;
  }

  /** Forgets the answer so far (a retried attempt, or an answer that was refused). */
  public clear(): void {
    this.raw = "";
    this.shown = null;
  }

  /**
   * The text that may be shown now. Null while nothing may be and nothing was shown; the empty text
   * when what was shown is void (the answer started again): the first characters of an answer (not
   * counting the marks it may begin with) are held until it is known whether the answer is the
   * sentinel, and an answer that begins with the sentinel is never shown; a sentinel further in
   * (a labelled answer) ends the preview where it begins. The text only grows, except through a
   * restart.
   */
  public visible(): string | null {
    const held = this.everShown ? "" : null;
    const text = normalized(this.raw);
    if (withoutLeadingMarks(text).length < relationExplanationLimits.sentinelHoldCharacters)
      return held;
    if (beginsWithSentinel(text)) return held;
    const tag = text.search(tagStart);
    const untagged = tag === -1 ? text : text.slice(0, tag);
    const word = sentinelWordIndex(untagged);
    const ahead = word === -1 ? untagged : untagged.slice(0, word);
    // A half-written alias or sentinel waits for its next piece, unless a tag or the sentinel
    // already ended the preview.
    const settled =
      tag === -1 && word === -1
        ? ahead.replace(partialAlias, "").replace(partialSentinel, "")
        : ahead;
    const limited = settled.slice(0, relationExplanationLimits.modelCharacters);
    const resolved = resolveRelationExplanationReferences(limited, this.ids);
    // References are longer than their aliases: past the stored bound the preview stops growing.
    if (resolved.length > relationExplanationLimits.storedCharacters) return this.shown ?? held;
    this.shown = resolved;
    if (resolved.length > 0) this.everShown = true;
    return resolved;
  }
}

export interface DeltaClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: DeltaClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/**
 * Sends the latest text at most once per window (50 ms): the first text leaves at once, so the first
 * delta is not delayed, and the newest text waits for the window to close. Each message carries the
 * whole text so far, so a skipped one loses nothing.
 */
export class DeltaCoalescer {
  private last: string | null = null;
  private pending: string | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private closed = false;

  public constructor(
    private readonly send: (text: string) => void,
    private readonly windowMs: number = relationExplanationLimits.streamCoalesceMs,
    private readonly clock: DeltaClock = systemClock
  ) {}

  public update(text: string): void {
    if (this.closed || (text === this.last && this.pending === null)) return;
    const wait = this.lastSentAt + this.windowMs - this.clock.now();
    if (this.timer === null && wait <= 0) {
      this.emit(text);
      return;
    }
    this.pending = text;
    this.timer ??= this.clock.setTimeout(
      () => {
        this.timer = null;
        this.flush();
      },
      Math.max(0, wait)
    );
  }

  /** Sends what is waiting now. */
  public flush(): void {
    if (this.closed) return;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    const text = this.pending;
    this.pending = null;
    if (text !== null && text !== this.last) this.emit(text);
  }

  /** Drops what is waiting: nothing leaves after the request ended. */
  public dispose(): void {
    this.closed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private emit(text: string): void {
    this.last = text;
    this.pending = null;
    this.lastSentAt = this.clock.now();
    this.send(text);
  }
}

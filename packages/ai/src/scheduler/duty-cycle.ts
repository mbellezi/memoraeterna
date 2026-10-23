/**
 * The local lane's duty cycle for background calls (F4 D15, spec 3.2): after a background call of
 * duration d, the next background call is admitted only d × (1/duty − 1) later, so background work
 * takes at most `duty` of the machine while the user is active. User and interactive calls never
 * wait for it. The duty is read when the hold is checked, so a user going idle (duty 1) ends a hold
 * at once.
 */
export class DutyCycleHold {
  private last: { endedAt: number; durationMs: number } | null = null;

  public constructor(private readonly duty: () => number) {}

  /** A background call ran for `durationMs` and ended at `endedAt` (scheduler clock). */
  public settled(endedAt: number, durationMs: number): void {
    this.last = { endedAt, durationMs: Math.max(0, durationMs) };
  }

  /** The time background entries are held until; at or before `now` when they are not held. */
  public heldUntil(): number {
    if (!this.last) return Number.NEGATIVE_INFINITY;
    return this.last.endedAt + dutyCycleWaitMs(this.last.durationMs, this.readDuty());
  }

  private readDuty(): number {
    try {
      return this.duty();
    } catch {
      return 1;
    }
  }
}

/**
 * The wait after a background call of `durationMs` at a duty of `duty`: d × (1/duty − 1). A duty
 * that is not a number in (0, 1] holds nothing, so a broken signal never stops background work.
 */
export function dutyCycleWaitMs(durationMs: number, duty: number): number {
  if (!Number.isFinite(duty) || duty <= 0 || duty >= 1) return 0;
  return Math.max(0, durationMs) * (1 / duty - 1);
}

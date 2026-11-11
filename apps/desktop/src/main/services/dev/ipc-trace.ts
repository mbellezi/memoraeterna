/**
 * F5 T137 (spec 3.14): the IPC trace of the journeys. An unpackaged build started with
 * `MEMORA_IPC_TRACE=1` records every `ipcMain.handle` invocation as `{ channel, at }` in a ring of
 * the last {@link ipcTraceCapacity} entries kept on `globalThis`, where a journey reads it with
 * `electronApp.evaluate` (`e2e/support/ipc-trace.ts`). J-idle (T154) proves with it that an idle
 * window invokes nothing that a bus event or a gesture did not cause.
 *
 * It must wrap `ipcMain.handle` before any handler registers (T171 calls it first in
 * `M/index.ts`). It records the channel and the time only: never an argument or a result. A
 * packaged build, or any other value of the knob, installs nothing.
 */

export const ipcTraceKnob = "MEMORA_IPC_TRACE";
/** How many invocations the ring keeps; the oldest goes first. */
export const ipcTraceCapacity = 10_000;
/** The `globalThis` property a journey reads (`electronApp.evaluate`). */
export const ipcTraceGlobalKey = "__memoraIpcTrace";

export interface IpcTraceEntry {
  readonly channel: string;
  /** `Date.now()` when the invocation reached main (the renderer shares the clock). */
  readonly at: number;
}

/** A fixed-size ring: `entries()` answers oldest first; `dropped` counts what fell out. */
export class IpcTraceRing {
  private readonly slots: (IpcTraceEntry | undefined)[];
  private next = 0;
  private count = 0;
  private overwritten = 0;

  public constructor(public readonly capacity: number = ipcTraceCapacity) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0)
      throw new Error("The IPC trace capacity must be a positive whole number");
    this.slots = new Array<IpcTraceEntry | undefined>(capacity);
  }

  public record(channel: string, at: number): void {
    if (this.count === this.capacity) this.overwritten += 1;
    else this.count += 1;
    this.slots[this.next] = { channel, at };
    this.next = (this.next + 1) % this.capacity;
  }

  public entries(): IpcTraceEntry[] {
    const start = (this.next - this.count + this.capacity) % this.capacity;
    const out: IpcTraceEntry[] = [];
    for (let index = 0; index < this.count; index += 1) {
      const entry = this.slots[(start + index) % this.capacity];
      if (entry) out.push(entry);
    }
    return out;
  }

  public clear(): void {
    this.slots.fill(undefined);
    this.next = 0;
    this.count = 0;
    this.overwritten = 0;
  }

  public get size(): number {
    return this.count;
  }

  public get dropped(): number {
    return this.overwritten;
  }
}

// The part of `ipcMain` the trace wraps, so a test needs no Electron.
type Handler = (event: unknown, ...args: unknown[]) => unknown;
export interface IpcTraceTarget {
  handle(channel: string, listener: Handler): void;
  handleOnce?(channel: string, listener: Handler): void;
}

const installed = Symbol.for("memora.ipcTrace.installed");

export interface IpcTraceOptions {
  /** `app.isPackaged`: a packaged build never traces. */
  isPackaged: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  /** Where the ring is published; `globalThis` in the app. */
  scope?: Record<string, unknown>;
  capacity?: number;
}

/**
 * Wraps `handle` (and `handleOnce`) of `target` so every invocation is recorded before its
 * handler runs. Returns the ring, or null when tracing is off. Installing twice returns the
 * first ring and wraps nothing again.
 */
export function installIpcTrace(
  target: IpcTraceTarget,
  options: IpcTraceOptions
): IpcTraceRing | null {
  const env = options.env ?? process.env;
  if (options.isPackaged || env[ipcTraceKnob]?.trim() !== "1") return null;
  const marked = target as IpcTraceTarget & { [installed]?: IpcTraceRing };
  const existing = marked[installed];
  if (existing) return existing;
  const ring = new IpcTraceRing(options.capacity);
  const now = options.now ?? Date.now;
  const traced =
    (channel: string, listener: Handler): Handler =>
    (event, ...args) => {
      ring.record(channel, now());
      return listener(event, ...args);
    };
  const handle = target.handle.bind(target);
  target.handle = (channel, listener) => handle(channel, traced(channel, listener));
  if (target.handleOnce) {
    const handleOnce = target.handleOnce.bind(target);
    target.handleOnce = (channel, listener) => handleOnce(channel, traced(channel, listener));
  }
  marked[installed] = ring;
  (options.scope ?? (globalThis as Record<string, unknown>))[ipcTraceGlobalKey] = ring;
  return ring;
}

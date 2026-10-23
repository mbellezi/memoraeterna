import { defaultGardenerConfig, type GardenerConfig } from "@app/domain";

/** What `PowerSignals` reads of Electron's `powerMonitor` (injected, so tests need no Electron). */
export interface PowerSource {
  /** Seconds since the last user input, system-wide. */
  getSystemIdleTime(): number;
  isOnBatteryPower(): boolean;
  on(event: PowerSourceEvent, listener: () => void): unknown;
  removeListener(event: PowerSourceEvent, listener: () => void): unknown;
}

/** The `powerMonitor` events after which the signals are read again at once. */
export const powerSourceEvents = [
  "on-ac",
  "on-battery",
  "resume",
  "unlock-screen",
  "user-did-become-active",
  "user-did-resign-active"
] as const;
export type PowerSourceEvent = (typeof powerSourceEvents)[number];

/** What the policy reads of the machine (F4 D15). */
export interface PowerSnapshot {
  /** The user used the machine in the last `activeIdleBelowMs` (60 s). */
  readonly active: boolean;
  readonly onBattery: boolean;
  /** Milliseconds since the last user input. */
  readonly idleMs: number;
  /** A DEV override block decided the reading (the soak), not the machine. */
  readonly overridden: boolean;
}

/** One block of the DEV power override: a reading, or `real` for the machine's own. */
export type DevPowerBlock = { readonly active: boolean; readonly onBattery: boolean } | "real";

/**
 * The DEV power override (soak knob only, spec 5.4): blocks of `devOverrideBlockMs` (10 min) from
 * `startedAt`, repeated, each an activity and power reading the policy takes as the machine's.
 */
export interface DevPowerOverride {
  readonly startedAt: number;
  readonly blocks: readonly DevPowerBlock[];
}

/** The environment variable of the override in an unpackaged build: `idle,active,battery,real`. */
export const devPowerBlocksKnob = "MEMORA_DEV_POWER_BLOCKS";

const blockWords: Readonly<Record<string, DevPowerBlock>> = {
  idle: { active: false, onBattery: false },
  active: { active: true, onBattery: false },
  battery: { active: false, onBattery: true },
  "battery-active": { active: true, onBattery: true },
  real: "real"
};

/** Parses `idle,active,battery,battery-active,real` (one word per block); null for no blocks. */
export function parseDevPowerBlocks(text: string | undefined): DevPowerBlock[] | null {
  const words = (text ?? "")
    .split(",")
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  if (words.length === 0) return null;
  return words.map((word) => {
    const block = blockWords[word];
    if (!block) throw new Error(`${devPowerBlocksKnob}: unknown block "${word}"`);
    return block;
  });
}

/** The override a DEV run asks for in its environment; none in a packaged build. */
export function readDevPowerOverride(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean; now: number }
): DevPowerOverride | null {
  if (options.isPackaged) return null;
  const blocks = parseDevPowerBlocks(env[devPowerBlocksKnob]);
  return blocks ? { startedAt: options.now, blocks } : null;
}

export interface PowerSignalsOptions {
  /** Electron's `powerMonitor`; null where none exists (scripts, tests without one): never idle, on AC. */
  source: PowerSource | null;
  isPackaged: boolean;
  config?: GardenerConfig;
  /** Wall clock in milliseconds. */
  now?: () => number;
  override?: DevPowerOverride | null;
  timers?: {
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
  logger?: Pick<Console, "warn">;
}

const systemTimers = {
  setInterval: (callback: () => void, ms: number) => {
    const handle = setInterval(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>)
};

/**
 * The machine's activity and power source for the background policy (F4 D15): Electron
 * `powerMonitor` read every `pollMs` and after its events, published as {active, onBattery} when
 * either changes or "only idle"'s threshold is crossed. Background calls on the local lane keep a
 * duty cycle of 50% while the user is active and 100% when idle.
 */
export class PowerSignals {
  private readonly config: GardenerConfig;
  private readonly now: () => number;
  private readonly timers: NonNullable<PowerSignalsOptions["timers"]>;
  private override: DevPowerOverride | null;
  private reading: PowerSnapshot;
  private timer: unknown = undefined;
  private readonly listeners = new Set<
    (snapshot: PowerSnapshot, previous: PowerSnapshot) => void
  >();
  private readonly onSourceEvent = () => this.poll();

  public constructor(private readonly options: PowerSignalsOptions) {
    this.config = options.config ?? defaultGardenerConfig;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? systemTimers;
    this.override = options.isPackaged ? null : (options.override ?? null);
    this.reading = this.read();
  }

  /** Listens to the source's events and reads it every `pollMs`. */
  public start(): void {
    if (this.timer !== undefined) return;
    for (const event of powerSourceEvents) this.options.source?.on(event, this.onSourceEvent);
    this.timer = this.timers.setInterval(() => this.poll(), this.config.power.pollMs);
    this.poll();
  }

  public stop(): void {
    if (this.timer === undefined) return;
    this.timers.clearInterval(this.timer);
    this.timer = undefined;
    for (const event of powerSourceEvents)
      this.options.source?.removeListener(event, this.onSourceEvent);
  }

  /** The last reading; never touches the source. */
  public snapshot(): PowerSnapshot {
    return this.reading;
  }

  /** The share of the local lane background calls may take now (D15). */
  public dutyCycle(): number {
    return this.reading.active ? this.config.dutyCycle.active : this.config.dutyCycle.idle;
  }

  /** Whether "only idle" lets background work run: idle for at least `onlyIdleAfterMs` (5 min). */
  public idleLongEnough(): boolean {
    return this.reading.idleMs >= this.config.power.onlyIdleAfterMs;
  }

  public subscribe(
    listener: (snapshot: PowerSnapshot, previous: PowerSnapshot) => void
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Sets or lifts the DEV override at run time (the soak driver's windows). Refused in a packaged
   * build: a person's app always reads its own machine.
   */
  public setDevOverride(override: DevPowerOverride | null): void {
    if (this.options.isPackaged) throw new Error("power_override_refused_packaged");
    this.override = override;
    this.poll();
  }

  /** Reads the source (or the override) and tells the listeners when what the policy uses moved. */
  public poll(): PowerSnapshot {
    const previous = this.reading;
    let next: PowerSnapshot;
    try {
      next = this.read();
    } catch (error) {
      this.options.logger?.warn("The power signals could not be read", error);
      return previous;
    }
    this.reading = next;
    if (
      next.active !== previous.active ||
      next.onBattery !== previous.onBattery ||
      next.overridden !== previous.overridden ||
      this.crossedOnlyIdle(previous, next)
    )
      for (const listener of this.listeners)
        try {
          listener(next, previous);
        } catch (error) {
          this.options.logger?.warn("A power signals listener failed", error);
        }
    return next;
  }

  private crossedOnlyIdle(previous: PowerSnapshot, next: PowerSnapshot): boolean {
    const threshold = this.config.power.onlyIdleAfterMs;
    return previous.idleMs >= threshold !== next.idleMs >= threshold;
  }

  private read(): PowerSnapshot {
    const block = this.overrideBlock();
    if (block) {
      // An idle block reads as idle for longer than "only idle" asks, from the block's start.
      const idleMs = block.active
        ? 0
        : this.config.power.onlyIdleAfterMs + Math.max(0, this.now() - block.startedAt);
      return { active: block.active, onBattery: block.onBattery, idleMs, overridden: true };
    }
    const source = this.options.source;
    if (!source)
      return {
        active: false,
        onBattery: false,
        idleMs: Number.MAX_SAFE_INTEGER,
        overridden: false
      };
    const idleMs = Math.max(0, source.getSystemIdleTime()) * 1_000;
    return {
      active: idleMs < this.config.power.activeIdleBelowMs,
      onBattery: source.isOnBatteryPower(),
      idleMs,
      overridden: false
    };
  }

  private overrideBlock(): { active: boolean; onBattery: boolean; startedAt: number } | null {
    const override = this.override;
    if (!override || override.blocks.length === 0) return null;
    const blockMs = this.config.power.devOverrideBlockMs;
    const elapsed = Math.max(0, this.now() - override.startedAt);
    const index = Math.floor(elapsed / blockMs);
    const block = override.blocks[index % override.blocks.length]!;
    if (block === "real") return null;
    return { ...block, startedAt: override.startedAt + index * blockMs };
  }
}

// The IPC side of the zero-config end-to-end test (F2 T32). The product's own handlers are
// registered on a recording `ipcMain`; the harness plays the renderer and reaches the product only
// through `invoke`, so every call is counted per channel and per phase. E6 asserts that no handler
// of a Settings channel ran after the first-run configuration: the user never opens Settings.
import type { IpcMain } from "electron";

import { ipcChannels } from "../../../shared/ipc.js";

export type ChannelClass = "settings" | "product";

/** Channel families that belong to the Settings screens (AI, local models, prompts, vault, ...). */
const settingsPrefixes = [
  "app:settings:",
  "app:ai:",
  "app:local-models:",
  "app:prompts:",
  "app:integration:",
  "app:backup:",
  "app:obsidian:"
] as const;
/** Single channels of Settings: the destructive library reset lives there. */
const settingsChannels: ReadonlySet<string> = new Set([ipcChannels.libraryReset]);

/** Whether a channel is one a user only reaches by opening Settings. */
export function channelClass(channel: string): ChannelClass {
  return settingsChannels.has(channel) ||
    settingsPrefixes.some((prefix) => channel.startsWith(prefix))
    ? "settings"
    : "product";
}

/** Every request/response channel of the product (push channels never have a handler). */
export function allChannels(): string[] {
  return Object.values(ipcChannels).sort();
}

type Listener = (event: unknown, ...args: unknown[]) => unknown;

export interface FakeEvent {
  sender: { isDestroyed(): boolean; send(channel: string, payload?: unknown): void };
}

export interface ChannelCount {
  channel: string;
  class: ChannelClass;
  calls: number;
}

export interface IpcSummary {
  /** Handlers registered on the recording `ipcMain`, by class. */
  registered: { settings: number; product: number };
  /** Calls per phase, Settings channels first. */
  phases: Record<string, ChannelCount[]>;
}

export class RecordingIpc {
  public readonly main: IpcMain;
  private readonly handlers = new Map<string, Listener>();
  private readonly counts = new Map<string, Map<string, number>>();
  private current = "setup";

  public constructor() {
    const noop = (): void => undefined;
    const handle = (channel: string, listener: Listener): void => {
      if (this.handlers.has(channel)) throw new Error(`Second handler for ${channel}`);
      this.handlers.set(channel, listener);
    };
    this.main = {
      handle,
      handleOnce: handle,
      removeHandler: (channel: string) => void this.handlers.delete(channel),
      on: noop,
      once: noop,
      off: noop,
      removeListener: noop,
      removeAllListeners: noop
    } as unknown as IpcMain;
  }

  /** Starts counting into a phase: `setup` is the first-run configuration, `user` is the import. */
  public phase(name: string): void {
    this.current = name;
  }

  public registered(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /** The renderer's call: counts first, so even a failing handler is counted. */
  public async invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    const phase = this.counts.get(this.current) ?? new Map<string, number>();
    this.counts.set(this.current, phase);
    phase.set(channel, (phase.get(channel) ?? 0) + 1);
    const event: FakeEvent = { sender: { isDestroyed: () => false, send: () => undefined } };
    return (await handler(event, payload)) as T;
  }

  public calls(phase: string, klass?: ChannelClass): number {
    let total = 0;
    for (const [channel, count] of this.counts.get(phase) ?? [])
      if (klass === undefined || channelClass(channel) === klass) total += count;
    return total;
  }

  public summary(): IpcSummary {
    const registered = this.registered();
    const phases: Record<string, ChannelCount[]> = {};
    for (const [phase, counts] of this.counts) {
      phases[phase] = [...counts]
        .map(([channel, calls]) => ({ channel, class: channelClass(channel), calls }))
        .sort(
          (left, right) =>
            Number(left.class === "product") - Number(right.class === "product") ||
            left.channel.localeCompare(right.channel)
        );
    }
    return {
      registered: {
        settings: registered.filter((channel) => channelClass(channel) === "settings").length,
        product: registered.filter((channel) => channelClass(channel) === "product").length
      },
      phases
    };
  }
}

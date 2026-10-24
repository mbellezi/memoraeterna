// A recording `ipcMain` that keeps the order of the calls (F4 T90): the sequence check reads it.
import { RecordingIpc } from "../topics-e2e/ipc-counters.js";

export interface IpcCall {
  phase: string;
  channel: string;
}

/** A recording `ipcMain` that also keeps the order of the calls, which the sequence check reads. */
export class SequencedIpc extends RecordingIpc {
  public readonly log: IpcCall[] = [];
  private currentPhase = "setup";

  public override phase(name: string): void {
    this.currentPhase = name;
    super.phase(name);
  }

  public override async invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
    this.log.push({ phase: this.currentPhase, channel });
    return super.invoke<T>(channel, payload);
  }

  /** The channels of one phase, in the order they were called. */
  public channels(phase: string): string[] {
    return this.log.filter((call) => call.phase === phase).map((call) => call.channel);
  }
}

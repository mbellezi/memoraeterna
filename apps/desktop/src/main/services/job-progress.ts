// `job.progress` (F4 D26): when `JobSupervisor.notify` says a job changed, one read of the job
// counts and of the jobs touched since the last read becomes one event on the bus. The supervisor
// notifies on every state change, often in bursts, so a read waits a short window after the first
// notice and a notice during a read asks for exactly one more: the database sees at most one
// read per window, however many jobs move.
import { createJobActivityRepository, type JobActivity, type PgPool } from "@app/db";

import type { JobProgressEvent } from "../../shared/app-events.js";

/** How long after the first notice the read happens. */
export const jobProgressReadWindowMs = 250;

export interface JobProgressPublisherOptions {
  /** Reads the activity since the cursor of the previous read; null while the database is not ready. */
  read: (since: string | null) => Promise<JobActivity | null>;
  publish: (event: JobProgressEvent) => void;
  windowMs?: number;
  /** A read that failed; the next notice reads again from the same cursor. */
  onError?: (error: unknown) => void;
}

export function jobProgressEventOf(activity: JobActivity): JobProgressEvent {
  return {
    type: "job.progress",
    lanes: { heavy: activity.counts.heavy, light: activity.counts.light },
    changedIds: activity.changedIds,
    changedIdsTruncated: activity.changedIdsTruncated
  };
}

export class JobProgressPublisher {
  private cursor: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reading = false;
  private again = false;
  private disposed = false;

  public constructor(private readonly options: JobProgressPublisherOptions) {}

  /** A job changed: read once, soon. Safe to call as often as the supervisor notifies. */
  public touch(): void {
    if (this.disposed) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(
      () => void this.run(),
      this.options.windowMs ?? jobProgressReadWindowMs
    );
    this.timer.unref?.();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    this.timer = null;
    this.reading = true;
    try {
      const activity = await this.options.read(this.cursor);
      if (activity && !this.disposed) {
        this.cursor = activity.cursor;
        this.options.publish(jobProgressEventOf(activity));
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.reading = false;
      if (this.again) {
        this.again = false;
        this.touch();
      }
    }
  }
}

/**
 * Wires the supervisor's notices to the bus: every state change it announces becomes one coalesced
 * read of the job counts, published as `job.progress`. The supervisor stays unaware of the bus.
 */
export function connectJobProgress(options: {
  supervisor: { subscribe(listener: () => void): () => void };
  getPool: () => PgPool | null;
  publish: (event: JobProgressEvent) => void;
  onError?: (error: unknown) => void;
  windowMs?: number;
}): JobProgressPublisher {
  const publisher = new JobProgressPublisher({
    read: async (since) => {
      const pool = options.getPool();
      return pool ? createJobActivityRepository(pool).read({ since }) : null;
    },
    publish: options.publish,
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.windowMs !== undefined ? { windowMs: options.windowMs } : {})
  });
  options.supervisor.subscribe(() => publisher.touch());
  return publisher;
}

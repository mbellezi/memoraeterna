import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobActivity } from "@app/db";

import { AppEventSchema, type JobProgressEvent } from "../../shared/app-events.js";
import {
  jobProgressEventOf,
  JobProgressPublisher,
  jobProgressReadWindowMs
} from "./job-progress.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const zero = { queued: 0, blocked: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };

const activity = (cursor: string, overrides: Partial<JobActivity> = {}): JobActivity => ({
  counts: { heavy: { ...zero, running: 1 }, light: { ...zero, queued: 12 } },
  changedIds: [],
  changedIdsTruncated: false,
  cursor,
  ...overrides
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function newPublisher(read: (since: string | null) => Promise<JobActivity | null>) {
  const published: JobProgressEvent[] = [];
  const onError = vi.fn();
  const publisher = new JobProgressPublisher({
    read,
    publish: (event) => published.push(event),
    onError
  });
  return { publisher, published, onError };
}

describe("job.progress from the supervisor's notices", () => {
  it("maps an activity read to a valid event", () => {
    const event = jobProgressEventOf(
      activity("c1", { changedIds: [id(1)], changedIdsTruncated: true })
    );

    expect(AppEventSchema.safeParse(event).success).toBe(true);
    expect(event).toEqual({
      type: "job.progress",
      lanes: { heavy: { ...zero, running: 1 }, light: { ...zero, queued: 12 } },
      changedIds: [id(1)],
      changedIdsTruncated: true
    });
  });

  it("reads once, a window after the first of many notices", async () => {
    const read = vi.fn(async () => activity("c1"));
    const { publisher, published } = newPublisher(read);

    for (let n = 0; n < 40; n += 1) publisher.touch();
    await vi.advanceTimersByTimeAsync(jobProgressReadWindowMs - 1);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(read).toHaveBeenCalledTimes(1);
    expect(published).toHaveLength(1);
  });

  it("passes the cursor of the previous read, so only later changes are named", async () => {
    const read = vi
      .fn<(since: string | null) => Promise<JobActivity | null>>()
      .mockResolvedValueOnce(activity("c1"))
      .mockResolvedValueOnce(activity("c2", { changedIds: [id(7)] }));
    const { publisher, published } = newPublisher(read);

    publisher.touch();
    await vi.advanceTimersByTimeAsync(jobProgressReadWindowMs);
    publisher.touch();
    await vi.advanceTimersByTimeAsync(jobProgressReadWindowMs);

    expect(read.mock.calls.map(([since]) => since)).toEqual([null, "c1"]);
    expect(published.map((event) => event.changedIds)).toEqual([[], [id(7)]]);
  });

  it("asks for exactly one more read when a notice arrives during a read", async () => {
    let finish: (value: JobActivity) => void = () => undefined;
    const read = vi
      .fn<(since: string | null) => Promise<JobActivity | null>>()
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockResolvedValue(activity("c2"));
    const { publisher, published } = newPublisher(read);

    publisher.touch();
    await vi.advanceTimersByTimeAsync(jobProgressReadWindowMs);
    expect(read).toHaveBeenCalledTimes(1);
    publisher.touch();
    publisher.touch();
    publisher.touch();
    finish(activity("c1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(jobProgressReadWindowMs);

    expect(read).toHaveBeenCalledTimes(2);
    expect(published).toHaveLength(2);
  });

  it("publishes nothing while the database is not ready, and reads again at the next notice", async () => {
    const read = vi
      .fn<(since: string | null) => Promise<JobActivity | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(activity("c1"));
    const { publisher, published } = newPublisher(read);

    publisher.touch();
    await vi.advanceTimersByTimeAsync(jobProgressReadWindowMs);
    expect(published).toHaveLength(0);
    publisher.touch();
    await vi.advanceTimersByTimeAsync(jobProgressReadWindowMs);

    expect(published).toHaveLength(1);
    expect(read.mock.calls.map(([since]) => since)).toEqual([null, null]);
  });

  it("reports a failed read, keeps its cursor and recovers at the next notice", async () => {
    const read = vi
      .fn<(since: string | null) => Promise<JobActivity | null>>()
      .mockResolvedValueOnce(activity("c1"))
      .mockRejectedValueOnce(new Error("pool closed"))
      .mockResolvedValueOnce(activity("c3"));
    const { publisher, published, onError } = newPublisher(read);

    for (let n = 0; n < 3; n += 1) {
      publisher.touch();
      await vi.advanceTimersByTimeAsync(jobProgressReadWindowMs);
    }

    expect(onError).toHaveBeenCalledTimes(1);
    expect(published).toHaveLength(2);
    expect(read.mock.calls.map(([since]) => since)).toEqual([null, "c1", "c1"]);
  });

  it("stops reading once disposed", async () => {
    const read = vi.fn(async () => activity("c1"));
    const { publisher, published } = newPublisher(read);

    publisher.touch();
    publisher.dispose();
    publisher.touch();
    await vi.advanceTimersByTimeAsync(jobProgressReadWindowMs * 4);

    expect(read).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });
});

import { useCallback, useEffect, useState } from "react";

import type { AppEventOf } from "../../../shared/app-events";
import type { JobRecord } from "../../../shared/ipc";
import type { MonitoringPage } from "../../../shared/monitoring";
import { readOnEvents } from "../../lib/status-followers";
import { callPageSize, type CallFilter, type PageRead } from "./call-log-model";

/**
 * The reads of the two Diagnostics pages: the AI call log (`monitoring.list`, read again on each
 * `monitoring.changed`) and the job history (`jobs.list`, read again when a job finished). Both read
 * only while `active` (the page is open), never on a timer. A read that failed after one succeeded
 * leaves the rows that were shown; the first read that fails is the page's error, with a retry.
 */

export interface CallLogState {
  /** What was read for the filter now chosen: after a change of filter it is loading until that read answers. */
  read: PageRead<MonitoringPage>;
  /** The filter changed and its rows are on their way: the page keeps its chips and shows rows to come. */
  switching: boolean;
  filter: CallFilter;
  limit: number;
  setFilter: (filter: CallFilter) => void;
  showMore: (limit: number) => void;
  retry: () => void;
  /** Reads again now (after a deletion). */
  refresh: () => void;
}

export function useCallLog(active: boolean): CallLogState {
  // The value is tagged with the filter it answers: rows read for another filter are not this one's.
  const [stored, setRead] = useState<
    PageRead<MonitoringPage> | { status: "ready"; value: MonitoringPage; filter: CallFilter }
  >({ status: "loading" });
  const [filter, setFilterState] = useState<CallFilter>("all");
  const [limit, setLimit] = useState(callPageSize);
  const [token, setToken] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    const reading = readOnEvents<MonitoringPage>({
      api: () => window.app,
      sources: [{ type: "monitoring.changed" }],
      read: () =>
        window.app.monitoring.list({
          view: "ai",
          kind: "all",
          status: filter === "failed" ? "failed" : "all",
          search: "",
          limit,
          offset: 0
        }),
      onValue: (value) => setRead({ status: "ready", value, filter }),
      // Rows that were shown for this filter stay when a later read fails; any other failure is the page's.
      onError: () =>
        setRead((current) =>
          current.status === "ready" && "filter" in current && current.filter === filter
            ? current
            : { status: "error" }
        )
    });
    return () => reading.stop();
  }, [active, filter, limit, token]);

  const answersFilter = stored.status === "ready" && "filter" in stored && stored.filter === filter;
  const read: PageRead<MonitoringPage> =
    stored.status === "ready"
      ? answersFilter
        ? { status: "ready", value: stored.value }
        : { status: "loading" }
      : stored;
  const switching = stored.status === "ready" && !answersFilter;

  const setFilter = useCallback((next: CallFilter) => {
    setFilterState(next);
    setLimit(callPageSize);
    // A failure of the other filter's read is not this one's.
    setRead((current) => (current.status === "error" ? { status: "loading" } : current));
  }, []);
  const retry = useCallback(() => {
    setRead({ status: "loading" });
    setToken((value) => value + 1);
  }, []);
  const refresh = useCallback(() => setToken((value) => value + 1), []);
  return { read, switching, filter, limit, setFilter, showMore: setLimit, retry, refresh };
}

export interface TaskHistoryState {
  read: PageRead<JobRecord[]>;
  retry: () => void;
  refresh: () => void;
}

const finishedTotal = (event: AppEventOf<"job.progress">): number =>
  [event.lanes.heavy, event.lanes.light].reduce(
    (sum, lane) => sum + lane.succeeded + lane.failed + lane.canceled,
    0
  );

export function useTaskHistory(active: boolean): TaskHistoryState {
  const [read, setRead] = useState<PageRead<JobRecord[]>>({ status: "loading" });
  const [token, setToken] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    // `job.progress` arrives while work runs; only a change of the finished total changes the history.
    // The first event has nothing to be compared with (it carries every run that finished since the
    // page opened, and is never replayed), so it reads again.
    let seen: number | null = null;
    const reading = readOnEvents<JobRecord[]>({
      api: () => window.app,
      sources: [
        {
          type: "job.progress",
          when: (event) => {
            const total = finishedTotal(event);
            const changed = seen === null || total !== seen;
            seen = total;
            return changed;
          }
        }
      ],
      read: () => window.app.jobs.list(),
      onValue: (value) => setRead({ status: "ready", value }),
      onError: () =>
        setRead((current) => (current.status === "ready" ? current : { status: "error" }))
    });
    return () => reading.stop();
  }, [active, token]);

  const retry = useCallback(() => {
    setRead({ status: "loading" });
    setToken((value) => value + 1);
  }, []);
  const refresh = useCallback(() => setToken((value) => value + 1), []);
  return { read, retry, refresh };
}

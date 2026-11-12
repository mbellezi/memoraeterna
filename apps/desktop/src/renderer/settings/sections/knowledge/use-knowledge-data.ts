import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { BudgetSnapshot, GardenerStatusSnapshot, KnowledgeControlsUpdate } from "@app/domain";

import type { JobRecord } from "../../../../shared/ipc";
import {
  createKnowledgeControlsSaver,
  initialKnowledgeControlsState,
  knowledgeControlsReducer,
  readKnowledgeControls,
  type KnowledgeControlsState
} from "../../../components/settings/knowledge-controls-state";
import { readOnEvents } from "../../../lib/status-followers";
import { useSettings } from "../../settings-context";

/**
 * What Settings › Knowledge reads and writes (F5 T164): the six controls (read once, again after a
 * change from elsewhere such as a reset, saved in the order they were made), the month's spend, the
 * Gardener's status, the relation descriptions' job and the language of the notes. Everything
 * arrives by `window.app` and the bus; there is no timer. Settings stays mounted while another place is
 * shown: a hidden Settings listens to nothing, and each hook reads once more when it is shown again
 * (the `active` of the Settings context).
 */

export interface KnowledgeControlsHandle {
  state: KnowledgeControlsState;
  edit: (change: KnowledgeControlsUpdate) => void;
  retry: () => void;
}

export function useKnowledgeControls(): KnowledgeControlsHandle {
  const [state, dispatch] = useReducer(knowledgeControlsReducer, initialKnowledgeControlsState);
  const [save] = useState(() =>
    createKnowledgeControlsSaver((change) => window.app.knowledgeControls.update(change), dispatch)
  );
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);

  const { active } = useSettings();
  const loading = state.phase === "loading";
  useEffect(() => {
    if (!loading || !active) return undefined;
    let live = true;
    void readKnowledgeControls(() => window.app.knowledgeControls.get()).then((action) => {
      if (live) dispatch(action);
    });
    return () => {
      live = false;
    };
  }, [loading, active]);

  // Shown again after another place: the controls are read once more. What is on screen stays when
  // that read fails, and a change of ours still being saved is not read over.
  const returning = useRef(false);
  useEffect(() => {
    if (!active) {
      returning.current = true;
      return undefined;
    }
    if (!returning.current) return undefined;
    returning.current = false;
    if (latest.current.phase === "loading") return undefined; // the read above is the fresh one
    let live = true;
    void readKnowledgeControls(() => window.app.knowledgeControls.get()).then((action) => {
      if (!live) return;
      const current = latest.current;
      if (current.phase === "ready" && (action.type !== "loaded" || current.saving > 0)) return;
      dispatch(action);
    });
    return () => {
      live = false;
    };
  }, [active]);

  // A change that did not come from here (a reset, another window) is read again, unless one of
  // ours is still being saved: its answer will say where things stand.
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    const stop = window.app.onAppEvent("settings.changed", (event) => {
      if (!event.stores.includes("knowledge.controls")) return;
      const current = latest.current;
      if (current.phase === "ready" && current.saving > 0) return;
      void readKnowledgeControls(() => window.app.knowledgeControls.get()).then((action) => {
        if (live && action.type === "loaded") dispatch(action);
      });
    });
    return () => {
      live = false;
      stop();
    };
  }, [active]);

  return {
    state,
    edit: (change) => void save(change),
    retry: () => dispatch({ type: "retry" })
  };
}

/** The month's remote spend against the cap; null while unknown (it is a help, not a control). */
export function useSpend(): BudgetSnapshot["money"] | null {
  const [money, setMoney] = useState<BudgetSnapshot["money"] | null>(null);
  const { active } = useSettings();
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    let newer = false;
    window.app.budget
      .snapshot()
      .then((snapshot) => {
        if (live && !newer) setMoney(snapshot.money);
      })
      .catch(() => undefined);
    const stop = window.app.onAppEvent("budget.changed", (event) => {
      newer = true;
      if (live) setMoney(event.budget.money);
    });
    return () => {
      live = false;
      stop();
    };
  }, [active]);
  return money;
}

/** The Gardener's status now and as it changes; null until known or when it cannot be read. */
export function useGardenerStatus(): GardenerStatusSnapshot | null {
  const [status, setStatus] = useState<GardenerStatusSnapshot | null>(null);
  const { active } = useSettings();
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    let newer = false;
    window.app.gardener
      .status()
      .then((snapshot) => {
        // An event that arrived while the read was out is newer than what was read.
        if (live && !newer) setStatus(snapshot);
      })
      .catch(() => undefined);
    const stop = window.app.onAppEvent("gardener.status", (event) => {
      newer = true;
      if (live) setStatus(event.status);
    });
    return () => {
      live = false;
      stop();
    };
  }, [active]);
  return status;
}

export interface RelationLabelsHandle {
  job: JobRecord | null;
  /** Reading for the first time. */
  loading: boolean;
  /** The last read failed. */
  readFailed: boolean;
  /** A start, a cancel or a retry that failed, until the next one. */
  actionFailed: boolean;
  busy: boolean;
  act: (work: () => Promise<unknown>) => Promise<void>;
  reload: () => void;
}

/** The relation descriptions' job: read once and after each `job.progress`, never on a timer. */
export function useRelationLabels(): RelationLabelsHandle {
  const [job, setJob] = useState<JobRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const { active } = useSettings();
  useEffect(() => {
    if (!active) return undefined;
    const follower = readOnEvents({
      api: () => window.app,
      sources: [{ type: "job.progress" }],
      read: () => window.app.knowledge.relationLabelsStatus(),
      onValue: (value) => {
        setJob(value);
        setLoading(false);
        setReadFailed(false);
      },
      onError: () => {
        setLoading(false);
        setReadFailed(true);
      }
    });
    return () => follower.stop();
  }, [active, round]);
  const act = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    setActionFailed(false);
    try {
      await work();
      setJob(await window.app.knowledge.relationLabelsStatus());
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);
  return {
    job,
    loading,
    readFailed,
    actionFailed,
    busy,
    act,
    reload: () => {
      setLoading(true);
      setRound((value) => value + 1);
    }
  };
}

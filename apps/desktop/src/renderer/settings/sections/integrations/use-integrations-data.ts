import { useCallback, useEffect, useState } from "react";
import type { ObsidianLayoutConfig, ObsidianLayoutStatus } from "@app/integration-contracts";

import type {
  DesktopApi,
  IntegrationClient,
  IntegrationGatewayStatus,
  ObsidianSyncStatus,
  StorageSettings
} from "../../../../shared/ipc";
import {
  followEditorialConflicts,
  followLayout,
  followWikiStatus
} from "../../../components/obsidian-followers";
import { readOnEvents, settingsTouch, watchObsidianSync } from "../../../lib/status-followers";

/**
 * What Settings › Integrations reads (F5 T164, D16): each status is read once and again after the
 * bus event that says it moved (`settings.changed`, `obsidian.sync`, `obsidian.projection`), never on
 * a timer. A read that fails is kept as `failed`, so the row can say so and offer to try again.
 */

export type Loaded<T> =
  { status: "loading" } | { status: "failed" } | { status: "ready"; value: T };

/** The storage settings: the vault folder, the sync switches, the managed folder. */
export function useStorage(): {
  storage: Loaded<StorageSettings>;
  /** Takes the answer of a write as the new settings, before the bus event comes back. */
  apply: (value: StorageSettings) => void;
  retry: () => void;
} {
  const [storage, setStorage] = useState<Loaded<StorageSettings>>({ status: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    const follower = readOnEvents({
      api: () => window.app,
      sources: [{ type: "settings.changed", when: settingsTouch("storage", "obsidian") }],
      read: () => window.app.settings.get(),
      onValue: (value) => setStorage({ status: "ready", value }),
      onError: () =>
        setStorage((current) => (current.status === "ready" ? current : { status: "failed" }))
    });
    return () => follower.stop();
  }, [round]);
  return {
    storage,
    apply: (value) => setStorage({ status: "ready", value }),
    retry: () => {
      setStorage({ status: "loading" });
      setRound((value) => value + 1);
    }
  };
}

/** The vault synchronization: one status, replaced by each `obsidian.sync` event. */
export function useSyncStatus(): { sync: Loaded<ObsidianSyncStatus>; retry: () => void } {
  const [sync, setSync] = useState<Loaded<ObsidianSyncStatus>>({ status: "loading" });
  const [round, setRound] = useState(0);
  useEffect(
    () =>
      watchObsidianSync(
        () => window.app,
        (value) => setSync({ status: "ready", value }),
        () => setSync((current) => (current.status === "ready" ? current : { status: "failed" }))
      ),
    [round]
  );
  return {
    sync,
    retry: () => {
      setSync({ status: "loading" });
      setRound((value) => value + 1);
    }
  };
}

type WikiStatus = Awaited<ReturnType<DesktopApi["obsidian"]["wikiStatus"]>>;

export interface WikiHandle {
  wiki: Loaded<WikiStatus>;
  /** Takes the answer of a write as the new status. */
  set: (value: WikiStatus) => void;
  /** Reads once more. */
  reload: () => void;
}

/** The wiki projection: its scope, job, delivery, files waiting for review and retired files. */
export function useWikiStatus(): WikiHandle {
  const [wiki, setWiki] = useState<Loaded<WikiStatus>>({ status: "loading" });
  const [round, setRound] = useState(0);
  useEffect(
    () =>
      followWikiStatus(
        () => window.app,
        (value) => setWiki({ status: "ready", value }),
        () => setWiki((current) => (current.status === "ready" ? current : { status: "failed" }))
      ),
    [round]
  );
  const set = useCallback((value: WikiStatus) => setWiki({ status: "ready", value }), []);
  return {
    wiki,
    set,
    reload: () => {
      setWiki({ status: "loading" });
      setRound((value) => value + 1);
    }
  };
}

export type EditorialRows = Awaited<ReturnType<DesktopApi["obsidian"]["editorialConflicts"]>>;

export interface EditorialHandle {
  /** The edits the paired Obsidian plugin sent that wait for review; `null` until the first read. */
  rows: EditorialRows | null;
  /** True when the last read failed. */
  failed: boolean;
  /** Reads once more (after one edit was resolved). */
  refresh: () => void;
}

/**
 * The plugin's edits waiting for review. Read once and after each editorial projection, each sync
 * that ended and each change of the vault settings (D16): the Obsidian group's "Vault reviews"
 * line needs the count even while it is closed, so it follows here and not inside the card.
 */
export function useEditorialConflicts(): EditorialHandle {
  const [rows, setRows] = useState<EditorialRows | null>(null);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(
    () =>
      followEditorialConflicts(
        () => window.app,
        (value) => {
          setRows(value);
          setFailed(false);
        },
        () => setFailed(true)
      ),
    [round]
  );
  return {
    rows,
    failed,
    // Trying again clears the failure, so the person sees the read start again.
    refresh: () => {
      setFailed(false);
      setRound((value) => value + 1);
    }
  };
}

export interface LayoutHandle {
  status: ObsidianLayoutStatus | null;
  /** The configuration a new preview starts from. */
  config: ObsidianLayoutConfig | null;
  configured: boolean;
  active: boolean;
  failed: boolean;
  setStatus: (status: ObsidianLayoutStatus) => void;
  reload: () => void;
}

/** The vault layout: the status of its migrations and whether the vault is bound and syncing. */
export function useLayoutStatus(): LayoutHandle {
  const [status, setStatus] = useState<ObsidianLayoutStatus | null>(null);
  const [config, setConfig] = useState<ObsidianLayoutConfig | null>(null);
  const [binding, setBinding] = useState({ configured: false, active: false });
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(
    () =>
      followLayout(() => window.app, {
        onBinding: setBinding,
        onStatus: (value) => {
          setStatus(value);
          setFailed(false);
        },
        onRebound: setConfig,
        onError: () => setFailed(true)
      }),
    [round]
  );
  return {
    status,
    config,
    configured: binding.configured,
    active: binding.active,
    failed,
    setStatus,
    reload: () => {
      setFailed(false);
      setRound((value) => value + 1);
    }
  };
}

export interface GatewayHandle {
  gateway: Loaded<{ status: IntegrationGatewayStatus; clients: IntegrationClient[] }>;
  /** Reads the gateway and its clients again (after a pairing or a revoke). */
  reload: () => void;
}

/** The local gateway and the apps paired with it. They have no event: read on open and after a write. */
export function useGateway(): GatewayHandle {
  const [gateway, setGateway] = useState<GatewayHandle["gateway"]>({ status: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    Promise.all([window.app.integrations.getGatewayStatus(), window.app.integrations.listClients()])
      .then(([status, clients]) => {
        if (live) setGateway({ status: "ready", value: { status, clients } });
      })
      .catch(() => {
        if (live)
          setGateway((current) => (current.status === "ready" ? current : { status: "failed" }));
      });
    return () => {
      live = false;
    };
  }, [round]);
  return { gateway, reload: () => setRound((value) => value + 1) };
}

import type { ObsidianLayoutConfig, ObsidianLayoutStatus } from "@app/integration-contracts";
import type { AppSettings, DesktopApi, StorageSettings } from "../../shared/ipc";
import type { AppEventApi } from "../lib/app-events";
import { obsidianSyncEnded, readOnEvents, settingsTouch } from "../lib/status-followers";

/**
 * What the Obsidian cards follow on the bus (F5 D16): one initial read and one read after each
 * event that can change what the card shows. Kept out of the cards so a test drives each over a
 * fake bus (`lib/fake-app-events.ts`); a card hands its `window.app`.
 */

type Conflicts = Awaited<ReturnType<DesktopApi["obsidian"]["editorialConflicts"]>>;
type WikiStatus = Awaited<ReturnType<DesktopApi["obsidian"]["wikiStatus"]>>;

export interface EditorialApi extends AppEventApi {
  obsidian: Pick<DesktopApi["obsidian"], "editorialConflicts">;
}

/** The editorial conflicts: read after an editorial projection and after a sync that ended. */
export function followEditorialConflicts(
  api: () => EditorialApi | undefined,
  onRows: (rows: Conflicts) => void,
  onError: () => void
): () => void {
  return readOnEvents({
    api,
    sources: [
      { type: "obsidian.projection", when: (event) => event.kind === "editorial" },
      { type: "obsidian.sync", when: obsidianSyncEnded }
    ],
    read: () => requireApi(api).obsidian.editorialConflicts(),
    onValue: onRows,
    onError
  }).stop;
}

export interface WikiApi extends AppEventApi {
  obsidian: Pick<DesktopApi["obsidian"], "wikiStatus">;
}

/**
 * The wiki projection's status: read after each wiki projection page, a sync that ended or a change
 * of the vault settings.
 */
export function followWikiStatus(
  api: () => WikiApi | undefined,
  onStatus: (status: WikiStatus) => void,
  onError: () => void
): () => void {
  return readOnEvents({
    api,
    sources: [
      { type: "obsidian.projection", when: (event) => event.kind === "wiki" },
      { type: "obsidian.sync", when: obsidianSyncEnded },
      { type: "settings.changed", when: settingsTouch("obsidian", "storage") }
    ],
    read: () => requireApi(api).obsidian.wikiStatus(),
    onValue: onStatus,
    onError
  }).stop;
}

export interface LayoutApi extends AppEventApi {
  obsidian: Pick<DesktopApi["obsidian"], "layoutStatus">;
  settings: Pick<DesktopApi["settings"], "get" | "getApp">;
}

export interface LayoutFollowerHandlers {
  onBinding: (binding: { configured: boolean; active: boolean }) => void;
  onStatus: (status: ObsidianLayoutStatus) => void;
  /** The vault binding moved (or this is the first read): the form starts from this configuration. */
  onRebound: (config: ObsidianLayoutConfig) => void;
  onError: () => void;
}

/**
 * The layout card's vault binding and layout status. A change of the vault settings reads the
 * layout again only when the binding (vault path and managed root) moved; a layout projection (a
 * preview, an apply or a rollback, from this window or another) always reads it.
 */
export function followLayout(
  api: () => LayoutApi | undefined,
  handlers: LayoutFollowerHandlers
): () => void {
  let binding: string | undefined;
  let forceStatus = true;
  let stopped = false;
  const read = async (): Promise<void> => {
    const app = requireApi(api);
    const storage: StorageSettings = await app.settings.get();
    if (stopped) return;
    handlers.onBinding({
      configured: Boolean(storage.obsidianVaultPath),
      active:
        Boolean(storage.obsidianVaultPath) &&
        storage.obsidianSyncEnabled &&
        !storage.obsidianSyncPaused
    });
    const next = JSON.stringify([storage.obsidianVaultPath, storage.managedRoot]);
    if (next === binding && !forceStatus) return;
    const rebound = next !== binding;
    binding = next;
    forceStatus = false;
    const [status, settings]: [ObsidianLayoutStatus, AppSettings] = await Promise.all([
      app.obsidian.layoutStatus(),
      app.settings.getApp()
    ]);
    if (stopped) return;
    handlers.onStatus(status);
    if (rebound) {
      handlers.onRebound(
        status.config ?? { version: 2, language: settings.contentLanguage, attachments: "omit" }
      );
    }
  };
  const follower = readOnEvents({
    api,
    sources: [
      {
        type: "obsidian.projection",
        when: (event) => {
          if (event.kind !== "layout") return false;
          forceStatus = true;
          return true;
        }
      },
      { type: "settings.changed", when: settingsTouch("obsidian", "storage") }
    ],
    read,
    onValue: () => undefined,
    onError: handlers.onError
  });
  return () => {
    stopped = true;
    follower.stop();
  };
}

function requireApi<A>(api: () => A | undefined): A {
  const value = api();
  if (!value) throw new Error("window.app is not available");
  return value;
}

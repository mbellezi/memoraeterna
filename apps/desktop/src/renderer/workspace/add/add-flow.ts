import type { DesktopApi, IngestionResult } from "../../../shared/ipc";
import type { DroppedFile, DroppedFileHandle } from "../../../shared/ipc-drop";
import { isWriterRouteReady } from "../../lib/writer-route";
import { descriptorFromFile } from "./add-descriptor";
import {
  effectiveMode,
  isImportMode,
  planOfMode,
  type AddFailureReason,
  type ImportMode,
  type Readiness
} from "./add-model";

/**
 * Adicionar's behaviour (design record 5.2, D32 as amended by A7), with no React in it. The main
 * part and Cmd-N open the file picker; a drop on the window imports at once. Both import with the
 * current mode, then push the Source onto Explore's stack (`openSource`): the first of several
 * files opens, the others queue and wait in the Activity pill. There is no toast. A file that
 * cannot be read stops that file only and says so in place (`failure`), never in a modal.
 *
 * Calls go through `window.app` (`api`), so the screens tool and the tests stand a fake in.
 */

type Api = Pick<DesktopApi, "ingestion" | "ai" | "localModels">;

export interface AddFlowOptions {
  api: () => Api;
  /** The Source was added: push it onto Explore's stack and show Explore. */
  openSource: (sourceItemId: string) => void;
  /** "Mais opções de importação…", "Colar link" and "Escrever uma nota": the import panel. */
  openImportPanel: () => void;
  /** Where the chosen mode is remembered (a per-person convenience); absent, it lasts the session. */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

export interface AddFailure {
  reason: AddFailureReason;
  /** The file's name when the failure is about one file; the person's own text. */
  name: string | null;
}

export interface AddFlowSnapshot {
  readiness: Readiness;
  /** The mode the person chose, or null while the default stands. */
  chosen: ImportMode | null;
  /** The mode an import uses now. */
  mode: ImportMode;
  /** Something is being read or imported: the file's name (null before a pick), and files waiting. */
  busy: { name: string | null; waiting: number } | null;
  failure: AddFailure | null;
}

export const addModeStorageKey = "memora.add.importMode";

const unknownFailure: AddFailure = { reason: "generic", name: null };

/** The failure a main-process error stands for. */
function failureOfError(error: unknown, name: string | null): AddFailure {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("errors.common.fileTooLarge")) return { reason: "tooLarge", name };
  return name === null ? unknownFailure : { reason: "unreadable", name };
}

export class AddFlow {
  private readonly options: AddFlowOptions;
  private readonly listeners = new Set<() => void>();
  private snapshot: AddFlowSnapshot;
  private readinessStarted = false;
  private readinessAttempt = 0;
  private working = false;
  private queue: DroppedFileHandle[] = [];
  private opened = false;

  constructor(options: AddFlowOptions) {
    this.options = options;
    const chosen = this.readChosen();
    const readiness: Readiness = { status: "loading" };
    this.snapshot = {
      readiness,
      chosen,
      mode: effectiveMode(chosen, readiness),
      busy: null,
      failure: null
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): AddFlowSnapshot => this.snapshot;

  private set(patch: Partial<AddFlowSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    next.mode = effectiveMode(next.chosen, next.readiness);
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private readChosen(): ImportMode | null {
    try {
      const stored = this.options.storage?.getItem(addModeStorageKey);
      return isImportMode(stored) ? stored : null;
    } catch {
      return null;
    }
  }

  /**
   * Reads whether a model that can write is ready, once; the menu asks when it opens and an import
   * asks before it chooses its plan. A failed read is kept (`error`) and retried on request.
   */
  readonly ensureReadiness = async (): Promise<Readiness> => {
    if (this.readinessStarted) return this.snapshot.readiness;
    return this.readReadiness();
  };

  readonly retryReadiness = async (): Promise<Readiness> => {
    this.set({ readiness: { status: "loading" } });
    return this.readReadiness();
  };

  /** The menu opened: read again, keeping what is shown until the answer comes (a model may have arrived). */
  readonly refreshReadiness = async (): Promise<Readiness> => {
    if (!this.readinessStarted || this.snapshot.readiness.status === "error")
      return this.snapshot.readiness.status === "error"
        ? this.retryReadiness()
        : this.ensureReadiness();
    return this.readReadiness();
  };

  private async readReadiness(): Promise<Readiness> {
    this.readinessStarted = true;
    const attempt = (this.readinessAttempt += 1);
    let readiness: Readiness;
    try {
      const { ai, localModels } = this.options.api();
      const [profiles, profileTasks, routes, providers] = await Promise.all([
        ai.listProfiles(),
        ai.listProfileTasks(),
        ai.listTaskRoutes(),
        ai.listProviders()
      ]);
      const usesLocalModel = profiles.some((profile) => profile.localModelId !== null);
      const statuses = usesLocalModel ? await localModels.statuses() : [];
      readiness = {
        status: "ready",
        writer: isWriterRouteReady({
          profiles,
          profileTasks,
          routes,
          providers,
          localModels: statuses
        })
      };
    } catch {
      readiness = { status: "error" };
    }
    if (attempt === this.readinessAttempt) this.set({ readiness });
    return readiness;
  }

  chooseMode(mode: ImportMode): void {
    try {
      this.options.storage?.setItem(addModeStorageKey, mode);
    } catch {
      // The choice still holds for this session.
    }
    this.set({ chosen: mode });
  }

  /** "Colar link", "Escrever uma nota" and "Mais opções de importação…": the advanced import panel. */
  readonly openImportPanel = (): void => {
    this.dismissFailure();
    this.options.openImportPanel();
  };

  readonly dismissFailure = (): void => {
    if (this.snapshot.failure) this.set({ failure: null });
  };

  /** Cmd-N and Adicionar's main part: the file picker, then the import. Ignored while one runs. */
  readonly pickFile = async (): Promise<void> => {
    if (this.working) return;
    this.working = true;
    this.opened = false;
    this.set({ busy: { name: null, waiting: 0 }, failure: null });
    try {
      await this.ensureReadiness();
      const api = this.options.api();
      const file = await api.ingestion.extractFileMetadata({
        sourceType: "GenericDocument",
        requestId: globalThis.crypto.randomUUID()
      });
      if (!file) return; // The picker was canceled: nothing to say.
      this.set({ busy: { name: file.fileName, waiting: 0 } });
      const result = await api.ingestion.importFile({
        fileToken: file.fileToken,
        descriptor: descriptorFromFile(file),
        duplicatePolicy: "ignore",
        processingPlan: planOfMode(this.snapshot.mode)
      });
      this.opened = this.open(result);
    } catch (error) {
      this.set({ failure: failureOfError(error, null) });
    } finally {
      this.working = false;
      this.set({ busy: null });
    }
  };

  /** A drop on the window: each file is read, imported with the current mode and queued behind the last. */
  readonly importDropped = async (files: readonly DroppedFileHandle[]): Promise<void> => {
    if (files.length === 0) return;
    this.queue.push(...files);
    if (this.working) {
      this.set({
        busy: this.snapshot.busy && { ...this.snapshot.busy, waiting: this.queue.length }
      });
      return;
    }
    this.working = true;
    this.opened = false;
    this.set({ failure: null });
    try {
      await this.ensureReadiness();
      while (this.queue.length > 0) {
        const file = this.queue.shift()!;
        this.set({ busy: { name: file.name, waiting: this.queue.length } });
        await this.importOne(file);
      }
    } finally {
      this.working = false;
      this.set({ busy: null });
    }
  };

  private async importOne(file: DroppedFileHandle): Promise<void> {
    const api = this.options.api();
    try {
      // One file per call: the first Source can open while the next file is still being read.
      const [prepared] = await api.ingestion.prepareDroppedFiles([file]);
      if (!prepared) {
        this.fail({ reason: "generic", name: file.name });
        return;
      }
      if (prepared.status === "refused") {
        this.fail({ reason: prepared.reason, name: prepared.name || file.name });
        return;
      }
      const ready: Extract<DroppedFile, { status: "ready" }> = prepared;
      const result = await api.ingestion.importFile({
        fileToken: ready.fileToken,
        descriptor: descriptorFromFile({
          fileName: ready.name,
          mimeType: ready.mimeType,
          draft: ready.draft
        }),
        duplicatePolicy: "ignore",
        processingPlan: planOfMode(this.snapshot.mode)
      });
      if (!this.opened) this.opened = this.open(result);
    } catch (error) {
      this.fail(failureOfError(error, file.name));
    }
  }

  /** The first failure of a batch is the one shown; the rest are not told over it. */
  private fail(failure: AddFailure): void {
    if (!this.snapshot.failure) this.set({ failure });
  }

  private open(result: IngestionResult | null): boolean {
    if (!result) return false;
    this.options.openSource(result.sourceItemId);
    return true;
  }
}

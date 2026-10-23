import type { ModelDownloadEvent } from "../../shared/app-events";
import type { LocalModelView } from "../../shared/ipc";

export interface ModelDownloadUpdate {
  models: LocalModelView[];
  /** The list must be read again: what the event says cannot be patched into the rows. */
  reload: boolean;
}

/**
 * What a `model.download` push changes in a list of local models (F4 D26): the status, the error and
 * the progress of the one model it names, without reading the list. A model the list does not hold
 * is a reason to read it. So is an install that settled (sizes, capabilities and the row's actions
 * change with it) and one that started without the row having a download to patch (a first run
 * install the owner did not click).
 */
export function applyModelDownloadEvent(
  models: readonly LocalModelView[],
  event: ModelDownloadEvent
): ModelDownloadUpdate {
  const known = models.some((model) => model.id === event.localModelId);
  const transferring = event.status === "downloading" || event.status === "verifying";
  let reload = !known || !transferring;
  const next = models.map((model) => {
    if (model.id !== event.localModelId) return model;
    if (!transferring) return { ...model, status: event.status, lastError: event.error };
    if (!model.download) {
      reload = true;
      return { ...model, status: event.status, lastError: event.error };
    }
    return {
      ...model,
      status: event.status,
      lastError: event.error,
      download: {
        ...model.download,
        currentFile: event.currentFile,
        downloadedBytes: event.downloadedBytes,
        totalBytes: event.totalBytes,
        bytesPerSecond: event.bytesPerSecond,
        etaSeconds: event.etaSeconds
      }
    };
  });
  return { models: next, reload };
}

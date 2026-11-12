import {
  dropChannels,
  DroppedFilesSchema,
  droppedFilesMax,
  PrepareDroppedInputSchema,
  type DroppedFile,
  type DroppedFileHandle,
  type PrepareDroppedFiles
} from "../shared/ipc-drop.js";

/** The slice of `ipcRenderer` the bridge needs, so tests can stand in for it. */
export interface DropInvoker {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
}

/**
 * Resolves a `File` to its path (`webUtils.getPathForFile`): only the preload may call it, and the
 * path goes to main and never back to the page. A file with no path (a blob, a pasted image) gives "".
 */
export type PathOfFile = (file: File) => string;

/**
 * `window.app.ingestion.prepareDroppedFiles` (F5 D32, T150). The page hands over the dropped `File`
 * objects. A file that has no path on disk (a blob or an item that is not a file) is refused here
 * and never reaches main; the others go to main in one call, which validates each path and answers
 * with an opaque token. The results come back in the order the files came, with no path in them.
 */
export function createDropApi(ipc: DropInvoker, pathOfFile: PathOfFile): PrepareDroppedFiles {
  return async (files: readonly DroppedFileHandle[]): Promise<DroppedFile[]> => {
    const slots = files.slice(0, droppedFilesMax).map((file) => {
      let path = "";
      try {
        path = pathOfFile(file as File);
      } catch {
        path = "";
      }
      return { name: typeof file.name === "string" ? file.name : "", path };
    });
    const results: DroppedFile[] = slots.map((slot) => ({
      status: "refused",
      name: slot.name,
      reason: "notAFile"
    }));
    const withPath = slots.flatMap((slot, index) => (slot.path ? [{ index, path: slot.path }] : []));
    if (withPath.length === 0) return results;
    const prepared = DroppedFilesSchema.parse(
      await ipc.invoke(
        dropChannels.prepare,
        PrepareDroppedInputSchema.parse({ paths: withPath.map((entry) => entry.path) })
      )
    );
    if (prepared.length !== withPath.length) throw new Error("errors.common.unknown");
    withPath.forEach((entry, position) => {
      results[entry.index] = prepared[position]!;
    });
    return results;
  };
}

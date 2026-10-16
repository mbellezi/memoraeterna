import { ipcChannels } from "../../shared/ipc.js";
import type { IpcMain } from "electron";
import { WikiQuerySchema } from "@app/domain";
import type { WikiService } from "./wiki-service.js";

/** The one read left under the wiki name: the source search of the scope pickers. */
export function registerWikiIpc(ipc: IpcMain, service: WikiService) {
  ipc.handle(ipcChannels.wikiSearch, (_event, payload: unknown) =>
    service.search(WikiQuerySchema.parse(payload))
  );
}

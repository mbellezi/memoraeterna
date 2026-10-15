import { ipcChannels } from "../../shared/ipc.js";
import type { IpcMain } from "electron";
import { WikiQuerySchema } from "@app/domain";
import type { WikiService } from "./wiki-service.js";

/** The two wiki reads the scope pickers still use: the page list and the source search. */
export function registerWikiIpc(ipc: IpcMain, service: WikiService) {
  ipc.handle(ipcChannels.wikiList, () => service.list());
  ipc.handle(ipcChannels.wikiSearch, (_event, payload: unknown) =>
    service.search(WikiQuerySchema.parse(payload))
  );
}

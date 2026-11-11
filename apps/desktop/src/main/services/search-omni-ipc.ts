import type { IpcMain } from "electron";

import { searchIpcChannels } from "../../shared/ipc-search.js";
import type { SearchOmniService } from "./search-omni-service.js";

/** The request is validated by the service; the preload validated it first. */
export function registerSearchOmniIpc(ipc: IpcMain, service: SearchOmniService) {
  ipc.handle(searchIpcChannels.searchOmni, (_event, payload: unknown) => service.omni(payload));
}

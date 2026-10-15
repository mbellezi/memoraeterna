import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc.js";
import {
  viewHistoryListInputSchema,
  viewHistoryPinInputSchema,
  viewHistoryRecordInputSchema
} from "../../shared/view-history.js";
import type { ViewHistoryService } from "./view-history-service.js";

/** Every request is validated here, before the service sees it. */
export function registerViewHistoryIpc(ipc: IpcMain, service: ViewHistoryService) {
  ipc.handle(ipcChannels.viewHistoryRecord, (_event, payload: unknown) =>
    service.record(viewHistoryRecordInputSchema.parse(payload))
  );
  ipc.handle(ipcChannels.viewHistoryList, (_event, payload: unknown) =>
    service.list(viewHistoryListInputSchema.parse(payload ?? {}))
  );
  ipc.handle(ipcChannels.viewHistoryPin, (_event, payload: unknown) => {
    const input = viewHistoryPinInputSchema.parse(payload);
    return service.setPinned(input.address, input.pinned);
  });
  ipc.handle(ipcChannels.viewHistoryClear, () => service.clear());
}

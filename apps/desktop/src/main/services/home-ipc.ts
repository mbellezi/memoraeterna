import type { IpcMain } from "electron";

import { HomeDigestInputSchema, homeChannels } from "../../shared/ipc-home.js";
import type { HomeService } from "./home-service.js";

/**
 * The handler of the home area. The request is validated here and again by the service; the
 * preload validated it first. Home is read on demand: nothing is pushed on a channel of this area,
 * and the page re-reads when the bus says an object changed.
 */
export function registerHomeIpc(ipc: IpcMain, service: Pick<HomeService, "digest">) {
  ipc.handle(homeChannels.digest, (_event, payload: unknown) =>
    service.digest(HomeDigestInputSchema.parse(payload ?? {}))
  );
}

import type { IpcMain } from "electron";

import { InboxActInputSchema, InboxListInputSchema } from "@app/domain";
import { z } from "zod";

import { ipcChannels } from "../../../shared/ipc.js";
import type { InboxService } from "./inbox-service.js";

/** What the handlers need of the service (tests pass a fake). */
export type InboxPort = Pick<InboxService, "list" | "counts" | "act">;

/**
 * `inbox.*` (F4 D29, spec 3.10): every request is validated here before the service sees it, and
 * the service validates its answers before they leave; the preload validated the request first.
 */
export function registerInboxIpc(ipc: Pick<IpcMain, "handle">, service: InboxPort): void {
  ipc.handle(ipcChannels.inboxList, (_event, payload: unknown) =>
    service.list(InboxListInputSchema.parse(payload ?? {}))
  );
  ipc.handle(ipcChannels.inboxCounts, (_event, ...args: unknown[]) => {
    z.tuple([]).parse(args);
    return service.counts();
  });
  ipc.handle(ipcChannels.inboxAct, (_event, payload: unknown) =>
    service.act(InboxActInputSchema.parse(payload))
  );
}

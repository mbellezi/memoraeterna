import { ipcChannels } from "../../shared/ipc.js";
import type { IpcMain } from "electron";
import { z } from "zod";
import { WikiSaveInputSchema, WikiQuerySchema } from "@app/domain";
import type { WikiService } from "./wiki-service.js";

export function registerWikiIpc(ipc: IpcMain, service: WikiService) {
  ipc.handle(ipcChannels.wikiList, () => service.list());
  ipc.handle(ipcChannels.wikiGet, (_event, payload: unknown) => {
    const input = z.object({ id: z.string().uuid(), revisionId: z.string().uuid().optional() }).strict().parse(payload);
    return service.get(input.id, input.revisionId);
  });
  ipc.handle(ipcChannels.wikiSave, (_event, payload: unknown) => service.save(WikiSaveInputSchema.parse(payload)));
  ipc.handle(ipcChannels.wikiSearch, (_event, payload: unknown) => service.search(WikiQuerySchema.parse(payload)));
  ipc.handle(ipcChannels.wikiHistory, (_event, payload: unknown) => service.history(z.string().uuid().parse(payload)));
}

import { ipcChannels } from "../../shared/ipc.js";
import type { IpcMain } from "electron";
import { z } from "zod";
import { WikiTreeInputSchema,WikiContextInputSchema,WikiMoveInputSchema,WikiLinkedTargetInputSchema,WikiSaveInputSchema, WikiQuerySchema } from "@app/domain";
import type { WikiService } from "./wiki-service.js";

export function registerWikiIpc(ipc: IpcMain, service: WikiService) {
  ipc.handle(ipcChannels.wikiTree,(_event,input:unknown)=>service.tree(WikiTreeInputSchema.parse(input)));
  ipc.handle(ipcChannels.wikiContext,(_event,input:unknown)=>service.context(WikiContextInputSchema.parse(input)));
  ipc.handle(ipcChannels.wikiMove,(_event,input:unknown)=>service.move(WikiMoveInputSchema.parse(input)));
  ipc.handle(ipcChannels.wikiLinkedTarget,(_event,payload:unknown)=>service.linkedTarget(WikiLinkedTargetInputSchema.parse(payload)));
  ipc.handle(ipcChannels.wikiList, () => service.list());
  ipc.handle(ipcChannels.wikiGet, (_event, payload: unknown) => {
    const input = z.object({ id: z.string().uuid(), revisionId: z.string().uuid().optional() }).strict().parse(payload);
    return service.get(input.id, input.revisionId);
  });
  ipc.handle(ipcChannels.wikiSave, (_event, payload: unknown) => service.save(WikiSaveInputSchema.parse(payload)));
  ipc.handle(ipcChannels.wikiSearch, (_event, payload: unknown) => service.search(WikiQuerySchema.parse(payload)));
  ipc.handle(ipcChannels.wikiHistory, (_event, payload: unknown) => service.history(z.string().uuid().parse(payload)));
}

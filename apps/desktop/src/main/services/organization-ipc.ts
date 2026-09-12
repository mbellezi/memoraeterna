import type { IpcMain } from "electron";
import { OrganizationCommandSchema,CuratorCommandSchema,WikiCollectionCommandSchema } from "@app/domain";
import { ipcChannels } from "../../shared/ipc.js";
import type { OrganizationService } from "./organization-service.js";
export function registerOrganizationIpc(ipc:IpcMain,service:OrganizationService){
  ipc.handle(ipcChannels.wikiCollection,(_event,input:unknown)=>service.collectionCommand(WikiCollectionCommandSchema.parse(input)));
  ipc.handle(ipcChannels.curatorCommand,(_event,input:unknown)=>service.automaticCommand(CuratorCommandSchema.parse(input)));
  ipc.handle(ipcChannels.organizationCommand,(_event,input:unknown)=>(()=>{const command=OrganizationCommandSchema.parse(input);if(['saveDraft','activate','sample'].includes(command.command))throw new Error('prompts.errors.moved');return service.command(command);})());
}

import type { IpcMain } from "electron";
import { OrganizationCommandSchema } from "@app/domain";
import { ipcChannels } from "../../shared/ipc.js";
import type { OrganizationService } from "./organization-service.js";
export function registerOrganizationIpc(ipc:IpcMain,service:OrganizationService){
  ipc.handle(ipcChannels.organizationCommand,(_event,input:unknown)=>service.command(OrganizationCommandSchema.parse(input)));
}

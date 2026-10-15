import type { IpcMain } from "electron";
import {
  OrganizationCommandSchema,
  CuratorCommandSchema,
  WikiCollectionCommandSchema
} from "@app/domain";
import { ipcChannels } from "../../shared/ipc.js";
import { fenceLegacyCommand } from "./legacy-fence.js";
import type { OrganizationService } from "./organization-service.js";

/**
 * The legacy organization, curator and wiki-collection channels are fenced (F2 D3): deny by default.
 * A command answers only when UI that stays mounted once the legacy screens (Automation, Settings
 * Organization and Maintenance, Wiki workspace) are gone still calls it. A grep of the renderer for
 * `organization.command`, `curator.command` and `wiki.collection` outside those screens finds only
 * the Ask dialog:
 *
 * - `organization.settings`: the domains of the active configuration;
 * - `curator.policies`: the enabled policies of the followed questions.
 *
 * Both only read, and no collection command is called at all. The Ask decoupling removes the two
 * calls; the task that deletes the legacy services deletes these channels and lists with them.
 */
export const organizationReadCommands: ReadonlySet<string> = new Set(["settings"]);
export const curatorReadCommands: ReadonlySet<string> = new Set(["policies"]);
export const wikiCollectionReadCommands: ReadonlySet<string> = new Set();

export function registerOrganizationIpc(ipc: IpcMain, service: OrganizationService) {
  const collection = fenceLegacyCommand(
    wikiCollectionReadCommands,
    WikiCollectionCommandSchema,
    (command) => service.collectionCommand(command)
  );
  const curator = fenceLegacyCommand(curatorReadCommands, CuratorCommandSchema, (command) =>
    service.automaticCommand(command)
  );
  const organization = fenceLegacyCommand(
    organizationReadCommands,
    OrganizationCommandSchema,
    (command) => service.command(command)
  );
  ipc.handle(ipcChannels.wikiCollection, (_event, input: unknown) => collection(input));
  ipc.handle(ipcChannels.curatorCommand, (_event, input: unknown) => curator(input));
  ipc.handle(ipcChannels.organizationCommand, (_event, input: unknown) => organization(input));
}

import type { IpcMain } from "electron";
import { app } from "electron";
import { createTranslator } from "@app/i18n";
import {
  databaseStatusSchema,
  ipcChannels,
  storageSettingsUpdateSchema,
  type DatabaseStatus
} from "../shared/ipc";
import type { SettingsService } from "./services/settings-service";

export interface DatabaseServicePort {
  getStatus: () => DatabaseStatus;
  start: () => Promise<DatabaseStatus>;
}

export function registerIpcHandlers(
  ipcMain: IpcMain,
  settingsService: SettingsService,
  databaseService: DatabaseServicePort
): void {
  const t = createTranslator(app.getLocale());

  ipcMain.handle(ipcChannels.systemGetInfo, () => ({
    appName: t("app.title"),
    locale: app.getLocale(),
    platform: process.platform,
    versions: {
      chrome: process.versions.chrome,
      electron: process.versions.electron,
      node: process.versions.node
    }
  }));

  ipcMain.handle(ipcChannels.databaseGetStatus, () => databaseStatusSchema.parse(databaseService.getStatus()));

  ipcMain.handle(ipcChannels.databaseStart, async () => databaseStatusSchema.parse(await databaseService.start()));

  ipcMain.handle(ipcChannels.settingsGet, () => settingsService.get());

  ipcMain.handle(ipcChannels.settingsUpdate, (_event, payload: unknown) => {
    const settings = storageSettingsUpdateSchema.parse(payload);
    return settingsService.update(settings);
  });
}

import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, StorageSettingsUpdate } from "../shared/ipc";
import {
  databaseStatusSchema,
  ipcChannels,
  storageSettingsSchema,
  storageSettingsUpdateSchema,
  systemInfoSchema
} from "../shared/ipc";

const api: DesktopApi = {
  system: {
    async getInfo() {
      const result = await ipcRenderer.invoke(ipcChannels.systemGetInfo);
      return systemInfoSchema.parse(result);
    }
  },
  database: {
    async getStatus() {
      const result = await ipcRenderer.invoke(ipcChannels.databaseGetStatus);
      return databaseStatusSchema.parse(result);
    },
    async start() {
      const result = await ipcRenderer.invoke(ipcChannels.databaseStart);
      return databaseStatusSchema.parse(result);
    }
  },
  settings: {
    async get() {
      const result = await ipcRenderer.invoke(ipcChannels.settingsGet);
      return storageSettingsSchema.parse(result);
    },
    async update(settings: StorageSettingsUpdate) {
      const payload = storageSettingsUpdateSchema.parse(settings);
      const result = await ipcRenderer.invoke(ipcChannels.settingsUpdate, payload);
      return storageSettingsSchema.parse(result);
    }
  }
};

contextBridge.exposeInMainWorld("app", api);

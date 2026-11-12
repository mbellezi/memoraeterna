import type { IpcMain } from "electron";

import {
  SettingsResetInputSchema,
  settingsDescribeChannels
} from "../../shared/ipc-settings-describe.js";
import type { SettingsReset } from "./settings-reset.js";

/**
 * The handlers of the settings-describe area. A request is validated here and again by the reset;
 * the preload validated it first. A change is announced on the bus (`settings.changed`), never on a
 * channel of this area.
 */
export function registerSettingsDescribeIpc(
  ipc: Pick<IpcMain, "handle">,
  settings: Pick<SettingsReset, "describe" | "reset">
) {
  ipc.handle(settingsDescribeChannels.describe, () => settings.describe());
  ipc.handle(settingsDescribeChannels.reset, (_event, payload: unknown) =>
    settings.reset(SettingsResetInputSchema.parse(payload))
  );
}

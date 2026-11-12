import {
  SettingsDescribeResultSchema,
  SettingsResetInputSchema,
  SettingsResetResultSchema,
  settingsDescribeChannels,
  type SettingsDescribeApi
} from "../shared/ipc-settings-describe.js";

/** The one call the bridge needs from Electron; `ipcRenderer.invoke` fits it. */
export type SettingsDescribeInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/**
 * `window.app.settings.describe` and `.reset` (F5 D17): the request is validated before it leaves
 * the renderer's process and the answer before it reaches the page. The preload index spreads it
 * into `settings`.
 */
export function createSettingsDescribeApi(invoke: SettingsDescribeInvoke): SettingsDescribeApi {
  return {
    describe: async () =>
      SettingsDescribeResultSchema.parse(await invoke(settingsDescribeChannels.describe)),
    reset: async (input) =>
      SettingsResetResultSchema.parse(
        await invoke(settingsDescribeChannels.reset, SettingsResetInputSchema.parse(input))
      )
  };
}

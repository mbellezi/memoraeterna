// The native file dialog of a journey (F5 T137, spec 5.3): no window opens; `showOpenDialog` in
// main answers the given files as if the person had picked them. The renderer still receives only
// the opaque token main makes for each file.
import type { ElectronApplication } from "@playwright/test";

/** Makes every open dialog answer `paths` (absolute) until the next stub. */
export async function stubOpenDialog(
  electronApp: ElectronApplication,
  paths: readonly string[]
): Promise<void> {
  if (paths.some((path) => !path.startsWith("/")))
    throw new Error("A stubbed dialog answers absolute paths only");
  await electronApp.evaluate(
    ({ dialog }, filePaths) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths
      })) as typeof dialog.showOpenDialog;
    },
    [...paths]
  );
}

/** Makes every open dialog answer as if the person cancelled it. */
export async function stubCancelledDialog(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ dialog }) => {
    dialog.showOpenDialog = (async () => ({
      canceled: true,
      filePaths: []
    })) as typeof dialog.showOpenDialog;
  });
}

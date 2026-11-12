import type { MessageKey } from "@app/i18n";

/**
 * The rules of the Library section that need no screen: what makes a folder path worth sending to
 * main (which checks it again), the update a switch and a folder make together, and the words of a
 * failed backup.
 */

/**
 * A full path on this Mac: it starts with "/", holds no NUL and no ".." step. Main validates the same
 * way before it saves; asking here first keeps a typo from becoming a round trip.
 */
export function isAbsolutePath(value: string): boolean {
  const path = value.trim();
  if (!path.startsWith("/") || path.includes("\0")) return false;
  return !path.split("/").includes("..");
}

export interface UploadCopies {
  enabled: boolean;
  folder: string | null;
}

/** What the person did to the copy of uploaded files. */
export type CopiesAction =
  { kind: "switch"; on: boolean } | { kind: "folder"; path: string; thenOn?: boolean };

/**
 * The update of the storage settings an action makes, or `needsFolder` when the copy cannot be turned
 * on because no folder is set (the control then asks for the folder first). Turning the copy off
 * keeps the folder, so turning it on again needs no second choice.
 */
export function copiesUpdate(
  current: UploadCopies,
  action: CopiesAction
):
  | { update: { uploadCopiesEnabled?: boolean; uploadCopiesFolderPath?: string } }
  | { needsFolder: true } {
  if (action.kind === "switch") {
    if (action.on && current.folder === null) return { needsFolder: true };
    return { update: { uploadCopiesEnabled: action.on } };
  }
  const turnOn = action.thenOn === true || current.enabled;
  return {
    update: {
      uploadCopiesFolderPath: action.path.trim(),
      ...(turnOn ? { uploadCopiesEnabled: true } : {})
    }
  };
}

/** The message key a failed backup reads with: main's own `errors.backup.*` key when it sent one. */
export function backupFailureKey(error: unknown): MessageKey {
  const match =
    error instanceof Error ? error.message.match(/errors\.backup\.[a-zA-Z0-9_]+/) : null;
  return (match?.[0] as MessageKey | undefined) ?? "settingsLibrary.backup.failed";
}

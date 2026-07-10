import { execFile } from "node:child_process";
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PostgresSidecarConnection } from "@app/db";
import type { BackupResult, StorageSettings } from "../../shared/ipc.js";

const execFileAsync = promisify(execFile);

export interface BackupServiceOptions {
  getDatabaseContext: () => { connection: PostgresSidecarConnection; pgDumpPath: string } | null;
  getStorageSettings: () => Promise<StorageSettings>;
}

export class BackupService {
  public constructor(private readonly options: BackupServiceOptions) {}

  public async create(destinationRoot: string): Promise<BackupResult> {
    const context = this.options.getDatabaseContext();
    if (!context) throw new Error("errors.database.notReady");
    const settings = await this.options.getStorageSettings();
    const createdAt = new Date();
    const directory = join(destinationRoot, `memora-backup-${fileTimestamp(createdAt)}`);
    await mkdir(directory, { recursive: false });
    const dumpPath = join(directory, "database.dump");
    await execFileAsync(context.pgDumpPath, [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--host", context.connection.host,
      "--port", String(context.connection.port),
      "--username", context.connection.user,
      "--file", dumpPath,
      context.connection.database
    ], {
      env: { ...process.env, PGPASSWORD: context.connection.password },
      maxBuffer: 1024 * 1024
    });

    const included: BackupResult["included"] = ["database"];
    if (settings.obsidianVaultPath) {
      const managedVaultPath = join(settings.obsidianVaultPath, settings.managedRoot);
      if (await isDirectory(managedVaultPath)) {
        await cp(managedVaultPath, join(directory, "obsidian", settings.managedRoot), { recursive: true, errorOnExist: true });
        included.push("obsidian");
      }
    }
    if (settings.uploadCopiesEnabled && settings.uploadCopiesFolderPath && await isDirectory(settings.uploadCopiesFolderPath)) {
      await cp(settings.uploadCopiesFolderPath, join(directory, "uploaded-files"), { recursive: true, errorOnExist: true });
      included.push("uploadedFiles");
    }
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify({
      version: 1,
      createdAt: createdAt.toISOString(),
      included
    }, null, 2)}\n`, { mode: 0o600 });
    return { path: directory, createdAt: createdAt.toISOString(), included };
  }
}

function fileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

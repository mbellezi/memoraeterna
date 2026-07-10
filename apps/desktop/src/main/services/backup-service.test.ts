import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { BackupService } from "./backup-service.js";

describe("BackupService", () => {
  it.skipIf(process.platform === "win32")(
    "dumps the database without putting the password in argv and copies managed files",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memora-backup-test-"));
      const destination = join(root, "backups");
      const vault = join(root, "vault");
      const uploads = join(root, "uploads");
      const fakePgDump = join(root, "fake-pg-dump.sh");
      await Promise.all([
        mkdir(destination),
        mkdir(join(vault, "Memora"), { recursive: true }),
        mkdir(uploads)
      ]);
      await Promise.all([
        writeFile(join(vault, "Memora", "note.md"), "# Note\n"),
        writeFile(join(uploads, "source.pdf"), "source"),
        writeFile(fakePgDump, [
          "#!/bin/sh",
          "output=''",
          "previous=''",
          "for argument in \"$@\"; do",
          "  if [ \"$previous\" = '--file' ]; then output=\"$argument\"; fi",
          "  previous=\"$argument\"",
          "done",
          "printf '%s\\n%s\\n' \"$PGPASSWORD\" \"$*\" > \"$output\""
        ].join("\n"))
      ]);
      await chmod(fakePgDump, 0o700);

      const service = new BackupService({
        getDatabaseContext: () => ({
          connection: {
            host: "127.0.0.1",
            port: 5432,
            database: "memora",
            user: "memora",
            password: "database-secret",
            connectionString: "postgresql://redacted"
          },
          pgDumpPath: fakePgDump
        }),
        getStorageSettings: async () => ({
          obsidianVaultPath: vault,
          managedRoot: "Memora",
          obsidianSyncEnabled: true,
          obsidianSyncPaused: false,
          deletionPolicy: "tombstone",
          uploadCopiesEnabled: true,
          uploadCopiesFolderPath: uploads,
          updatedAt: new Date().toISOString()
        })
      });
      try {
        const result = await service.create(destination);
        const [password, argv] = (await readFile(join(result.path, "database.dump"), "utf8")).trim().split("\n");
        expect(password).toBe("database-secret");
        expect(argv).not.toContain("database-secret");
        expect(await readFile(join(result.path, "obsidian", "Memora", "note.md"), "utf8")).toBe("# Note\n");
        expect(await readFile(join(result.path, "uploaded-files", "source.pdf"), "utf8")).toBe("source");
        expect(result.included).toEqual(["database", "obsidian", "uploadedFiles"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

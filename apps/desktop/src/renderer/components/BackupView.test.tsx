import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { BackupOutcome, BackupView, backupFailureKey } from "./BackupView";

const t = createTranslator("en");

describe("BackupView", () => {
  it("offers the backup and says it is proven by a test restore", () => {
    const html = renderToString(<BackupView t={t} />);
    expect(html).toContain("Create backup");
    expect(html).toContain("prove it restorable with a test restore");
    expect(html).not.toContain("Verified by a test restore");
  });

  it("shows the running, cancelled and failed states without a verified label", () => {
    const loading = renderToString(
      <BackupOutcome t={t} status="shell.states.loading" path="" verified={false} failed={false} />
    );
    expect(loading).toContain(t("shell.states.loading"));
    expect(loading).toContain('role="status"');
    expect(loading).not.toContain("Verified by a test restore");

    const failed = renderToString(
      <BackupOutcome
        t={t}
        status="errors.backup.verificationFailed"
        path=""
        verified={false}
        failed
      />
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("could not be verified, so do not rely on it");
    expect(failed).not.toContain("Verified by a test restore");
  });

  it("shows the folder and the verified label when the test restore matched", () => {
    const html = renderToString(
      <BackupOutcome
        t={t}
        status="backup.completed"
        path="/backups/memora-backup-1"
        verified
        failed={false}
      />
    );
    expect(html).toContain("Backup completed:");
    expect(html).toContain("/backups/memora-backup-1");
    expect(html).toContain("Verified by a test restore");
  });

  it("shows a backup that finished without verification without claiming it was verified", () => {
    const html = renderToString(
      <BackupOutcome
        t={t}
        status="backup.completed"
        path="/backups/memora-backup-2"
        verified={false}
        failed={false}
      />
    );
    expect(html).toContain("/backups/memora-backup-2");
    expect(html).not.toContain("Verified by a test restore");
  });
});

describe("backupFailureKey", () => {
  it("reads the localized key out of the wrapped IPC error", () => {
    const wrapped = (key: string) =>
      new Error(`Error invoking remote method 'app:backup:create': Error: ${key}`);
    expect(backupFailureKey(wrapped("errors.backup.verificationFailed"))).toBe(
      "errors.backup.verificationFailed"
    );
    expect(backupFailureKey(wrapped("errors.backup.insufficientDisk"))).toBe(
      "errors.backup.insufficientDisk"
    );
  });

  it("falls back to the generic backup failure for anything else", () => {
    expect(backupFailureKey(new Error("errors.database.notReady"))).toBe("backup.failed");
    expect(backupFailureKey(new Error("spawn ENOENT"))).toBe("backup.failed");
    expect(backupFailureKey("not an error")).toBe("backup.failed");
  });

  it("has every backup message in every language", () => {
    for (const language of supportedLanguageCodes) {
      const translate = createTranslator(language);
      for (const key of [
        "backup.verified",
        "errors.backup.verificationFailed",
        "errors.backup.insufficientDisk"
      ] as const) {
        expect(translate(key, { missingKeyBehavior: "throw" })).not.toBe("");
      }
    }
  });
});

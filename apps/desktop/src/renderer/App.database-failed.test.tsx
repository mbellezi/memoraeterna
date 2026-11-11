import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import { App } from "./App";
import { appSettingsSchema, defaultAppSettings, databaseStatusSchema } from "../shared/ipc";

/** What React writes for text: the copy of a locale holds apostrophes. */
const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");

describe("App on a database that refused to start", () => {
  // F5 D25 (T111): the database service reports the refusal through the status's `messageKey`; the
  // startup screen already shows `t(messageKey)` under the failed title, so no screen code changes.
  it.each(supportedLanguageCodes)(
    "shows the refusal to upgrade the default profile in %s, with the retry action",
    (language) => {
      const status = databaseStatusSchema.parse({
        state: "failed",
        messageKey: "database.errors.defaultProfileUpgradeRefused",
        updatedAt: new Date(0).toISOString(),
        error: "Refusing to apply pending migrations to the default profile of an unpackaged build."
      });
      const t = createTranslator(language);

      const html = renderToString(
        <App
          firstRun={false}
          initialDatabaseStatus={status}
          initialAppSettings={appSettingsSchema.parse({
            ...defaultAppSettings,
            language,
            updatedAt: new Date(0).toISOString()
          })}
        />
      );

      expect(html).toContain(escapeHtml(t("database.startup.failedTitle")));
      expect(html).toContain(escapeHtml(t("database.errors.defaultProfileUpgradeRefused")));
      expect(html).toContain(escapeHtml(t("shell.actions.retry")));
      expect(html).not.toContain(escapeHtml(t("database.status.failed")));
      expect(html).not.toContain("Refusing to apply");
    }
  );
});

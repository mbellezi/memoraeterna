import { useId, useState } from "react";
import type { MessageKey, Translator } from "@app/i18n";
import type { ObsidianLayoutConfig, ObsidianLayoutStatus } from "@app/integration-contracts";

import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { ReadProblem, StatusLine, SwitchControl } from "../../SettingControls";
import { RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { labelOf } from "../../settings-model";
import { useContentLanguage } from "../../use-content-language";
import {
  attachmentsOn,
  layoutSettled,
  layoutStep,
  type LayoutMigration,
  type LayoutStep
} from "./integrations-model";
import type { LayoutHandle } from "./use-integrations-data";

const stepText: Readonly<Record<LayoutStep, MessageKey>> = {
  review: "settingsIntegrations.layout.review",
  waiting: "obsidianLayout.waiting",
  partial: "obsidianLayout.migrationPending",
  rollback: "obsidianLayout.rollbackPending",
  completed: "obsidianLayout.completed",
  rolledBack: "obsidianLayout.rolled_back"
};

const reasonText = (reason: string): MessageKey => {
  if (
    ["open", "pending", "dirty", "presence", "missing", "collision", "scope", "disk"].includes(
      reason
    )
  )
    return `obsidianLayout.${reason}` as MessageKey;
  return reason === "tombstone" ? "obsidianEditing.deleted" : "obsidianEditing.conflict";
};

const errorText = (cause: unknown): MessageKey => {
  const text = String(cause);
  if (text.includes("legacyConnected")) return "obsidianLayout.legacyConnected";
  if (text.includes("presence")) return "obsidianLayout.presence";
  if (text.includes("paused")) return "obsidianWiki.errors.paused";
  return "obsidianLayout.error";
};

/**
 * Copy the original files into the vault (Settings › Integrations › Obsidian). Changing it moves the
 * vault's folders, so it is a prepared migration, never an instant write: flipping the switch
 * prepares the change and shows what it would move; nothing in the vault changes until the person
 * has closed their editors and confirms "Apply". The reset of this row prepares the same migration.
 */
export function AttachmentsRow({
  entry,
  layout,
  storageFailed
}: {
  entry: SettingEntryV2;
  layout: LayoutHandle;
  /** The settings this row's read also depends on could not be read: the Vault row says so, once. */
  storageFailed: boolean;
}) {
  const settings = useSettings();
  const { t } = settings;
  const language = useContentLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const applied = settings.describe(entry.id)?.value === "copy";
  const on = attachmentsOn(layout.status, applied);
  const latest = layout.status?.migrations[0];

  const run = async (work: () => Promise<ObsidianLayoutStatus>) => {
    setBusy(true);
    setError(null);
    try {
      layout.setStatus(await work());
    } catch (cause) {
      setError(errorText(cause));
      try {
        layout.setStatus(await window.app.obsidian.layoutStatus());
      } catch {
        /* The failure above stays visible; the last status stays shown. */
      }
    } finally {
      setBusy(false);
    }
  };

  const prepare = (next: boolean) => {
    const base: ObsidianLayoutConfig = layout.status?.config ??
      layout.config ?? { version: 2, language: language ?? "en", attachments: "omit" };
    void run(() =>
      window.app.obsidian.previewLayout({ ...base, attachments: next ? "copy" : "omit" })
    );
  };

  return (
    <RegistryRow
      entry={entry}
      defaultLabel={t("settingsShell.row.valueOff")}
      control={
        layout.status === null && !layout.failed ? (
          <Skeleton className="h-5 w-20 rounded-full" />
        ) : (
          <SwitchControl
            t={t}
            label={labelOf(t, entry)}
            checked={on}
            onChange={prepare}
            disabled={busy || !layout.configured}
          />
        )
      }
      note={
        <div className="grid gap-2">
          {layout.failed && !storageFailed ? (
            <ReadProblem
              t={t}
              message={t("settingsIntegrations.layout.readFailed")}
              onRetry={layout.reload}
            />
          ) : null}
          {error ? (
            <StatusLine tone="warn" role="status">
              {t(error)}
            </StatusLine>
          ) : null}
          {latest ? (
            <LayoutReview
              key={latest.id}
              t={t}
              migration={latest}
              layout={layout}
              busy={busy}
              run={run}
            />
          ) : null}
        </div>
      }
    />
  );
}

function LayoutReview({
  t,
  migration,
  layout,
  busy,
  run
}: {
  t: Translator;
  migration: LayoutMigration;
  layout: LayoutHandle;
  busy: boolean;
  run: (work: () => Promise<ObsidianLayoutStatus>) => Promise<void>;
}) {
  const [closed, setClosed] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const checkId = useId();
  // The "editors closed" confirmation and the exclusions belong to one action: every Apply or
  // Rollback starts from an empty box again, so a vault write is never confirmed by an earlier one.
  const act = async (work: () => Promise<ObsidianLayoutStatus>) => {
    setClosed(false);
    setExcluded([]);
    await run(work);
  };
  const step = layoutStep(migration);
  const finished = step === "completed" || step === "rolledBack";
  const canApply = ["preview", "quiescing", "partial", "applying"].includes(migration.status);
  const canRollback = ["completed", "partial", "rolling_back"].includes(migration.status);
  const total = migration.targets.length;

  return (
    <div className="grid max-w-[34rem] gap-2 text-sm">
      <StatusLine tone={finished ? "ok" : "warn"} role="status">
        {t(stepText[step])}
      </StatusLine>
      <details key={migration.id} open={!finished} className="min-w-0">
        <summary className="cursor-pointer text-sm font-medium text-accent">
          {t("obsidianLayout.review")} · {layoutSettled(migration)}/{total}
        </summary>
        <ul className="m-0 mt-2 grid max-h-80 list-none gap-2 overflow-auto overscroll-contain p-0">
          {migration.targets.map((row) => (
            <li key={row.id} className="grid min-w-0 gap-1 border-b border-border pb-2 text-xs">
              <span className="text-foreground [overflow-wrap:anywhere]">
                {row.oldPath ?? "∅"} → {row.newPath}
              </span>
              {row.reason ? (
                <span className="text-warning [text-wrap:pretty]">{t(reasonText(row.reason))}</span>
              ) : null}
              {row.status === "planned" ? (
                <label className="flex items-center gap-2 text-secondary-foreground">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    disabled={busy}
                    checked={excluded.includes(row.id)}
                    onChange={(event) =>
                      setExcluded(
                        event.target.checked
                          ? [...excluded, row.id]
                          : excluded.filter((id) => id !== row.id)
                      )
                    }
                  />
                  {t("obsidianLayout.exclude")}
                </label>
              ) : null}
              {row.links.length > 0 ||
              row.base !== null ||
              row.local !== null ||
              row.proposed !== null ? (
                <details>
                  <summary className="cursor-pointer text-accent">
                    {t("obsidianWiki.review")}
                  </summary>
                  {row.links.length > 0 ? (
                    <p className="my-2 whitespace-pre-wrap text-secondary-foreground [overflow-wrap:anywhere]">
                      {t("obsidianLayout.links")}
                      {"\n"}
                      {row.links.join("\n")}
                    </p>
                  ) : null}
                  {(["base", "local", "proposed"] as const).map((key) => (
                    <div key={key} className="mt-2 min-w-0">
                      <h5 className="m-0 text-xs font-semibold text-foreground">
                        {t(`obsidianWiki.${key}`)}
                      </h5>
                      <pre className="m-0 mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-soft p-2 text-xs text-secondary-foreground [overflow-wrap:anywhere]">
                        {row[key] ?? "∅"}
                      </pre>
                    </div>
                  ))}
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
      {canApply || canRollback ? (
        <div className="grid gap-2">
          <label htmlFor={checkId} className="flex items-start gap-2 text-sm text-foreground">
            <input
              id={checkId}
              type="checkbox"
              className="mt-0.5 accent-accent"
              disabled={busy}
              checked={closed}
              onChange={(event) => setClosed(event.target.checked)}
            />
            <span>{t("obsidianLayout.closed")}</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {canApply ? (
              <Button
                variant="primary"
                disabled={busy || !closed || !layout.active}
                onClick={() =>
                  void act(() =>
                    window.app.obsidian.applyLayout({
                      id: migration.id,
                      excludeIds: excluded,
                      editorsClosed: true
                    })
                  )
                }
              >
                {t("obsidianLayout.apply")}
              </Button>
            ) : null}
            {canRollback ? (
              <Button
                disabled={busy || !closed || !layout.active}
                onClick={() =>
                  void act(() =>
                    window.app.obsidian.rollbackLayout({
                      id: migration.id,
                      excludeIds: [],
                      editorsClosed: true
                    })
                  )
                }
              >
                {t("obsidianLayout.rollback")}
              </Button>
            ) : null}
          </div>
          {!layout.active ? (
            <span className="text-xs text-muted-foreground">
              {t("settingsIntegrations.layout.needsSync")}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

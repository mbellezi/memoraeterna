import { useState } from "react";
import { FolderOpen } from "lucide-react";

import type { ObsidianSyncStatus, StorageSettings } from "../../../../shared/ipc";
import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import {
  obsidianSyncModeOf,
  obsidianSyncModePatch
} from "../../../components/settings/merged-controls";
import { InlineAction } from "../../InlineAction";
import { ReadProblem, StatusLine } from "../../SettingControls";
import { RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { labelOf } from "../../settings-model";
import {
  obsidianSyncModes,
  syncLine,
  syncModeLabel,
  syncModeOfValue,
  type ObsidianSyncMode
} from "./integrations-model";
import type { Loaded } from "./use-integrations-data";

interface StorageProps {
  storage: Loaded<StorageSettings>;
  apply: (value: StorageSettings) => void;
  retry: () => void;
}

/**
 * The vault folder (Settings › Integrations › Obsidian): where it is, and "Choose folder", which
 * opens the system's folder picker through main (the renderer never receives a path from the
 * picker, only the stored setting). Choosing first is what lets the sync switch on.
 */
export function VaultRow({
  entry,
  storage,
  apply,
  retry
}: StorageProps & { entry: SettingEntryV2 }) {
  const { t } = useSettings();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const path = storage.status === "ready" ? storage.value.obsidianVaultPath?.trim() || null : null;

  const choose = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const next = await window.app.settings.selectObsidianVault();
      if (next) apply(next);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <RegistryRow
      entry={entry}
      defaultLabel={t("settingsIntegrations.vault.none")}
      control={
        <Button disabled={busy || storage.status !== "ready"} onClick={() => void choose()}>
          <FolderOpen aria-hidden="true" />
          {t(path ? "settingsIntegrations.vault.change" : "settingsIntegrations.vault.choose")}
        </Button>
      }
      note={
        <div className="grid gap-1">
          {storage.status === "loading" ? (
            <Skeleton className="h-3.5 w-56" />
          ) : storage.status === "failed" ? (
            <ReadProblem
              t={t}
              message={t("settingsIntegrations.vault.readFailed")}
              onRetry={retry}
            />
          ) : path ? (
            <span title={path} className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">
              {path}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">
              {t("settingsIntegrations.vault.none")}
            </span>
          )}
          {failed ? (
            <StatusLine tone="warn" role="status">
              {t("settingsIntegrations.vault.pickFailed")}
            </StatusLine>
          ) : null}
        </div>
      }
    />
  );
}

/**
 * Off, On or Paused (the two stored switches as one control): Paused keeps everything configured and
 * synchronizes nothing. On and Paused wait for a vault. Under it, how the last run went and "Sync now".
 */
export function SyncRow({
  entry,
  storage,
  apply,
  retry,
  sync,
  retrySync
}: StorageProps & {
  entry: SettingEntryV2;
  sync: Loaded<ObsidianSyncStatus>;
  retrySync: () => void;
}) {
  const settings = useSettings();
  const { t } = settings;
  const [choice, setChoice] = useState<ObsidianSyncMode | null>(null);
  const [failed, setFailed] = useState(false);
  const [runFailed, setRunFailed] = useState(false);
  const [starting, setStarting] = useState(false);
  const stored: ObsidianSyncMode =
    storage.status === "ready"
      ? obsidianSyncModeOf(storage.value)
      : syncModeOfValue(settings.describe(entry.id)?.value);
  const mode = choice ?? stored;
  const hasVault = storage.status === "ready" && Boolean(storage.value.obsidianVaultPath?.trim());
  const label = labelOf(t, entry);

  const pick = async (next: ObsidianSyncMode) => {
    if (next === mode) return;
    setChoice(next);
    setFailed(false);
    try {
      apply(await window.app.settings.update(obsidianSyncModePatch(next)));
    } catch {
      setFailed(true);
    } finally {
      setChoice(null);
    }
  };

  const line = sync.status === "ready" ? syncLine(t, mode, sync.value, new Date()) : null;
  const runNow = async () => {
    setStarting(true);
    setRunFailed(false);
    try {
      await window.app.obsidian.startSync();
    } catch {
      setRunFailed(true);
    } finally {
      setStarting(false);
    }
  };

  return (
    <RegistryRow
      entry={entry}
      defaultLabel={t(syncModeLabel.off)}
      control={
        storage.status === "loading" ? (
          <Skeleton className="h-8 w-56 rounded-lg" />
        ) : (
          <ToggleGroup<ObsidianSyncMode>
            label={label}
            value={mode}
            onValueChange={(next) => void pick(next)}
          >
            {obsidianSyncModes.map((value) => (
              <ToggleGroupItem
                key={value}
                value={value}
                disabled={
                  storage.status !== "ready" || (value !== "off" && !hasVault && value !== mode)
                }
              >
                {t(syncModeLabel[value])}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )
      }
      note={
        <div className="grid gap-1.5">
          {storage.status === "failed" ? (
            <ReadProblem
              t={t}
              message={t("settingsIntegrations.sync.readFailed")}
              onRetry={retry}
            />
          ) : storage.status === "ready" && !hasVault && mode === "off" ? (
            <span>{t("settingsIntegrations.sync.needsVault")}</span>
          ) : null}
          {failed ? (
            <StatusLine tone="warn" role="status">
              {t("settingsIntegrations.sync.saveFailed")}
            </StatusLine>
          ) : null}
          {runFailed ? (
            <StatusLine tone="warn" role="status">
              {t("settingsIntegrations.sync.runFailed")}
            </StatusLine>
          ) : null}
          {mode !== "off" && sync.status === "loading" ? <Skeleton className="h-3.5 w-48" /> : null}
          {mode !== "off" && sync.status === "failed" ? (
            <ReadProblem
              t={t}
              message={t("settingsIntegrations.sync.statusFailed")}
              onRetry={retrySync}
            />
          ) : null}
          {line ? (
            <div className="grid gap-1.5">
              <StatusLine tone={line.tone} role="status">
                {line.text}
                {line.canRun ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    <InlineAction size="xs" disabled={starting} onClick={() => void runNow()}>
                      {t("settingsIntegrations.sync.now")}
                    </InlineAction>
                  </>
                ) : null}
              </StatusLine>
              {line.progress !== null ? (
                <div
                  role="progressbar"
                  aria-label={line.text}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(line.progress * 100)}
                  className="h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-soft [box-shadow:inset_0_0_0_1px_var(--border-strong)]"
                >
                  <div
                    className="h-full rounded-full bg-muted-foreground"
                    style={{ width: `${Math.round(line.progress * 100)}%` }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      }
    />
  );
}

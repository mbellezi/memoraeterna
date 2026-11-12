import { useState } from "react";

import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { EvidenceScopePicker } from "../../../components/ask/EvidenceScopePicker";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { ReadProblem, StatusLine, SwitchControl } from "../../SettingControls";
import { RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { labelOf } from "../../settings-model";
import { sourcesText } from "./integrations-model";
import type { WikiHandle } from "./use-integrations-data";

/**
 * Which sources become pages in the vault (Settings › Integrations › Obsidian): how many are chosen,
 * and "Choose sources…", which opens the picker in the row. Nothing is saved until "Save"; an empty
 * choice means every source. Saving queues the projection; it does not touch the vault by itself.
 */
export function WikiScopeRow({
  entry,
  handle,
  vaultBound
}: {
  entry: SettingEntryV2;
  handle: WikiHandle;
  /** `false` when the storage says no vault is chosen yet; `null` while that is not known. */
  vaultBound: boolean | null;
}) {
  const { t } = useSettings();
  const { wiki } = handle;
  const [draft, setDraft] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const scope = wiki.status === "ready" ? wiki.value.scope : null;

  const save = async () => {
    if (!scope || draft === null) return;
    setBusy(true);
    setFailed(false);
    try {
      await window.app.obsidian.saveWikiScope({
        sourceIds: draft,
        includeDescendants: scope.includeDescendants
      });
      handle.set(await window.app.obsidian.wikiStatus());
      setDraft(null);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <RegistryRow
      entry={entry}
      defaultLabel={sourcesText(t, 0)}
      control={
        <Button
          aria-expanded={draft !== null}
          disabled={!scope || busy || vaultBound !== true}
          onClick={() => setDraft(draft === null ? (scope?.sourceIds ?? []) : null)}
        >
          {t("settingsIntegrations.scope.choose")}
        </Button>
      }
      note={
        <div className="grid gap-2">
          {wiki.status === "loading" ? <Skeleton className="h-3.5 w-40" /> : null}
          {wiki.status === "failed" ? (
            <ReadProblem
              t={t}
              message={t("settingsIntegrations.scope.readFailed")}
              onRetry={handle.reload}
            />
          ) : null}
          {scope ? (
            <span className="text-sm text-foreground">
              {sourcesText(t, scope.sourceIds.length)}
            </span>
          ) : null}
          {draft !== null ? (
            <div className="grid max-w-[34rem] gap-3 rounded-lg border border-border bg-surface p-3">
              <EvidenceScopePicker
                selected={draft}
                onChange={setDraft}
                t={t}
                hint="obsidianWiki.allSources"
              />
              <p className="m-0 text-xs text-muted-foreground">{t("obsidianWiki.topicScope")}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={busy} onClick={() => void save()}>
                  {t("settingsIntegrations.scope.save")}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
                  {t("shell.actions.cancel")}
                </Button>
              </div>
              {failed ? (
                <StatusLine tone="warn" role="status">
                  {t("settingsIntegrations.scope.saveFailed")}
                </StatusLine>
              ) : null}
            </div>
          ) : null}
        </div>
      }
    />
  );
}

/** Whether the chapters and parts of each chosen source come along; saved as soon as it is flipped. */
export function WikiDescendantsRow({
  entry,
  handle,
  vaultBound
}: {
  entry: SettingEntryV2;
  handle: WikiHandle;
  vaultBound: boolean | null;
}) {
  const { t } = useSettings();
  const { wiki } = handle;
  const [choice, setChoice] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const scope = wiki.status === "ready" ? wiki.value.scope : null;
  const checked = choice ?? scope?.includeDescendants ?? true;

  const flip = async (next: boolean) => {
    if (!scope) return;
    setChoice(next);
    setFailed(false);
    try {
      await window.app.obsidian.saveWikiScope({
        sourceIds: scope.sourceIds,
        includeDescendants: next
      });
      handle.set(await window.app.obsidian.wikiStatus());
    } catch {
      setFailed(true);
    } finally {
      setChoice(null);
    }
  };

  // Without a vault the switch only waits: the Sync row above already says to choose a vault.
  return (
    <RegistryRow
      entry={entry}
      control={
        wiki.status === "loading" ? (
          <Skeleton className="h-5 w-20 rounded-full" />
        ) : (
          // A failed read leaves the switch at its default, out of reach: the Sources row says why.
          <SwitchControl
            t={t}
            label={labelOf(t, entry)}
            checked={checked}
            disabled={!scope || vaultBound !== true}
            onChange={(next) => void flip(next)}
          />
        )
      }
      note={
        failed ? (
          <StatusLine tone="warn" role="status">
            {t("settingsIntegrations.scope.saveFailed")}
          </StatusLine>
        ) : undefined
      }
    />
  );
}

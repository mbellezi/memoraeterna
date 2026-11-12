import { useState } from "react";
import { getLanguageDisplayName, supportedLanguageCodes, type LanguageCode } from "@app/i18n";
import type { MessageKey } from "@app/i18n";
import type { NoteDeciderMode } from "@app/domain";

import type { AppSettingsUpdate } from "../../../../shared/ipc";
import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { PromptsSettingsView } from "../../../components/PromptsSettingsView";
import { InlineAction } from "../../InlineAction";
import { PageRow } from "../../PageRow";
import { RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { helpOf, labelOf } from "../../settings-model";
import { requestSettingsTarget } from "../../settings-target";
import {
  NumberField,
  SettingRange,
  SettingSelect,
  SettingSwitch,
  TextField,
  useHeldValue
} from "./advanced-controls";
import type { MatchingControlSpec } from "./matching-model";

/**
 * The rows of Advanced that are not matching: processing, local models, the decider, the map, the
 * Obsidian folder settings and the prompts page. Each shows the value `settings.describe` read, so
 * the row, its "changed" marker and the way back agree, and writes through the setting's own call.
 */

export type SaveApp = (update: AppSettingsUpdate) => Promise<boolean>;

const numberSpec = (
  min: number,
  max: number,
  step: number
): Pick<MatchingControlSpec, "kind" | "min" | "max" | "step"> => ({
  kind: "integer",
  min,
  max,
  step
});

/** "Minimum words to write a summary": a whole number, 0 turns the limit off. */
export function SummaryWordsRow({ entry, saveApp }: { entry: SettingEntryV2; saveApp: SaveApp }) {
  const settings = useSettings();
  const { t } = settings;
  const saved = settings.describe(entry.id)?.value;
  const [failures, setFailures] = useState(0);
  const value = typeof saved === "number" ? saved : 0;
  return (
    <RegistryRow
      entry={entry}
      control={
        <NumberField
          key={failures}
          id="summaryMinimumWordCount"
          label={labelOf(t, entry)}
          value={value}
          control={numberSpec(0, 1_000, 5)}
          locale={t.locale}
          disabled={typeof saved !== "number"}
          suffix={t("settingsAdvanced.units.words")}
          onCommit={(next) =>
            void saveApp({ summaryMinimumWordCount: next }).then((ok) => {
              if (!ok) setFailures((count) => count + 1);
            })
          }
        />
      }
    />
  );
}

/** "Keep the local search model loaded": a switch; the saved value shows as soon as it is chosen. */
export function KeepLoadedRow({ entry, saveApp }: { entry: SettingEntryV2; saveApp: SaveApp }) {
  const settings = useSettings();
  const { t } = settings;
  const saved = settings.describe(entry.id)?.value;
  const [shown, hold] = useHeldValue(saved === true);
  return (
    <RegistryRow
      entry={entry}
      control={
        <SettingSwitch
          label={labelOf(t, entry)}
          checked={shown}
          disabled={typeof saved !== "boolean"}
          onChange={(next) => {
            hold(next);
            void saveApp({ keepLocalEmbeddingModelsLoaded: next }).then((ok) => {
              if (!ok) hold(null);
            });
          }}
        />
      }
    />
  );
}

const deciderChoices: ReadonlyArray<{
  value: "auto" | NoteDeciderMode;
  label: MessageKey;
  help: MessageKey;
}> = [
  {
    value: "auto",
    label: "settingsAdvanced.decider.auto",
    help: "settingsAdvanced.decider.autoHelp"
  },
  {
    value: "ranker",
    label: "settingsAdvanced.decider.ranker",
    help: "settingsAdvanced.decider.rankerHelp"
  },
  {
    value: "ranker-else-generative",
    label: "settingsAdvanced.decider.rankerElse",
    help: "settingsAdvanced.decider.rankerElseHelp"
  },
  {
    value: "generative",
    label: "settingsAdvanced.decider.generative",
    help: "settingsAdvanced.decider.generativeHelp"
  }
];

/**
 * "Who decides the connections between notes": the choice and, under it, what the chosen option
 * does in one sentence (the judge on a cloud route sends the notes' text out, and says so).
 */
export function DeciderRow({ entry }: { entry: SettingEntryV2 }) {
  const settings = useSettings();
  const { t } = settings;
  const description = settings.describe(entry.id);
  const saved = typeof description?.value === "string" ? description.value : "auto";
  const [shown, hold] = useHeldValue<string>(saved);
  const [failed, setFailed] = useState(false);
  const choice =
    deciderChoices.find((candidate) => candidate.value === shown) ?? deciderChoices[0]!;
  const defaultChoice = deciderChoices.find(
    (candidate) =>
      candidate.value === (typeof description?.default === "string" ? description.default : "auto")
  );
  return (
    <RegistryRow
      entry={entry}
      {...(defaultChoice ? { defaultLabel: t(defaultChoice.label) } : {})}
      control={
        <SettingSelect
          label={labelOf(t, entry)}
          value={shown}
          disabled={description === undefined}
          options={deciderChoices.map((candidate) => ({
            value: candidate.value,
            label: t(candidate.label)
          }))}
          onChange={(next) => {
            hold(next);
            setFailed(false);
            window.app.ai
              .setDeciderMode(next === "auto" ? null : (next as NoteDeciderMode))
              .catch(() => {
                hold(null);
                setFailed(true);
              });
          }}
          width="14rem"
        />
      }
      // The row's own help already explains Automatic, so it has nothing more to say.
      {...(choice.value === "auto" && !failed
        ? {}
        : {
            note: (
              <>
                {choice.value === "auto" ? null : (
                  <span className="block [text-wrap:pretty]">{t(choice.help)}</span>
                )}
                {failed ? (
                  <span role="status" className="mt-1 block">
                    {t("settingsAdvanced.saveFailed")}
                  </span>
                ) : null}
              </>
            )
          })}
    />
  );
}

/** "Graph zoom sensitivity": a slider saved when it is let go. */
export function ZoomRow({ entry, saveApp }: { entry: SettingEntryV2; saveApp: SaveApp }) {
  const settings = useSettings();
  const { t } = settings;
  const saved = settings.describe(entry.id)?.value;
  const [failures, setFailures] = useState(0);
  const format = (value: number) =>
    `${new Intl.NumberFormat(t.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}×`;
  const fallback = settings.describe(entry.id)?.default;
  return (
    <RegistryRow
      entry={entry}
      {...(typeof fallback === "number" ? { defaultLabel: format(fallback) } : {})}
      control={
        <SettingRange
          key={failures}
          label={labelOf(t, entry)}
          value={typeof saved === "number" ? saved : 1}
          min={0.5}
          max={1.5}
          step={0.1}
          format={format}
          disabled={typeof saved !== "number"}
          onCommit={(next) =>
            void saveApp({ graphWheelZoomSensitivity: Math.round(next * 10) / 10 }).then((ok) => {
              if (!ok) setFailures((count) => count + 1);
            })
          }
        />
      }
    />
  );
}

/** A folder name inside the vault: not empty, not absolute, no `..`; the main process checks it again. */
export const validManagedRoot = (text: string): boolean => {
  const value = text.trim();
  return (
    value !== "" &&
    !value.startsWith("/") &&
    !value.includes("\0") &&
    !value.split(/[\\/]/u).some((part) => part === "..")
  );
};

/** "Memora's folder in the vault": text saved on Enter or on leaving; a refused name says so. */
export function ManagedRootRow({ entry }: { entry: SettingEntryV2 }) {
  const settings = useSettings();
  const { t } = settings;
  const saved = settings.describe(entry.id)?.value;
  const [failed, setFailed] = useState(false);
  const [failures, setFailures] = useState(0);
  return (
    <RegistryRow
      entry={entry}
      control={
        <TextField
          key={failures}
          id="managedRoot"
          label={labelOf(t, entry)}
          value={typeof saved === "string" ? saved : ""}
          disabled={typeof saved !== "string"}
          valid={validManagedRoot}
          onCommit={(next) => {
            setFailed(false);
            window.app.settings.update({ managedRoot: next }).catch(() => {
              setFailed(true);
              setFailures((count) => count + 1);
            });
          }}
        />
      }
      note={
        failed ? (
          <span role="status">{t("settingsAdvanced.rootFailed")}</span>
        ) : (
          <span>{t("settingsAdvanced.rootHint")}</span>
        )
      }
    />
  );
}

type Preparing = "idle" | "working" | "prepared" | "failed";

/**
 * "Language of the vault's folders": follows the notes' language until the person picks another. A
 * choice does not move anything: it prepares the journaled move of the vault's folders, which the
 * person reviews and applies in Integrations, with the editors closed.
 */
export function LayoutLanguageRow({ entry }: { entry: SettingEntryV2 }) {
  const settings = useSettings();
  const { t } = settings;
  const saved = settings.describe(entry.id);
  const hasVault = settings.describe("obsidianVaultPath")?.value === true;
  const attachments =
    settings.describe("obsidian.layout.attachments")?.value === "copy" ? "copy" : "omit";
  const language = typeof saved?.value === "string" ? saved.value : "";
  const [preparing, setPreparing] = useState<Preparing>("idle");
  const followed = typeof saved?.default === "string" ? saved.default : null;
  const name = (code: string) => getLanguageDisplayName(t.locale, code);
  const choose = (next: string) => {
    setPreparing("working");
    window.app.obsidian
      .previewLayout({ version: 2, language: next as LanguageCode, attachments })
      .then(() => setPreparing("prepared"))
      .catch(() => setPreparing("failed"));
  };
  return (
    <RegistryRow
      entry={entry}
      {...(followed
        ? {
            defaultLabel: t("settingsAdvanced.layout.followsNotes", {
              values: { language: name(followed) }
            })
          }
        : {})}
      control={
        <SettingSelect
          label={labelOf(t, entry)}
          value={language}
          disabled={!hasVault || saved === undefined || preparing === "working"}
          options={supportedLanguageCodes.map((code) => ({ value: code, label: name(code) }))}
          onChange={choose}
          width="12rem"
        />
      }
      note={
        <>
          <span className="block [text-wrap:pretty]">
            {!hasVault
              ? t("settingsAdvanced.layout.noVault")
              : preparing === "working"
                ? t("settingsAdvanced.layout.preparing")
                : preparing === "prepared"
                  ? t("settingsAdvanced.layout.prepared")
                  : preparing === "failed"
                    ? t("settingsAdvanced.layout.failed")
                    : t("settingsAdvanced.layout.hint")}
          </span>
          {!hasVault || preparing === "prepared" ? (
            <InlineAction
              size="xs"
              className="mt-1"
              onClick={() => requestSettingsTarget({ section: "integrations" })}
            >
              {t("settingsAdvanced.layout.openIntegrations")}
            </InlineAction>
          ) : null}
        </>
      }
    />
  );
}

/** The prompts: the page opens in place; the editor itself mounts only when asked for. */
export function PromptsRow({ entry }: { entry: SettingEntryV2 }) {
  const { t } = useSettings();
  const [editing, setEditing] = useState(false);
  return (
    <PageRow id={entry.id} label={labelOf(t, entry)} help={helpOf(t, entry)}>
      {editing ? (
        <div className="grid gap-3">
          <div>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              {t("settingsAdvanced.prompts.close")}
            </Button>
          </div>
          <PromptsSettingsView t={t} language={t.locale} />
        </div>
      ) : (
        <div className="grid justify-items-start gap-3">
          <p className="m-0 max-w-[27.5rem] text-sm text-secondary-foreground [text-wrap:pretty]">
            {t("settingsAdvanced.prompts.body")}
          </p>
          <Button onClick={() => setEditing(true)}>{t("settingsAdvanced.prompts.open")}</Button>
        </div>
      )}
    </PageRow>
  );
}

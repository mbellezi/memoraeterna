import { useEffect, type ReactNode } from "react";
import type { MessageKey } from "@app/i18n";

import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { DiagnosticsGroup } from "../../diagnostics/DiagnosticsGroup";
import { RegistryRow, ReadOnlyValue } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { groupLabelOf, groupsOf } from "../../settings-model";
import type { SettingsSectionModule } from "../../sections-registry";
import {
  DeciderRow,
  KeepLoadedRow,
  LayoutLanguageRow,
  ManagedRootRow,
  PromptsRow,
  SummaryWordsRow,
  ZoomRow,
  type SaveApp
} from "./AdvancedRows";
import { MatchingGroup } from "./MatchingGroup";
import { useAppSettings, type AppSettingsState } from "./use-app-settings";

/** The sentence under a group's name, where the group needs one. */
const groupIntro: Readonly<Record<string, MessageKey>> = {
  matching: "settingsAdvanced.groups.matchingIntro",
  diagnostics: "settingsAdvanced.groups.diagnosticsIntro"
};

/**
 * Groups that hold one row or two read as one group on the page (the registry keeps its own groups,
 * which search names): the processing values, the local-model value, the decider and the model
 * instructions all steer how the models work.
 */
const foldedInto: Readonly<Record<string, string>> = {
  localModels: "processing",
  connections: "processing",
  prompts: "processing"
};
const foldedLabel: Readonly<Record<string, MessageKey>> = {
  processing: "settingsAdvanced.groups.processingModels"
};

function displayGroupsOf(section: Parameters<typeof groupsOf>[0]) {
  const shown: ReturnType<typeof groupsOf> = [];
  for (const { group, entries } of groupsOf(section)) {
    const target = foldedInto[group] ?? group;
    const found = shown.find((candidate) => candidate.group === target);
    if (found) found.entries.push(...entries);
    else shown.push({ group: target, entries: [...entries] });
  }
  return shown;
}

/** The row of each setting that is not a matching value or a diagnostic. */
function plainRow(entry: SettingEntryV2, saveApp: SaveApp): ReactNode {
  switch (entry.id) {
    case "summaryMinimumWordCount":
      return <SummaryWordsRow key={entry.id} entry={entry} saveApp={saveApp} />;
    case "keepLocalEmbeddingModelsLoaded":
      return <KeepLoadedRow key={entry.id} entry={entry} saveApp={saveApp} />;
    case "relations.deciderMode":
      return <DeciderRow key={entry.id} entry={entry} />;
    case "graphWheelZoomSensitivity":
      return <ZoomRow key={entry.id} entry={entry} saveApp={saveApp} />;
    case "managedRoot":
      return <ManagedRootRow key={entry.id} entry={entry} />;
    case "obsidian.layout.language":
      return <LayoutLanguageRow key={entry.id} entry={entry} />;
    case "advanced.prompts":
      return <PromptsRow key={entry.id} entry={entry} />;
    default:
      // A setting the registry gained that this section has no control for shows what can be said of it.
      return <RegistryRow key={entry.id} entry={entry} control={<ReadOnlyValue entry={entry} />} />;
  }
}

/**
 * The body of Advanced (design record §7.6): one line on why it is rarely needed, then the registry's
 * groups in the registry's order: Matching, Processing and models (the registry's Processing, Local
 * models, Connections and Prompts), Map, Obsidian and Diagnostics. The rows are the registry's, so what the section shows and what Settings
 * search finds are the same list. It takes the app settings as a prop so a test can hand a fake.
 */
export function AdvancedBody({ app }: { app: AppSettingsState }) {
  const { t, section, rowsChanged } = useSettings();
  // The matching rows exist only once the presets are read: a link or a search result that asked
  // for one of them is answered then, not when this section was mounted.
  useEffect(() => {
    if (app.status === "ready") rowsChanged();
  }, [app.status, rowsChanged]);
  const saveApp: SaveApp = (update) => app.save(update);
  return (
    <>
      <p className="m-0 mt-3 max-w-[32rem] text-sm text-secondary-foreground [text-wrap:pretty]">
        {t("settingsAdvanced.intro")}
      </p>
      {displayGroupsOf(section).map(({ group, entries }, index) => {
        const intro = groupIntro[group];
        return (
          <section key={group} aria-labelledby={`settings-group-${section}-${group}`}>
            <h3
              id={`settings-group-${section}-${group}`}
              className={`m-0 text-sm font-semibold text-foreground ${index === 0 ? "mt-8" : "mt-10"}`}
            >
              {foldedLabel[group] ? t(foldedLabel[group]) : groupLabelOf(t, section, group)}
            </h3>
            {intro ? (
              <p className="m-0 mt-1 max-w-[27.5rem] text-sm text-secondary-foreground [text-wrap:pretty]">
                {t(intro)}
              </p>
            ) : null}
            <div>
              {group === "matching" ? (
                <MatchingGroup entries={entries} app={app} />
              ) : group === "diagnostics" ? (
                <DiagnosticsGroup entries={entries} saveApp={saveApp} />
              ) : (
                entries.map((entry) => plainRow(entry, saveApp))
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}

function AdvancedSection() {
  return <AdvancedBody app={useAppSettings()} />;
}

export const section: SettingsSectionModule = { id: "advanced", Section: AdvancedSection };

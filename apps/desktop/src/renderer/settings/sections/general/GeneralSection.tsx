import type { LanguageCode } from "@app/i18n";

import type { AppSettingsUpdate, ThemeMode } from "../../../../shared/ipc";
import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import { InlineAction } from "../../InlineAction";
import { RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { labelOf } from "../../settings-model";
import { requestSettingsTarget } from "../../settings-target";
import {
  contentLanguageOptions,
  isLanguageCode,
  isThemeMode,
  languageName,
  languageNameFor,
  languageOptions,
  themeModes
} from "./general-model";
import { BarsGroup, BarsRow } from "../../SectionBars";
import { RegistrySection, type EntryRow } from "./registry-section";
import { SettingSelect, useSavedChoice } from "./setting-controls";

const saveApp = (update: AppSettingsUpdate) => window.app.settings.updateApp(update);

/** The line a failed save leaves in its row: one plain sentence, nothing was changed. */
export function SaveFailedNote({ failed }: { failed: boolean }) {
  const { t } = useSettings();
  return failed ? (
    <span role="status" className="block text-secondary-foreground">
      {t("settingsGeneral.saveFailed")}
    </span>
  ) : null;
}

function ThemeRow({ entry }: { entry: SettingEntryV2 }) {
  const { t, describe } = useSettings();
  const choice = useSavedChoice<ThemeMode>("themeMode", (themeMode) => saveApp({ themeMode }));
  const label = (mode: ThemeMode) => t(`settingsGeneral.theme.${mode}`);
  const described = describe(entry.id)?.default;
  // The default comes from the registry's description; dark is the app's default theme.
  const fallback: ThemeMode = isThemeMode(described) ? described : "dark";
  const value = isThemeMode(choice.value) ? choice.value : fallback;
  return (
    <RegistryRow
      entry={entry}
      defaultLabel={label(fallback)}
      note={<SaveFailedNote failed={choice.state === "failed"} />}
      control={
        <ToggleGroup label={labelOf(t, entry)} value={value} onValueChange={choice.save}>
          {themeModes.map((mode) => (
            <ToggleGroupItem key={mode} value={mode}>
              {label(mode)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
    />
  );
}

/** A language select: the app's, or the one the notes are written in. Both default to macOS's. */
function LanguageRow({ entry, afterChange }: { entry: SettingEntryV2; afterChange?: boolean }) {
  const { t, describe } = useSettings();
  const key = entry.id === "language" ? "language" : "contentLanguage";
  const choice = useSavedChoice<LanguageCode>(entry.id, (code) => saveApp({ [key]: code }));
  const description = describe(entry.id);
  const value = isLanguageCode(choice.value) ? choice.value : "en";
  const fallback = description?.default;
  // The app's language is named by its own name; the notes' language reads in the window's language.
  const notes = entry.id === "contentLanguage";
  const defaultLabel = isLanguageCode(fallback)
    ? t("settingsGeneral.language.defaultOs", {
        values: { language: notes ? languageNameFor(fallback, t.locale) : languageName(fallback) }
      })
    : undefined;
  return (
    <RegistryRow
      entry={entry}
      {...(defaultLabel !== undefined ? { defaultLabel } : {})}
      note={
        <>
          <SaveFailedNote failed={choice.state === "failed"} />
          {afterChange && description?.changed ? <ConnectionsNote /> : null}
        </>
      }
      control={
        <SettingSelect
          label={labelOf(t, entry)}
          value={value}
          options={notes ? contentLanguageOptions(t.locale) : languageOptions()}
          onChange={choice.save}
        />
      }
    />
  );
}

/** Notes already written keep their language: where to have the connection descriptions redone. */
function ConnectionsNote() {
  const { t } = useSettings();
  const where = `${t("settingsShell.sections.knowledge.name")} › ${t("settingsRegistry.groups.knowledge.connections")}`;
  return (
    <span className="block">
      {t("settingsGeneral.language.connectionsNote")}{" "}
      <InlineAction
        size="xs"
        onClick={() => requestSettingsTarget({ section: "knowledge", setting: "relationLabels" })}
      >
        {where}
      </InlineAction>
    </span>
  );
}

const rows: Readonly<Record<string, EntryRow>> = {
  themeMode: ThemeRow,
  contentLanguage: ({ entry }) => <LanguageRow entry={entry} afterChange />,
  language: LanguageRow
};

/**
 * General and appearance (design record 7.6, docs/f5-decisions.md D17): the theme, the notes'
 * language (one control, defaulting to the macOS language) and the app's language, drawn from the
 * registry. There is no density, "open in" or reduced-motion row: they are not settings in F5 (S13).
 */
export function GeneralSection() {
  return <RegistrySection rows={rows} />;
}

/** What General looks like while it loads: the theme's segmented control, then two selects. */
function GeneralBars() {
  return (
    <>
      <BarsGroup first width="w-24" />
      <BarsRow label="w-16" help="w-64" control="w-60" />
      <BarsGroup width="w-20" />
      <BarsRow label="w-36" help="w-80" control="w-44" />
      <BarsRow label="w-32" help="w-72" control="w-44" />
    </>
  );
}

export const section = { id: "general", Section: GeneralSection, Skeleton: GeneralBars } as const;

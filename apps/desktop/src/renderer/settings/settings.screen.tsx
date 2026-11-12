import { useEffect, useState, type ChangeEvent } from "react";
import { ChevronDown } from "lucide-react";
import { getLanguageDisplayName, type LanguageCode } from "@app/i18n";

import type { SettingDescription } from "../../shared/ipc-settings-describe";
import { settingsRegistryV2, type Json } from "../../shared/settings-registry";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { screenTranslator } from "../workspace/screen-locale";
import type { ScreenModule } from "../workspace/surfaces";
import { RegistryRow } from "./SettingRow";
import { useSettings } from "./settings-context";
import { groupLabelOf, groupsOf } from "./settings-model";
import { SettingsSurface } from "./SettingsSurface";

/** Settings fills the content area of the window: the rail's width stands empty beside it. */
export const fullWindow = true;

export const surface = "settings";

const t = screenTranslator();
const noop = () => undefined;

/**
 * What `settings.describe` answers: every entry that stores something, at its default, except the
 * ones the fixture changes, so the section column shows a dot and a count in Knowledge, Integrations
 * and Advanced besides General, as the design does.
 */
const values: Record<string, { value: Json; default: Json | null }> = {
  themeMode: { value: "system", default: "system" },
  contentLanguage: { value: "en", default: "pt-BR" },
  language: { value: "pt-BR", default: "pt-BR" },
  "knowledge.controls.v1.monthlyCapUsd": { value: 12, default: 5 },
  obsidianSync: { value: "on", default: "off" },
  obsidianVaultPath: { value: true, default: null },
  activeMatchingPresetId: { value: "custom", default: "balanced" },
  debugMode: { value: true, default: false },
  graphWheelZoomSensitivity: { value: 1.6, default: 1 }
};
const changedIds = new Set(
  Object.keys(values).filter((id) => id !== "themeMode" && id !== "language")
);

function describeEntries(): SettingDescription[] {
  return settingsRegistryV2
    .filter((entry) => entry.store.kind !== "none")
    .map((entry) => {
      const known = values[entry.id];
      const value: Json = known?.value ?? (entry.control === "switch" ? false : null);
      return {
        id: entry.id,
        value,
        default: known ? known.default : value,
        changed: changedIds.has(entry.id)
      };
    });
}

export const fixtures: ScreenModule["fixtures"] = {
  success: { "settings.describe": { entries: describeEntries() } },
  // "Nothing found": the surface starts from a search that no setting answers.
  empty: { "settings.describe": { entries: [] } }
};

const selectClass =
  "h-8 w-56 max-w-full appearance-none rounded-md border border-border-strong bg-surface bg-[length:1rem] px-3 pr-8 text-sm text-foreground hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function LanguageSelect({ id, label }: { id: string; label: string }) {
  const { describe } = useSettings();
  const [value, setValue] = useState(String(describe(id)?.value ?? "pt-BR"));
  const languages: LanguageCode[] = ["en", "pt-BR", "es", "fr", "it"];
  return (
    <span className="relative inline-flex max-w-full">
      <select
        aria-label={label}
        value={value}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => setValue(event.target.value)}
        className={selectClass}
      >
        {languages.map((code) => (
          <option key={code} value={code}>
            {getLanguageDisplayName(t.locale, code)}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-2 size-4 text-secondary-foreground"
      />
    </span>
  );
}

/**
 * The General section as T162 will write it, with the real rows over the real controls: only the
 * screen module has it, so this surface can be seen with a section that is complete. The other
 * sections show the registry's rows read-only until their cards land.
 */
function DemoGeneral() {
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const section = "general" as const;
  return (
    <>
      {groupsOf(section).map(({ group, entries }, index) => (
        <section key={group}>
          <h3
            className={`m-0 text-sm font-semibold text-foreground ${index === 0 ? "mt-8" : "mt-10"}`}
          >
            {groupLabelOf(t, section, group)}
          </h3>
          {entries.map((entry) =>
            entry.id === "themeMode" ? (
              <RegistryRow
                key={entry.id}
                entry={entry}
                control={
                  <ToggleGroup
                    label={t("settingsRegistry.themeMode.label")}
                    value={theme}
                    onValueChange={setTheme}
                  >
                    {(["system", "light", "dark"] as const).map((mode) => (
                      <ToggleGroupItem key={mode} value={mode}>
                        {t(`settings.appearance.themeModes.${mode}`)}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                }
              />
            ) : (
              <RegistryRow
                key={entry.id}
                entry={entry}
                defaultLabel={getLanguageDisplayName(t.locale, "pt-BR")}
                control={<LanguageSelect id={entry.id} label={t(entry.labelKey as never)} />}
              />
            )
          )}
        </section>
      ))}
    </>
  );
}

const demoSections = { general: { id: "general" as const, Section: DemoGeneral } };

/**
 * The real surface. In the "empty" mode (the fixture holds no saved values at all) it starts from a
 * search that nothing answers, which is what the empty state of Settings is; the mode is read from
 * the fake `window.app` once, and the surface is remounted with the answer.
 */
function Screen() {
  const [query, setQuery] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.app.settings
      .describe()
      .then((result) => live && setQuery(result.entries.length === 0 ? "impressora" : ""))
      .catch(() => live && setQuery(""));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="h-screen bg-background text-foreground">
      <SettingsSurface
        key={query ?? "waiting"}
        t={t}
        initialQuery={query ?? ""}
        sections={demoSections}
        onOpenClassic={noop}
      />
    </div>
  );
}

export function render() {
  return <Screen />;
}

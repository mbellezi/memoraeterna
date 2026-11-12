import { useEffect, useState } from "react";

import type { SettingDescription } from "../../shared/ipc-settings-describe";
import { settingsRegistryV2, type Json } from "../../shared/settings-registry";
import { screenTranslator } from "../workspace/screen-locale";
import type { ScreenModule } from "../workspace/surfaces";
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
  themeMode: { value: "dark", default: "dark" },
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

/**
 * The real surface, with the sections the app has: a section without a file of its own (T162-T165)
 * shows the registry's rows read-only here, exactly as it does in the app, and a section card that
 * lands shows its own body in this screen without an edit. In the "empty" mode (the fixture holds no saved values at all) it starts from a
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
        onOpenClassic={noop}
      />
    </div>
  );
}

export function render() {
  return <Screen />;
}

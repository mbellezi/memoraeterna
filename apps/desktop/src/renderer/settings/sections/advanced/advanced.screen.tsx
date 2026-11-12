import { useEffect, useState } from "react";
import { recommendedMatchingConfiguration } from "@app/domain";

import { defaultAppSettings, type AppSettings } from "../../../../shared/ipc";
import type { SettingDescription } from "../../../../shared/ipc-settings-describe";
import { settingsRegistryV2, type Json } from "../../../../shared/settings-registry";
import { screenTranslator } from "../../../workspace/screen-locale";
import type { ScreenModule } from "../../../workspace/surfaces";
import { SettingsSurface } from "../../SettingsSurface";
import { section } from "./AdvancedSection";

/** Settings fills the content area of the window: the rail's width stands empty beside it. */
export const fullWindow = true;

export const surface = "settings-advanced";

const t = screenTranslator();
const noop = () => undefined;

const customPresetId = "9d1c5a2e-4b1f-4d6a-9b0e-3f5c7a1d2e40";
const customSettings = {
  ...recommendedMatchingConfiguration,
  sourceRelationSettings: {
    ...recommendedMatchingConfiguration.sourceRelationSettings,
    minConfidence: 0.8
  }
};

/** The app settings: a saved preset is selected, and one of its values is away from the calibrated set. */
export const appSettings: AppSettings = {
  ...defaultAppSettings,
  ...customSettings,
  language: t.locale,
  matchingPresets: [{ id: customPresetId, name: "Teste de confiança", settings: customSettings }],
  activeMatchingPresetId: customPresetId,
  debugMode: true,
  graphWheelZoomSensitivity: 1.6,
  updatedAt: "2026-11-12T09:00:00.000Z"
};

/** What `settings.describe` answers: every stored entry at its default, but the ones this screen changes. */
const values: Record<string, { value: Json; default: Json | null }> = {
  activeMatchingPresetId: { value: customPresetId, default: "recommended-v2" },
  "sourceRelationSettings.minConfidence": { value: 0.8, default: 0.85 },
  debugMode: { value: true, default: false },
  graphWheelZoomSensitivity: { value: 1.6, default: 1 },
  summaryMinimumWordCount: { value: 40, default: 40 },
  keepLocalEmbeddingModelsLoaded: { value: true, default: true },
  obsidianVaultPath: { value: true, default: null },
  "obsidian.layout.language": { value: "pt-BR", default: "pt-BR" },
  managedRoot: { value: "Memora", default: "Memora" },
  "relations.deciderMode": { value: null, default: null }
};
const changedIds = new Set([
  "activeMatchingPresetId",
  "sourceRelationSettings.minConfidence",
  "debugMode",
  "graphWheelZoomSensitivity"
]);

export function describeEntries(): SettingDescription[] {
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
  success: { "settings.describe": { entries: describeEntries() }, "settings.getApp": appSettings },
  // "Nothing found": the surface starts from a search that no setting answers.
  empty: { "settings.describe": { entries: [] }, "settings.getApp": appSettings }
};

/**
 * The real surface at Advanced and diagnostics. The empty state is the surface's own (a search that
 * nothing answers), as in the Settings screen: the mode is read from the fake `window.app` once.
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
        surface={surface}
        initialSection="advanced"
        sections={{ advanced: section }}
        initialQuery={query ?? ""}
        onOpenClassic={noop}
      />
    </div>
  );
}

export function render() {
  return <Screen />;
}

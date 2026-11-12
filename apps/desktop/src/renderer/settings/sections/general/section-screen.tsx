import { useEffect, useState } from "react";

import type { SettingDescription } from "../../../../shared/ipc-settings-describe";
import { settingsRegistryV2, type Json } from "../../../../shared/settings-registry";
import { screenTranslator } from "../../../workspace/screen-locale";
import { SettingsSurface } from "../../SettingsSurface";
import type { SettingsSectionId } from "../../settings-model";

/**
 * What `settings.describe` answers on a section's screen: every entry that stores something, at its
 * default, except the ones `values` names. `changed` entries carry the marker; a value of `null`
 * stands for a folder or a key that is not set.
 */
export function describeFixture(
  values: Readonly<Record<string, { value: Json; default: Json | null; changed?: boolean }>>
): { entries: SettingDescription[] } {
  return {
    entries: settingsRegistryV2
      .filter((entry) => entry.reset !== "none")
      .map((entry) => {
        const known = values[entry.id];
        const value: Json = known?.value ?? (entry.control === "switch" ? false : null);
        return {
          id: entry.id,
          value,
          default: known ? known.default : value,
          changed: known?.changed ?? false
        };
      })
  };
}

/**
 * A section's screen: the real Settings surface open on that section, with the real section inside.
 * In the "empty" mode (the fake `describe` holds nothing) it starts from a search that nothing
 * answers, which is the empty state of Settings; the mode is read from the fake `window.app` once and
 * the surface is mounted with the answer. The frame writes `data-surface` and `data-state`.
 */
export function SectionScreen({
  surface,
  section
}: {
  surface: string;
  section: SettingsSectionId;
}) {
  const t = screenTranslator();
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
        initialSection={section}
        initialQuery={query ?? ""}
      />
    </div>
  );
}

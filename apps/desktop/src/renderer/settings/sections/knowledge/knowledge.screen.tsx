import { useEffect, useState } from "react";

import type { SettingDescription } from "../../../../shared/ipc-settings-describe";
import { settingsRegistryV2, type Json } from "../../../../shared/settings-registry";
import { screenTranslator } from "../../../workspace/screen-locale";
import type { ScreenModule } from "../../../workspace/surfaces";
import { SettingsSurface } from "../../SettingsSurface";

/** Settings fills the content area of the window: the rail's width stands empty beside it. */
export const fullWindow = true;

export const surface = "settings-knowledge";

const t = screenTranslator();
const noop = () => undefined;

/**
 * What the Knowledge section reads, over a library whose owner raised the monthly cap: the six
 * controls, the month's spend, the Gardener at work and no description job yet.
 */
const controls = {
  autonomy: "auto",
  monthlyCapUsd: 12,
  paused: false,
  treeShape: "balanced",
  onlyIdle: false,
  onlyOnAc: false
};
const defaults = { ...controls, monthlyCapUsd: 5 };

function describeEntries(): SettingDescription[] {
  return settingsRegistryV2
    .filter((entry) => entry.store.kind !== "none")
    .map((entry) => {
      const field = entry.id.startsWith("knowledge.controls.v1.")
        ? (entry.id.slice("knowledge.controls.v1.".length) as keyof typeof controls)
        : null;
      const value: Json = field ? controls[field] : entry.control === "switch" ? false : null;
      const fallback: Json = field ? defaults[field] : value;
      return { id: entry.id, value, default: fallback, changed: value !== fallback };
    });
}

const money = {
  spentUsd: 3.1,
  reservedUsd: 0,
  capUsd: 12,
  pauseShare: 0.8,
  continued: false,
  state: "open",
  priceTableVersion: "fixture"
};

const shared = {
  "settings.describe": { entries: describeEntries() },
  "knowledgeControls.get": controls,
  "budget.snapshot": { money },
  "gardener.status": {
    state: "running",
    params: {},
    coverage: { placed: 0.92, matched: 0.8, overviewsFresh: 0.7 }
  },
  "knowledge.relationLabelsStatus": null,
  "settings.getApp": { contentLanguage: "pt-BR" }
};

export const fixtures: ScreenModule["fixtures"] = {
  success: shared,
  // "Nothing found": the surface starts from a search that no setting answers.
  empty: { "settings.describe": { entries: [] } }
};

/**
 * The real surface on the Knowledge section. In the "empty" mode (the fixture holds no saved values
 * at all) it starts from a search that nothing answers, which is Settings' own empty state; the
 * mode is read from the fake `window.app` once and the surface is remounted with the answer.
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
        initialSection="knowledge"
        initialQuery={query ?? ""}
        onOpenClassic={noop}
      />
    </div>
  );
}

export function render() {
  return <Screen />;
}

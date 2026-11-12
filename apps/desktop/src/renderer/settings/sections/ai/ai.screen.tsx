import { useEffect, useState } from "react";

import { screenTranslator } from "../../../workspace/screen-locale";
import type { ScreenModule } from "../../../workspace/surfaces";
import { SettingsSurface } from "../../SettingsSurface";
import { aiCalls } from "./ai-fixtures";
import { section } from "./AiSection";

/** Settings fills the content area of the window: the rail's width stands empty beside it. */
export const fullWindow = true;

export const surface = "settings-ai";

const t = screenTranslator();
const noop = () => undefined;

/**
 * Hybrid on a Mac with Apple silicon and 32 GB: a ChatGPT sign-in and a compatible key saved, the
 * local embedder and ranker installed, a writer downloading. One route is on another model than its
 * setup gives (the "changed" marker, the default and the way back), and the two credentials read as
 * saved. "Nothing found" starts from a search that no setting answers, as the Settings frame does.
 */
export const fixtures: ScreenModule["fixtures"] = {
  success: aiCalls(),
  empty: { "settings.describe": { entries: [] } }
};

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
        surface="settings-ai"
        initialSection="ai"
        initialQuery={query ?? ""}
        sections={{ ai: section }}
        onOpenClassic={noop}
      />
    </div>
  );
}

export function render() {
  return <Screen />;
}

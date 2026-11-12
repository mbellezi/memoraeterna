import { createContext, useContext } from "react";
import type { Translator } from "@app/i18n";

import type { SettingDescription } from "../../shared/ipc-settings-describe";
import type { SettingsSectionId } from "./settings-model";
import type { ResetOutcome, RowReset } from "./settings-store";

/**
 * What a section of Settings v2 reads from the surface: the translator, the answer of
 * `settings.describe` (null while the first read is on its way), each row's reset state, the row the
 * person was just taken to, and `reset`. A section never calls `window.app.settings` for these: a
 * reset that goes through here updates every marker and count at once.
 */
export interface SettingsContextValue {
  t: Translator;
  section: SettingsSectionId;
  /** The saved value, the default and whether they differ, by registry id; null until read. */
  describe: (id: string) => SettingDescription | undefined;
  read: "loading" | "error" | "ready";
  /**
   * Settings is on screen. It stays mounted while another place is shown, so a section that reads
   * more than `describe` (a count, a status) reads again when this turns true, and listens to
   * nothing while it is false.
   */
  active: boolean;
  rowState: (id: string) => RowReset;
  /** The row highlighted for 2 s after a link or a search result took the person to it. */
  highlighted: string | null;
  reset: (id: string, confirmed?: boolean) => Promise<ResetOutcome>;
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("A Settings section renders inside the Settings surface");
  return value;
}

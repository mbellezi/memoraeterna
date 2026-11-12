import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import type { SettingDescription } from "../../../../shared/ipc-settings-describe";
import type { SettingRowProps } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { helpOf, labelOf, resetNeedsConfirm } from "../../settings-model";

/**
 * What every row of the section takes from Settings for one registry entry: the registry's label and
 * help, whether it differs from its default (from `settings.describe`), whether the person was just
 * taken to it, where its reset stands and the reset itself. A row adds its control, its default in
 * words and what it says under the help.
 */
export function useRowProps(
  entry: SettingEntryV2,
  options: { withReset?: boolean } = {}
): Pick<
  SettingRowProps,
  "t" | "id" | "label" | "help" | "changed" | "reset" | "highlighted" | "onReset" | "confirmReset"
> & { description: SettingDescription | undefined } {
  const settings = useSettings();
  const { t } = settings;
  const description = settings.describe(entry.id);
  const withReset = options.withReset ?? entry.reset !== "none";
  return {
    t,
    id: entry.id,
    label: labelOf(t, entry),
    help: helpOf(t, entry),
    changed: description?.changed === true,
    reset: settings.rowState(entry.id),
    highlighted: settings.highlighted === entry.id,
    onReset: withReset ? () => void settings.reset(entry.id, resetNeedsConfirm(entry)) : undefined,
    confirmReset: resetNeedsConfirm(entry),
    description
  };
}

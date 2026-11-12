import { RegistryRow, ReadOnlyValue } from "./SettingRow";
import { useSettings } from "./settings-context";
import { groupLabelOf, groupsOf } from "./settings-model";

/**
 * A section whose own controls are not built yet: the registry's groups and rows in the registry's
 * order, each with its label, help, "changed" marker and way back to the default, and only what can
 * be said of its value without knowing the options. It stands in until the section's card lands.
 */
export function GenericSection() {
  const { t, section } = useSettings();
  return (
    <>
      {groupsOf(section).map(({ group, entries }, index) => (
        <section key={group} aria-labelledby={`settings-group-${section}-${group}`}>
          <h3
            id={`settings-group-${section}-${group}`}
            className={`m-0 text-sm font-semibold text-foreground ${index === 0 ? "mt-8" : "mt-10"}`}
          >
            {groupLabelOf(t, section, group)}
          </h3>
          <div>
            {entries.map((entry) => (
              <RegistryRow key={entry.id} entry={entry} control={<ReadOnlyValue entry={entry} />} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

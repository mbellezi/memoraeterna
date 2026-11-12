import type { ComponentType } from "react";

import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { ReadOnlyValue, RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { groupLabelOf, groupsOf } from "../../settings-model";

/** A component that draws the row of one registry entry, with its own control. */
export type EntryRow = ComponentType<{ entry: SettingEntryV2 }>;

/**
 * A section drawn from the registry: its groups in the registry's order, each with its name and its
 * rows. The row of an entry is the component `rows` names for its id; an entry with no component (one
 * the registry gains later) still appears, as the generic read-only row, so a section never loses a
 * setting and never shows one the registry does not have.
 */
export function RegistrySection({
  rows,
  skipHeadings = []
}: {
  rows: Readonly<Record<string, EntryRow>>;
  /** Groups whose only row carries the group's own name: the heading would say it twice. */
  skipHeadings?: readonly string[];
}) {
  const { t, section } = useSettings();
  return (
    <>
      {groupsOf(section).map(({ group, entries }, index) => {
        const headingId = `settings-group-${section}-${group}`;
        const heading = !skipHeadings.includes(group);
        return (
          <section
            key={group}
            {...(heading
              ? { "aria-labelledby": headingId }
              : { "aria-label": groupLabelOf(t, section, group) })}
            className={heading ? undefined : index === 0 ? "mt-4" : "mt-6"}
          >
            {heading ? (
              <h3
                id={headingId}
                className={`m-0 text-sm font-semibold text-foreground ${index === 0 ? "mt-8" : "mt-10"}`}
              >
                {groupLabelOf(t, section, group)}
              </h3>
            ) : null}
            <div>
              {entries.map((entry) => {
                const Row = rows[entry.id];
                return Row ? (
                  <Row key={entry.id} entry={entry} />
                ) : (
                  <RegistryRow
                    key={entry.id}
                    entry={entry}
                    control={<ReadOnlyValue entry={entry} />}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}

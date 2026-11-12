import type { MessageKey, Translator } from "@app/i18n";

import type { SettingDescription } from "../../shared/ipc-settings-describe";
import {
  settingSlug,
  settingsRegistryV2,
  type SettingEntryV2
} from "../../shared/settings-registry";
import type { SettingHit } from "../../shared/settings-search";
import { settingsSectionIds, type SettingsSectionId } from "../workspace/route";

/**
 * What Settings v2 shows, as pure functions over the registry v2, the answer of `settings.describe`
 * and the search hits (F5 T161, docs/f5-decisions.md D17, design record §7.6): the order of the
 * sections and their groups, the "changed" counts, the search results grouped by section, the
 * words of a value, the state the surface's frame reports, and the address of a setting.
 */

export { settingsSectionIds, type SettingsSectionId };

export type DescribeIndex = ReadonlyMap<string, SettingDescription>;

/** What a section shows in the navigation: its icon and the copy keys of its name and description. */
export const sectionMeta: Readonly<
  Record<SettingsSectionId, { icon: SectionIcon; name: MessageKey; description: MessageKey }>
> = {
  general: {
    icon: "sliders",
    name: "settingsShell.sections.general.name",
    description: "settingsShell.sections.general.description"
  },
  ai: {
    icon: "cpu",
    name: "settingsShell.sections.ai.name",
    description: "settingsShell.sections.ai.description"
  },
  knowledge: {
    icon: "network",
    name: "settingsShell.sections.knowledge.name",
    description: "settingsShell.sections.knowledge.description"
  },
  library: {
    icon: "library",
    name: "settingsShell.sections.library.name",
    description: "settingsShell.sections.library.description"
  },
  integrations: {
    icon: "plug",
    name: "settingsShell.sections.integrations.name",
    description: "settingsShell.sections.integrations.description"
  },
  privacy: {
    icon: "lock",
    name: "settingsShell.sections.privacy.name",
    description: "settingsShell.sections.privacy.description"
  },
  advanced: {
    icon: "wrench",
    name: "settingsShell.sections.advanced.name",
    description: "settingsShell.sections.advanced.description"
  }
};
export type SectionIcon = "sliders" | "cpu" | "network" | "library" | "plug" | "lock" | "wrench";

/** The copy of an entry, by the keys the registry names (a test holds every key to all 5 locales). */
export const labelOf = (t: Translator, entry: SettingEntryV2): string =>
  t(entry.labelKey as MessageKey);
export const helpOf = (t: Translator, entry: SettingEntryV2): string =>
  t(entry.helpKey as MessageKey);
export const groupLabelOf = (t: Translator, section: SettingsSectionId, group: string): string =>
  t(`settingsRegistry.groups.${section}.${group}` as MessageKey);

export function entriesOf(
  section: SettingsSectionId,
  registry: readonly SettingEntryV2[] = settingsRegistryV2
): SettingEntryV2[] {
  return registry.filter((entry) => entry.section === section);
}

export interface SettingGroup {
  group: string;
  entries: SettingEntryV2[];
}

/** A section's groups in the order the registry first names them, each with its entries. */
export function groupsOf(
  section: SettingsSectionId,
  registry: readonly SettingEntryV2[] = settingsRegistryV2
): SettingGroup[] {
  const groups: SettingGroup[] = [];
  for (const entry of entriesOf(section, registry)) {
    const found = groups.find((candidate) => candidate.group === entry.group);
    if (found) found.entries.push(entry);
    else groups.push({ group: entry.group, entries: [entry] });
  }
  return groups;
}

export const describeIndexOf = (entries: readonly SettingDescription[]): DescribeIndex =>
  new Map(entries.map((entry) => [entry.id, entry]));

/**
 * A key, a token or a sign-in. What is saved shows on its own line ("Connected", "Key saved"), so it is
 * never counted or marked as a changed setting, and "Restore all" never touches one.
 */
export const isCredential = (entry: SettingEntryV2): boolean => entry.category === "credential";

const isChanged = (entry: SettingEntryV2, index: DescribeIndex): boolean =>
  !isCredential(entry) && index.get(entry.id)?.changed === true;

/** The entries of a section that differ from their default, in the registry's order. */
export function changedIn(
  section: SettingsSectionId,
  index: DescribeIndex,
  registry: readonly SettingEntryV2[] = settingsRegistryV2
): SettingEntryV2[] {
  return entriesOf(section, registry).filter((entry) => isChanged(entry, index));
}

export function changedCounts(
  index: DescribeIndex,
  registry: readonly SettingEntryV2[] = settingsRegistryV2
): Record<SettingsSectionId, number> {
  const counts = Object.fromEntries(settingsSectionIds.map((id) => [id, 0])) as Record<
    SettingsSectionId,
    number
  >;
  for (const entry of registry) if (isChanged(entry, index)) counts[entry.section] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Search

export interface ResultGroup {
  section: SettingsSectionId;
  hits: SettingHit[];
}

/**
 * The hits grouped by section: the section of the best hit first, and inside a group the order of
 * the search. The first hit of the first group is the best of all, the one Enter opens.
 */
export function groupHits(hits: readonly SettingHit[]): ResultGroup[] {
  const groups: ResultGroup[] = [];
  for (const hit of hits) {
    const found = groups.find((group) => group.section === hit.section);
    if (found) found.hits.push(hit);
    else groups.push({ section: hit.section, hits: [hit] });
  }
  return groups;
}

export function hitCounts(hits: readonly SettingHit[]): Record<SettingsSectionId, number> {
  const counts = Object.fromEntries(settingsSectionIds.map((id) => [id, 0])) as Record<
    SettingsSectionId,
    number
  >;
  for (const hit of hits) counts[hit.section] += 1;
  return counts;
}

/** A label cut into the parts the query matched and the parts it did not, in order. */
export function labelParts(
  label: string,
  ranges: ReadonlyArray<readonly [number, number]>
): Array<{ text: string; hit: boolean }> {
  const parts: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at || end > label.length || end <= start) continue;
    if (start > at) parts.push({ text: label.slice(at, start), hit: false });
    parts.push({ text: label.slice(start, end), hit: true });
    at = end;
  }
  if (at < label.length) parts.push({ text: label.slice(at), hit: false });
  return parts;
}

// ---------------------------------------------------------------------------
// The state of the frame

export type SettingsLoad = "loading" | "error" | "ready";
export type SettingsFrameState = "loading" | "empty" | "error" | "success";

/**
 * What the frame reports: while a search is typed, the surface is what the search shows (a list, or
 * "nothing for that"); otherwise it is what the read of the saved values says.
 */
export function settingsState(input: {
  load: SettingsLoad;
  query: string;
  hits: number;
}): SettingsFrameState {
  if (input.query.trim() !== "") return input.hits > 0 ? "success" : "empty";
  if (input.load === "loading") return "loading";
  if (input.load === "error") return "error";
  return "success";
}

// ---------------------------------------------------------------------------
// Reset

/**
 * A reset that deletes what the person gave and cannot give back by itself: a stored key or token
 * (`reset: "credential"`). Restoring its default removes the secret, so a row asks first, naming
 * the setting, and "Restore all" leaves it alone (rules/security-privacy.md: destructive actions
 * disclose their scope and require confirmation).
 */
export const resetNeedsConfirm = (entry: SettingEntryV2): boolean => entry.reset === "credential";

// ---------------------------------------------------------------------------
// Values

/**
 * The words of a stored value for a row that has no control of its own yet: only what can be said
 * without knowing the options (on or off, set or not, a number). A choice's code ("system") is
 * never shown as if it were copy; the section's own control says it in words.
 */
export function valueText(
  t: Translator,
  entry: SettingEntryV2,
  description: SettingDescription | undefined
): string | null {
  if (!description) return null;
  const { value } = description;
  if (typeof value === "boolean")
    return entry.control === "switch"
      ? t(value ? "settingsShell.row.valueOn" : "settingsShell.row.valueOff")
      : t(value ? "settingsShell.row.valueSet" : "settingsShell.row.valueNone");
  if (value === null)
    return entry.control === "credential" || entry.control === "folder"
      ? t("settingsShell.row.valueNone")
      : null;
  if (typeof value === "number") return String(value);
  if (typeof value === "string" && entry.control === "text") return value;
  return null;
}

/** The default of a row that has no control of its own, in the same words, or null when unknown. */
export function defaultText(
  t: Translator,
  entry: SettingEntryV2,
  description: SettingDescription | undefined
): string | null {
  if (!description || description.default === null) return null;
  return valueText(t, entry, { ...description, value: description.default });
}

// ---------------------------------------------------------------------------
// Addresses

const addressIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/**
 * The id of a setting as `memora://settings/<section>#<id>` writes it: the registry id when an
 * address can hold it, else its flat name (two ids hold a colon, which a fragment cannot).
 */
export function addressIdOf(entry: SettingEntryV2): string {
  return addressIdPattern.test(entry.id) ? entry.id : settingSlug(entry.id);
}

/** The entry an address names: by its registry id, or by its flat name. */
export function entryForAddress(
  id: string,
  registry: readonly SettingEntryV2[] = settingsRegistryV2
): SettingEntryV2 | null {
  return (
    registry.find((entry) => entry.id === id) ??
    registry.find((entry) => settingSlug(entry.id) === id) ??
    null
  );
}

/** The DOM attribute that finds a row: `[data-setting-id="<registry id>"]` (X10). */
export const settingSelector = (id: string): string =>
  `[data-setting-id="${id.replaceAll('"', '\\"')}"]`;

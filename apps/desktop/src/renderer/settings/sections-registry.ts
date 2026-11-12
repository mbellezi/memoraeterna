import type { ComponentType } from "react";

import { settingsSectionIds, type SettingsSectionId } from "./settings-model";

/**
 * The body of one section of Settings v2. Each section card (T162-T165) writes
 * `settings/sections/<name>/<Name>Section.tsx` and exports `section`; the surface finds the files
 * with `import.meta.glob`, so there is no list to edit. A section that is not registered shows its
 * registry's rows read-only (`GenericSection`). The component reads what it needs from
 * `useSettings()` and draws its groups and `RegistryRow`s; the surface draws the title, the
 * "changed" summary and the frame around it.
 */
export interface SettingsSectionModule {
  id: SettingsSectionId;
  Section: ComponentType;
  /**
   * The bars shown while the saved values are read, in the shape of this section (built from
   * `SectionBars`). Absent: the surface's generic rows.
   */
  Skeleton?: ComponentType;
}

export type SectionRegistry = Readonly<Partial<Record<SettingsSectionId, SettingsSectionModule>>>;

const isSectionModule = (value: unknown): value is SettingsSectionModule => {
  const module = value as Partial<SettingsSectionModule> | null;
  return (
    typeof module === "object" &&
    module !== null &&
    typeof module.id === "string" &&
    (settingsSectionIds as readonly string[]).includes(module.id) &&
    (typeof module.Section === "function" || typeof module.Section === "object")
  );
};

/**
 * The section modules of a glob (`import.meta.glob(..., { eager: true })`): a file exports `section`.
 * A file that does not, or two files for one section, is a programming error and fails loudly.
 */
export function registerSections(modules: Readonly<Record<string, unknown>>): SectionRegistry {
  const registry: Partial<Record<SettingsSectionId, SettingsSectionModule>> = {};
  for (const path of Object.keys(modules).sort()) {
    const section = (modules[path] as { section?: unknown } | undefined)?.section;
    if (!isSectionModule(section)) throw new Error(`${path} must export section: { id, Section }`);
    if (registry[section.id]) throw new Error(`${path} registers the ${section.id} section twice`);
    registry[section.id] = section;
  }
  return registry;
}

/** Every `sections/<name>/<Name>Section.tsx`, found at build time. */
export const sectionRegistry: SectionRegistry = registerSections(
  import.meta.glob("./sections/*/*Section.tsx", { eager: true })
);

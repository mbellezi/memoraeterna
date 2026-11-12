import type { ProcessingPlanRequest, ProcessingPreset } from "@app/domain";
import type { MessageKey } from "@app/i18n";

import type { DroppedRefusal } from "../../../shared/ipc-drop.js";
import { defaultProcessingPlan } from "../../components/ProcessingPlanPicker";

/**
 * What Adicionar does, as data (design record 5.2, D32 as amended by A7). The main part and Cmd-N
 * open the file picker; the chevron menu lists the other ways and the import mode; a drop imports
 * at once with the current mode. Nothing here touches the window: the controller and the menu read it.
 */

/** The three import modes of the "Ao importar" group, and the F4 processing preset each one is. */
export const importModes = ["secondBrain", "searchable", "storeOnly"] as const;
export type ImportMode = (typeof importModes)[number];

const presetOfMode: Readonly<Record<ImportMode, Exclude<ProcessingPreset, "custom">>> = {
  secondBrain: "full_knowledge",
  searchable: "search_ready",
  storeOnly: "import_only"
};

/** The plan an import of this mode asks for (`ingestion.importFile`'s `processingPlan`). */
export function planOfMode(mode: ImportMode): ProcessingPlanRequest {
  return defaultProcessingPlan(presetOfMode[mode]);
}

/** Whether a model that can write is ready: unknown while it loads, failed when it could not be read. */
export type Readiness =
  { status: "loading" } | { status: "ready"; writer: boolean } | { status: "error" };

/**
 * The default follows the plan: Segundo cérebro when a model that can write is ready, otherwise
 * Pesquisável e organizado. Unknown or failed readiness never promises generative AI.
 */
export function defaultMode(readiness: Readiness): ImportMode {
  return readiness.status === "ready" && readiness.writer ? "secondBrain" : "searchable";
}

/** An explicit choice always wins, even when readiness arrives afterwards. */
export function effectiveMode(chosen: ImportMode | null, readiness: Readiness): ImportMode {
  return chosen ?? defaultMode(readiness);
}

export function isImportMode(value: unknown): value is ImportMode {
  return typeof value === "string" && (importModes as readonly string[]).includes(value);
}

/** The words of a mode: its name, and its second line given what is known of the writer. */
export interface ModeCopy {
  name: MessageKey;
  hint: MessageKey;
}

export function modeCopy(mode: ImportMode, readiness: Readiness): ModeCopy {
  switch (mode) {
    case "secondBrain":
      return {
        name: "addFlow.modes.secondBrain.name",
        hint:
          readiness.status !== "ready"
            ? "addFlow.modes.secondBrain.hint"
            : readiness.writer
              ? "addFlow.modes.secondBrain.hintRecommended"
              : "addFlow.modes.secondBrain.hintNeedsModel"
      };
    case "searchable":
      return { name: "addFlow.modes.searchable.name", hint: "addFlow.modes.searchable.hint" };
    case "storeOnly":
      return { name: "addFlow.modes.storeOnly.name", hint: "addFlow.modes.storeOnly.hint" };
  }
}

/** The plain mode hint a drop card repeats, with no readiness suffix. */
export function modeHintKey(mode: ImportMode): MessageKey {
  return mode === "secondBrain"
    ? "addFlow.modes.secondBrain.hint"
    : mode === "searchable"
      ? "addFlow.modes.searchable.hint"
      : "addFlow.modes.storeOnly.hint";
}

/** The chevron menu's entries, top to bottom. "Escolher arquivo…" carries Cmd-N. */
export const addMenuEntries = [
  { id: "file", action: "pickFile", shortcut: "⌘N" },
  { id: "link", action: "openImportPanel" },
  { id: "note", action: "openImportPanel" }
] as const;
export type AddMenuEntryId = (typeof addMenuEntries)[number]["id"];
/** The menu's last item, after the mode group: the advanced import panel. */
export const addMoreEntry = { id: "more", action: "openImportPanel" } as const;

export const addEntryKeys: Readonly<
  Record<AddMenuEntryId, { label: MessageKey; hint: MessageKey }>
> = {
  file: { label: "addFlow.menu.file", hint: "addFlow.menu.fileHint" },
  link: { label: "addFlow.menu.link", hint: "addFlow.menu.linkHint" },
  note: { label: "addFlow.menu.note", hint: "addFlow.menu.noteHint" }
};

/** Why an add failed, for the sentence of the notice: a refusal of the drop, or something else. */
export type AddFailureReason = DroppedRefusal | "noText" | "generic";

export const failureKeys: Readonly<Record<AddFailureReason, MessageKey>> = {
  notAFile: "addFlow.failure.notAFile",
  symlink: "addFlow.failure.symlink",
  empty: "addFlow.failure.empty",
  tooLarge: "addFlow.failure.tooLarge",
  unsupported: "addFlow.failure.unsupported",
  unreadable: "addFlow.failure.unreadable",
  noText: "addFlow.failure.noText",
  generic: "addFlow.failure.generic"
};

/** The sentences for a failure whose file is not known yet (the picker failed before it named one). */
const nameless: Partial<Record<AddFailureReason, MessageKey>> = {
  tooLarge: "addFlow.failure.tooLargeNoName",
  unsupported: "addFlow.failure.unsupportedNoName",
  noText: "addFlow.failure.noTextNoName"
};

/** The sentence of a failure: one that carries a name, else its nameless form, else the plain one. */
export function failureKey(failure: { reason: AddFailureReason; name: string | null }): MessageKey {
  if (failure.name !== null) return failureKeys[failure.reason];
  return nameless[failure.reason] ?? failureKeys.generic;
}

/** Up to three names shown on the drop card, then "and N more". */
export const dropNamesShown = 3;

export function dropNames(names: readonly string[]): { shown: string[]; more: number } {
  const shown = names.slice(0, dropNamesShown);
  return { shown, more: names.length - shown.length };
}

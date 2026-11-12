import type { Translator } from "@app/i18n";

import type { AiClassRouteTarget } from "../../../../shared/ipc";
import { settingsRegistryV2 } from "../../../../shared/settings-registry";
import { labelOf } from "../../settings-model";
import { routeEntryId } from "./ai-model";

/** The name of a route as its row is labelled (the registry's copy), for a status line to name it. */
export function routeLabel(t: Translator, route: AiClassRouteTarget): string {
  const entry = settingsRegistryV2.find((candidate) => candidate.id === routeEntryId(route));
  return entry ? labelOf(t, entry) : route;
}

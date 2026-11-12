import { useState } from "react";

import { useSettingsTarget } from "./settings-target";

/**
 * Which Settings is on screen. Settings v2 is, whenever the place is Settings, unless an old screen
 * covers it or the person chose the old Settings from the new one (until T166 removes it).
 */
export function newSettingsShown(input: {
  destination: string;
  legacyView: string | null;
  classic: boolean;
}): boolean {
  return input.legacyView === null && input.destination === "settings" && !input.classic;
}

/**
 * Whether the person chose the old Settings. A request for a Settings address (a link that names a
 * section or a setting) is a request for the new Settings: it ends that choice, so the request is
 * answered where it is made and not later, by a visit nobody asked it of. State adjusted while
 * rendering, as the surface does for its own requests.
 */
export function useClassicSettings(): readonly [boolean, (classic: boolean) => void] {
  const target = useSettingsTarget();
  const [classic, setClassic] = useState(false);
  const [seen, setSeen] = useState(() => target?.token ?? 0);
  if (target !== null && target.token > seen) {
    setSeen(target.token);
    if (classic) setClassic(false);
  }
  return [classic, setClassic];
}

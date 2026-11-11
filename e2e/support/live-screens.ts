// The plan of live screens, gate U2 (F5 T137, D1): which profile each listed surface opens on and
// in what order it is captured. Every surface gets its own session (a fresh clone, one launch), is
// opened once (its keys pressed once, its address emitted once) and is captured at each width by
// resizing that window: a toggle shortcut (Cmd-\, Cmd-Shift-\, focus mode) or a dialog left open
// (Cmd-K) can never change what a later width or a later surface shows.
import { z } from "zod";

/**
 * `base`: a BASE-J clone; `empty`: its empty-library twin (onboarded, no source: the empty states);
 * `first-run`: a new, never-onboarded userData (the first-run surface, `onboarding.state().show`).
 */
export const liveProfiles = ["base", "empty", "first-run"] as const;
export type LiveProfile = (typeof liveProfiles)[number];

export const liveScreenSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/u),
    profile: z.enum(liveProfiles).default("base"),
    address: z
      .string()
      .regex(/^memora:\/\/[a-z]+\/[0-9a-f-]{36}/u)
      .optional(),
    keys: z.array(z.string().min(1)).default([]),
    ready: z.string().min(1).optional()
  })
  .strict();
export type LiveScreen = z.infer<typeof liveScreenSchema>;

export const liveScreenListSchema = z.array(liveScreenSchema).min(1);

/** The widths every surface is captured at, in this order (the window minimum first). */
export const liveScreenWidths = [960, 1440] as const;

export interface LiveScreenSession {
  screen: LiveScreen;
  /** The run profile the session clones (`profiles/<source>`), or null for a new, empty userData. */
  source: "base" | "base-empty" | null;
  /** The session's own profile folder name inside the run. */
  profileName: string;
  /** The capture index of each width (`<nn>-<id>-<width>`), unique across the run. */
  captures: { width: (typeof liveScreenWidths)[number]; index: number }[];
}

const sources: Record<LiveProfile, LiveScreenSession["source"]> = {
  base: "base",
  empty: "base-empty",
  "first-run": null
};

/** One session per listed surface, in list order. */
export function liveScreenSessions(screens: readonly LiveScreen[]): LiveScreenSession[] {
  let index = 0;
  return screens.map((screen, position) => ({
    screen,
    source: sources[screen.profile],
    profileName: `live-${String(position + 1).padStart(2, "0")}-${screen.id}`,
    captures: liveScreenWidths.map((width) => ({ width, index: ++index }))
  }));
}

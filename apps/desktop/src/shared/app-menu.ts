import { z } from "zod";

/**
 * The application menu runs in the main process and acts on the renderer through these commands.
 * Back and Forward go through the existing window navigation channel instead.
 */

/**
 * The five destinations of the rail, in rail order (Cmd-1..5). The renderer's workspace keeps the
 * same list (`workspace/destinations.ts`, with a test that the two agree).
 */
export const appDestinationIds = ["home", "explore", "library", "inbox", "map"] as const;
export type AppDestinationId = (typeof appDestinationIds)[number];

/**
 * The old top-level views that no destination hosts. The rail's "Telas antigas" menu and the
 * application menu list exactly these, until the cards that remove them (D6) empty the list. The
 * knowledge graph is not one of them: the Map hosts it, so it has a destination of its own.
 */
export const legacyViewIds = ["import", "search", "review", "jobs", "debug"] as const;
export type LegacyViewId = (typeof legacyViewIds)[number];

/**
 * The places the renderer can show; the menu and the rail address them by these IDs: a
 * destination, Settings, or a legacy view (Cmd-6..8 are free again).
 */
export const appViewIds = [...appDestinationIds, "settings", ...legacyViewIds] as const;
export const appViewIdSchema = z.enum(appViewIds);
export type AppViewId = z.infer<typeof appViewIdSchema>;

export const appMenuCommandSchema = z.discriminatedUnion("type", [
  /** Closes the topmost dialog or panel; never the window. */
  z.object({ type: z.literal("close-panel") }).strict(),
  /** `go-to:<destination>`, Settings or a legacy view. */
  z.object({ type: z.literal("go-to"), view: appViewIdSchema }).strict(),
  z.object({ type: z.literal("toggle-navigation") }).strict(),
  z.object({ type: z.literal("toggle-theme") }).strict(),
  /** Cmd-K: search, open or ask. */
  z.object({ type: z.literal("open-palette") }).strict(),
  /** Cmd-N: add a source (the file picker). */
  z.object({ type: z.literal("new-import") }).strict(),
  /** `focus-panel:next|prev`: the next or previous panel of the stack. */
  z.object({ type: z.literal("focus-panel"), direction: z.enum(["next", "prev"]) }).strict(),
  /** Cmd-Shift-T. */
  z.object({ type: z.literal("reopen-closed") }).strict(),
  /** Cmd-Shift-\. */
  z.object({ type: z.literal("toggle-context") }).strict(),
  /** Cmd-Shift-F. */
  z.object({ type: z.literal("toggle-focus-mode") }).strict(),
  /** "Show only this branch" for the topic in the top panel, and the way back. */
  z.object({ type: z.literal("hoist-topic") }).strict(),
  z.object({ type: z.literal("unhoist") }).strict()
]);
export type AppMenuCommand = z.infer<typeof appMenuCommandSchema>;

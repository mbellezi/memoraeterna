import { z } from "zod";

/**
 * The application menu runs in the main process and acts on the renderer through these commands.
 * Back and Forward go through the existing window navigation channel instead.
 */

/** The views the renderer can show; the menu and the navigation rail address them by these IDs. */
export const appViewIds = [
  "wiki",
  "library",
  "import",
  "search",
  "review",
  "jobs",
  "knowledgeGraph",
  "debug",
  "settings"
] as const;
export const appViewIdSchema = z.enum(appViewIds);
export type AppViewId = z.infer<typeof appViewIdSchema>;

export const appMenuCommandSchema = z.discriminatedUnion("type", [
  /** Closes the topmost dialog or panel; never the window. */
  z.object({ type: z.literal("close-panel") }).strict(),
  z.object({ type: z.literal("go-to"), view: appViewIdSchema }).strict(),
  z.object({ type: z.literal("toggle-navigation") }).strict(),
  z.object({ type: z.literal("toggle-theme") }).strict()
]);
export type AppMenuCommand = z.infer<typeof appMenuCommandSchema>;

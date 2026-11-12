import type { ReactNode } from "react";

/**
 * Every surface F5 plans, in one list. A surface is a place the person looks at: a destination
 * root, an object panel, a Settings section, an overlay, a piece of the shell or an existing screen
 * that the shell hosts. The screens tool (`npm run screens`) and `screens.test.tsx` read this list;
 * `surfaces.ts` imports nothing at runtime, so scripts and tests load it as plain data.
 *
 * Paths are relative to `apps/desktop/src/renderer/`. A surface whose implementation file does not
 * exist yet is planned: the screens tool skips it and the coverage test does not ask for its
 * screen module until the file lands. A card that builds a surface writes its screen module at the
 * `screen` path; a card that renames an implementation file edits its entry here.
 *
 * Conventions the coverage test enforces:
 * - every `workspace/panels/<kind>.panel.tsx` is the implementation of one entry;
 * - every `workspace/destinations/<name>/<Name>Root.tsx` is the implementation of one entry;
 * - every `*.screen.tsx` under the renderer is the `screen` of one entry.
 */
export type SurfaceKind =
  "chrome" | "destination" | "panel" | "context" | "overlay" | "settings" | "hosted";

export interface SurfaceEntry {
  /** What `--screen <id>` names, and what the frame reports as `data-surface`. */
  readonly id: string;
  readonly kind: SurfaceKind;
  /** The component file the screen renders. */
  readonly implementation: string;
  /** The screen module beside it: `{ surface, fixtures, render }`. */
  readonly screen: string;
  /** An object panel: its success state shows the path ribbon (`[data-path-ribbon]`). */
  readonly ribbon?: true;
}

/** What a fake `window.app` answers: a value, or a function of the call's arguments, per call path. */
export type ScreenFixtureSet = Readonly<Record<string, unknown>>;

/**
 * What a `<surface>.screen.tsx` exports. `render` returns the real component with its real
 * controller; the fake `window.app` answers its calls from `fixtures` (success and empty), keeps
 * every call pending (loading) or rejects every call (error). A screen module never writes
 * `data-state`: the surface's own frame does.
 */
export interface ScreenModule {
  readonly surface: string;
  readonly fixtures: {
    readonly success: ScreenFixtureSet;
    readonly empty: ScreenFixtureSet;
    /**
     * Only for a surface whose failure needs part of it to load first (a step that opens after a
     * question answered): the calls named here answer, every other call rejects. A fixture that
     * throws makes its call reject. Absent, every call rejects.
     */
    readonly error?: ScreenFixtureSet;
  };
  /**
   * The surface fills the whole window (the shell, the rail): the screens tool shows it edge to edge
   * at the stated width, with no padding around it. Absent, the surface sits on a padded stand.
   */
  readonly fullWindow?: true;
  render(): ReactNode;
}

export const screenModes = ["loading", "empty", "error", "success"] as const;
export type ScreenMode = (typeof screenModes)[number];

const entry = (
  id: string,
  kind: SurfaceKind,
  implementation: string,
  screen: string,
  ribbon?: true
): SurfaceEntry =>
  ribbon ? { id, kind, implementation, screen, ribbon } : { id, kind, implementation, screen };

const panel = (kind: string, ribbon?: true): SurfaceEntry =>
  entry(
    kind,
    "panel",
    `workspace/panels/${kind}.panel.tsx`,
    `workspace/panels/${kind}.screen.tsx`,
    ribbon
  );

const destination = (name: string, component: string): SurfaceEntry =>
  entry(
    `destination-${name}`,
    "destination",
    `workspace/destinations/${name}/${component}Root.tsx`,
    `workspace/destinations/${name}/${name}.screen.tsx`
  );

const section = (name: string, component: string): SurfaceEntry =>
  entry(
    `settings-${name}`,
    "settings",
    `settings/sections/${name}/${component}Section.tsx`,
    `settings/sections/${name}/${name}.screen.tsx`
  );

const contextTab = (name: string): SurfaceEntry =>
  entry(
    `context-${name}`,
    "context",
    `workspace/context/${name}-tab.tsx`,
    `workspace/context/${name}-tab.screen.tsx`
  );

export const surfaces: readonly SurfaceEntry[] = [
  // The shell (T135, T136).
  entry("shell", "chrome", "workspace/Shell.tsx", "workspace/Shell.screen.tsx"),
  entry("rail", "chrome", "workspace/Rail.tsx", "workspace/Rail.screen.tsx"),
  entry("panel-stack", "chrome", "workspace/PanelStack.tsx", "workspace/PanelStack.screen.tsx"),
  entry("panel-frame", "chrome", "workspace/PanelFrame.tsx", "workspace/PanelFrame.screen.tsx"),

  // The primitives sheet (T124): every first-party primitive of components/ui on the tokens.
  entry(
    "primitives",
    "chrome",
    "components/ui/primitives-sheet.tsx",
    "components/ui/primitives.screen.tsx"
  ),

  // The five destinations; each root hosts its navigator and its content.
  destination("home", "Home"),
  destination("explore", "Explore"),
  destination("library", "Library"),
  destination("inbox", "Inbox"),
  destination("map", "Map"),
  entry(
    "map-relations",
    "destination",
    "workspace/destinations/map/relations/RelationsLens.tsx",
    "workspace/destinations/map/relations/relations.screen.tsx"
  ),

  // Panels, one file per kind (the object kinds show the path ribbon).
  panel("source", true),
  panel("note", true),
  panel("topic", true),
  panel("entity", true),
  panel("question", true),
  panel("ask"),
  panel("search"),
  panel("import"),

  // The context panel and its six tabs (D31).
  entry(
    "context-panel",
    "context",
    "workspace/ContextPanel.tsx",
    "workspace/ContextPanel.screen.tsx"
  ),
  contextTab("connections"),
  contextTab("mentions"),
  contextTab("evidence"),
  contextTab("graph"),
  contextTab("history"),
  contextTab("ask"),

  // Overlays: Cmd-K, the Add menu, the drop overlay and quick-look (a non-modal sheet).
  entry(
    "palette",
    "overlay",
    "workspace/palette/Palette.tsx",
    "workspace/palette/palette.screen.tsx"
  ),
  entry("add-menu", "overlay", "workspace/add/AddMenu.tsx", "workspace/add/add-menu.screen.tsx"),
  entry(
    "drop-overlay",
    "overlay",
    "workspace/add/DropOverlay.tsx",
    "workspace/add/drop-overlay.screen.tsx"
  ),
  entry("quick-look", "overlay", "workspace/QuickLook.tsx", "workspace/QuickLook.screen.tsx"),
  entry(
    "library-peek",
    "overlay",
    "workspace/destinations/library/LibraryPeek.tsx",
    "workspace/destinations/library/library-peek.screen.tsx"
  ),

  // Settings v2: the surface and its seven sections.
  entry("settings", "settings", "settings/SettingsSurface.tsx", "settings/settings.screen.tsx"),
  section("general", "General"),
  section("ai", "Ai"),
  section("knowledge", "Knowledge"),
  section("library", "Library"),
  section("integrations", "Integrations"),
  section("privacy", "Privacy"),
  section("advanced", "Advanced"),

  // Screens that exist today and that the shell hosts: they keep their own components until the
  // cards that move them (T141 note and topic, T142 inbox and shape) land.
  entry("inbox", "hosted", "components/inbox/InboxScreen.tsx", "components/inbox/inbox.screen.tsx"),
  entry(
    "shape",
    "hosted",
    "components/topic-shape/ShapeScreen.tsx",
    "components/topic-shape/shape.screen.tsx"
  ),
  entry(
    "activity",
    "hosted",
    "components/activity/ActivityHost.tsx",
    "components/activity/activity.screen.tsx"
  ),
  entry(
    "onboarding",
    "hosted",
    "components/onboarding/use-first-run.tsx",
    "components/onboarding/onboarding.screen.tsx"
  ),
  entry(
    "note-page",
    "hosted",
    "components/note-page/NotePage.tsx",
    "components/note-page/note-page.screen.tsx"
  ),
  entry(
    "topic-page",
    "hosted",
    "components/topic-page/TopicPage.tsx",
    "components/topic-page/topic-page.screen.tsx"
  )
];

export function surfaceById(id: string): SurfaceEntry | undefined {
  return surfaces.find((surface) => surface.id === id);
}

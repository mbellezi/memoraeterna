import { parseObjectAddress } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { destinationIds, type DestinationId, type WorkspacePlace } from "../destinations";
import { hasNavigator } from "../shell-model";
import type { WorkspaceAction, WorkspaceState } from "../state";
import { foldText } from "./highlight";

/**
 * The commands of Cmd-K's `>` mode and its "Fazer" group (design record §11, D13): a typed list
 * with a label key, English keywords (so "tema" and "theme" both find the theme command), the
 * shortcut it really has and a `run`. A row shows a shortcut only when one exists; a prefix
 * character is never a keycap.
 */

/** What a command may do; the host (`App.tsx`) supplies the parts that live outside the stack. */
export interface PaletteActions {
  /** A place of the rail, through the app's own route (it also clears an old screen). */
  go(place: WorkspacePlace): void;
  /** A workspace action for the stack (hoist, toggle the context panel, reopen). */
  dispatch(action: WorkspaceAction): void;
  /** Adicionar's main action: the file picker. */
  addSource(): void;
  toggleTheme(): void;
  toggleFocusMode(): void;
}

export interface PaletteCommand {
  id: string;
  labelKey: MessageKey;
  /** English words that also find it; the translated label is always searched too. */
  keywords: readonly string[];
  /** The real shortcut, written as the Rail writes it ("⌘5"); absent when there is none. */
  shortcut?: string;
  /** Offered with an empty query, among the suggestions. */
  suggested?: true;
  /** Whether it makes sense in this state; absent means always. */
  available?: (state: WorkspaceState) => boolean;
  run(state: WorkspaceState, actions: PaletteActions): void;
}

const goKeys: Record<DestinationId, MessageKey> = {
  home: "palette.commands.goHome",
  explore: "palette.commands.goExplore",
  library: "palette.commands.goLibrary",
  inbox: "palette.commands.goInbox",
  map: "palette.commands.goMap"
};

const goCommand = (destination: DestinationId, index: number): PaletteCommand => ({
  id: `go-${destination}`,
  labelKey: goKeys[destination],
  keywords: ["go", "open", "destination", destination],
  shortcut: `⌘${index + 1}`,
  ...(destination === "map" ? { suggested: true as const } : {}),
  run: (_state, actions) => actions.go(destination)
});

/** The topic the focused panel shows, or null: hoisting needs one. */
export function focusedTopicId(state: WorkspaceState): string | null {
  if (state.destination === "settings") return null;
  const stack = state.stacks[state.destination];
  const panel = stack.panels[stack.focus];
  const address = panel?.history[panel.index];
  const parsed = address ? parseObjectAddress(address) : null;
  return parsed?.kind === "topic" && !parsed.anchor ? parsed.id : null;
}

const stackOf = (state: WorkspaceState) =>
  state.destination === "settings" ? null : state.stacks[state.destination];

export const paletteCommands: readonly PaletteCommand[] = [
  {
    id: "add-source",
    labelKey: "workspace.titleBar.addSource",
    keywords: ["add", "import", "new", "file", "source", "upload"],
    shortcut: "⌘N",
    suggested: true,
    run: (_state, actions) => actions.addSource()
  },
  ...destinationIds.map(goCommand),
  {
    id: "go-settings",
    labelKey: "palette.commands.goSettings",
    keywords: ["settings", "preferences", "options", "configure"],
    shortcut: "⌘,",
    run: (_state, actions) => actions.go("settings")
  },
  {
    id: "theme",
    labelKey: "palette.commands.theme",
    keywords: ["theme", "dark", "light", "appearance", "mode", "tema", "escuro", "claro"],
    suggested: true,
    run: (_state, actions) => actions.toggleTheme()
  },
  {
    id: "hoist",
    labelKey: "workspace.menu.hoistTopic",
    keywords: ["hoist", "branch", "tree", "focus", "only", "topic"],
    available: (state) => {
      const topic = focusedTopicId(state);
      return topic !== null && state.hoist !== topic;
    },
    run: (state, actions) => {
      const topic = focusedTopicId(state);
      if (topic !== null) actions.dispatch({ type: "hoist", topicId: topic });
    }
  },
  {
    id: "unhoist",
    labelKey: "workspace.menu.unhoist",
    keywords: ["hoist", "unhoist", "whole", "tree", "all", "branch", "show"],
    available: (state) => state.hoist !== null,
    run: (_state, actions) => actions.dispatch({ type: "hoist", topicId: null })
  },
  {
    id: "toggle-navigator",
    labelKey: "palette.commands.toggleNavigator",
    keywords: ["navigator", "tree", "sidebar", "hide", "show"],
    shortcut: "⌘\\",
    available: (state) => hasNavigator(state.destination),
    run: (_state, actions) => actions.dispatch({ type: "toggleNavigator" })
  },
  {
    id: "toggle-context",
    labelKey: "workspace.menu.toggleContext",
    keywords: ["context", "panel", "connections", "evidence", "hide", "show"],
    shortcut: "⌘⇧\\",
    run: (_state, actions) => actions.dispatch({ type: "toggleContext" })
  },
  {
    id: "focus-mode",
    labelKey: "workspace.menu.focusMode",
    keywords: ["focus", "distraction", "reading", "zen"],
    shortcut: "⌘⇧F",
    run: (_state, actions) => actions.toggleFocusMode()
  },
  {
    id: "reopen-closed",
    labelKey: "workspace.menu.reopenClosed",
    keywords: ["reopen", "closed", "panel", "undo", "restore"],
    shortcut: "⌘⇧T",
    available: (state) => (stackOf(state)?.closed.length ?? 0) > 0,
    run: (_state, actions) => actions.dispatch({ type: "reopen" })
  }
];

/** A command as the palette lists it: its label in the person's language. */
export interface ResolvedCommand {
  id: string;
  label: string;
  shortcut?: string;
  suggested: boolean;
  /** The folded text a query is matched against: the label and the keywords. */
  haystack: string;
}

/** The commands that make sense now, worded in the translator's language. */
export function resolveCommands(
  t: Translator,
  state: WorkspaceState,
  commands: readonly PaletteCommand[] = paletteCommands
): ResolvedCommand[] {
  return commands
    .filter((command) => command.available?.(state) !== false)
    .map((command) => {
      const label = t(command.labelKey);
      return {
        id: command.id,
        label,
        ...(command.shortcut ? { shortcut: command.shortcut } : {}),
        suggested: command.suggested === true,
        haystack: foldText(`${label} ${command.keywords.join(" ")}`)
      };
    });
}

/**
 * The commands a query finds, best first: every word of the query is somewhere in the label or the
 * keywords; a label that starts with the query comes first, then one with a word that does, then
 * the rest in list order. An empty query finds all of them.
 */
export function matchCommands(
  commands: readonly ResolvedCommand[],
  text: string
): ResolvedCommand[] {
  const words = foldText(text)
    .split(/\s+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return [...commands];
  const rank = (command: ResolvedCommand): number | null => {
    if (!words.every((word) => command.haystack.includes(word))) return null;
    const label = foldText(command.label);
    if (label.startsWith(words.join(" "))) return 0;
    return label.split(/\s+/u).some((part) => part.startsWith(words[0] ?? "")) ? 1 : 2;
  };
  return commands
    .flatMap((command, index) => {
      const score = rank(command);
      return score === null ? [] : [{ command, score, index }];
    })
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.command);
}

/** Runs the command with `id`; false when it is unknown or not available now. */
export function runCommand(
  id: string,
  state: WorkspaceState,
  actions: PaletteActions,
  commands: readonly PaletteCommand[] = paletteCommands
): boolean {
  const command = commands.find((entry) => entry.id === id);
  if (!command || command.available?.(state) === false) return false;
  command.run(state, actions);
  return true;
}

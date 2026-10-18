import { stances, type Stance } from "../../lib/relation-stance";

/**
 * The colours of a graph, read from the design tokens (`tokens.css`, "Graph canvas") and never
 * written here: a canvas cannot use CSS variables, so the reader resolves them through
 * `getComputedStyle` on the graph's container and hands back `#rrggbb` strings only. Anything that
 * is not exactly `#rrggbb` is refused (Sigma's colour parsing and the blends of `interaction.ts`
 * take no other form), and a token that cannot be read falls back to the value `tokens.css`
 * declares (a test keeps them equal), so a graph is never drawn with a colour nobody chose.
 */
export const graphTokenNames = {
  canvasCenter: "--graph-canvas-center",
  canvasEdge: "--graph-canvas-edge",
  label: "--graph-label",
  labelMuted: "--graph-label-muted",
  note: "--graph-object-note"
} as const;

export const graphStanceTokenNames: Readonly<Record<Stance, string>> = {
  supports: "--graph-stance-supports",
  contradicts: "--graph-stance-contradicts",
  extends: "--graph-stance-extends",
  depends_on: "--graph-stance-depends-on",
  example_of: "--graph-stance-example-of",
  related: "--graph-stance-related"
};

export interface GraphPalette {
  canvasCenter: string;
  canvasEdge: string;
  label: string;
  labelMuted: string;
  /** The colour of a note (`--graph-object-note`). */
  note: string;
  /** The colour of each relation stance (`--graph-stance-*`). */
  stance: Readonly<Record<Stance, string>>;
}

/** The values `tokens.css` declares, used only for a token the element cannot resolve. */
export const fallbackGraphPalette: GraphPalette = {
  canvasCenter: "#202b39",
  canvasEdge: "#10151d",
  label: "#cbd5e1",
  labelMuted: "#94a3b8",
  note: "#a5c862",
  stance: {
    supports: "#5fd08f",
    contradicts: "#f58b84",
    extends: "#7db4ee",
    depends_on: "#f0a35a",
    example_of: "#b9a3f0",
    related: "#9daabd"
  }
};

const hexColor = /^#[0-9a-fA-F]{6}$/u;

/** The colour as lower-case `#rrggbb`, or null for any other form (short hex, rgb(), names, alpha). */
export function parseGraphColor(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return hexColor.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** The part of a computed style the reader uses, so a test needs no DOM. */
export interface TokenStyle {
  getPropertyValue(name: string): string;
}
export type TokenStyleReader = (element: Element) => TokenStyle;

const computedStyle: TokenStyleReader = (element) => getComputedStyle(element);

/** The graph palette as `element` resolves the tokens now. */
export function readGraphPalette(
  element: Element,
  read: TokenStyleReader = computedStyle
): GraphPalette {
  const style = read(element);
  const color = (name: string, fallback: string) =>
    parseGraphColor(style.getPropertyValue(name)) ?? fallback;
  return {
    canvasCenter: color(graphTokenNames.canvasCenter, fallbackGraphPalette.canvasCenter),
    canvasEdge: color(graphTokenNames.canvasEdge, fallbackGraphPalette.canvasEdge),
    label: color(graphTokenNames.label, fallbackGraphPalette.label),
    labelMuted: color(graphTokenNames.labelMuted, fallbackGraphPalette.labelMuted),
    note: color(graphTokenNames.note, fallbackGraphPalette.note),
    stance: Object.fromEntries(
      stances.map((stance) => [
        stance,
        color(graphStanceTokenNames[stance], fallbackGraphPalette.stance[stance])
      ])
    ) as Record<Stance, string>
  };
}

export function samePalette(left: GraphPalette, right: GraphPalette): boolean {
  return (
    left.canvasCenter === right.canvasCenter &&
    left.canvasEdge === right.canvasEdge &&
    left.label === right.label &&
    left.labelMuted === right.labelMuted &&
    left.note === right.note &&
    stances.every((stance) => left.stance[stance] === right.stance[stance])
  );
}

/** What a theme change reaches: the root's class and style, and the OS colour scheme. */
export interface ThemeChangeSource {
  observeRoot(onChange: () => void): () => void;
  observeScheme(onChange: () => void): () => void;
}

function browserThemeSource(): ThemeChangeSource {
  return {
    observeRoot(onChange) {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"]
      });
      return () => observer.disconnect();
    },
    observeScheme(onChange) {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const query = window.matchMedia("(prefers-color-scheme: dark)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }
  };
}

/**
 * Reads the palette again whenever the theme changes and calls `onChange` with it when a colour
 * differs, so a canvas repaints with the new colours without being rebuilt. The tokens of the graph
 * are the same in both themes today; the reader does not assume it. The returned function stops
 * watching and is safe to call twice.
 */
export function watchGraphPalette(
  element: Element,
  onChange: (palette: GraphPalette) => void,
  options: { source?: ThemeChangeSource; read?: TokenStyleReader } = {}
): () => void {
  const source = options.source ?? browserThemeSource();
  let current = readGraphPalette(element, options.read);
  let stopped = false;
  const reread = () => {
    if (stopped) return;
    const next = readGraphPalette(element, options.read);
    if (samePalette(current, next)) return;
    current = next;
    onChange(next);
  };
  const stops = [source.observeRoot(reread), source.observeScheme(reread)];
  return () => {
    if (stopped) return;
    stopped = true;
    for (const stop of stops) stop();
  };
}

import { stances, type Stance } from "../../lib/relation-stance";

/**
 * The colours of a graph, read from the design tokens (`tokens.css`) and never written here. A
 * graph reads the theme (design record 4.1): its canvas is the raised surface, its labels are the
 * primary text, its lines are the stance colours and, on the Map › Grafo, a note's dot is the
 * colour of its topic group (`--graph-topic-1..12`). A canvas cannot use CSS variables, so the
 * reader resolves them through `getComputedStyle` on the graph's container and hands back
 * `#rrggbb` strings only. Anything that is not exactly `#rrggbb` is refused (Sigma's colour parsing
 * and the blends of `interaction.ts` take no other form), and a token that cannot be read falls
 * back to the light value `tokens.css` declares (a test keeps them equal), so a graph is never
 * drawn with a colour nobody chose.
 */
export const graphTokenNames = {
  canvas: "--surface-raised",
  label: "--text-primary",
  labelMuted: "--text-secondary",
  note: "--object-note"
} as const;

export const graphStanceTokenNames: Readonly<Record<Stance, string>> = {
  supports: "--stance-supports",
  contradicts: "--stance-contradicts",
  extends: "--stance-extends",
  depends_on: "--stance-depends-on",
  example_of: "--stance-example-of",
  related: "--stance-related"
};

/** How many topic colours there are; a topic group's `colourIndex` i is `--graph-topic-<i + 1>`. */
export const graphTopicColourCount = 12;

const wrap = (index: number, count: number) => ((Math.trunc(index) % count) + count) % count;

/** `--graph-topic-<index + 1>`, the token of colour index `index` (taken modulo the count). */
export function graphTopicTokenName(index: number): string {
  return `--graph-topic-${wrap(index, graphTopicColourCount) + 1}`;
}

export interface GraphPalette {
  /** The canvas (`--surface-raised`): label halos and faded colours blend into it. */
  canvas: string;
  label: string;
  labelMuted: string;
  /** The colour of a note (`--object-note`) where no topic colours it. */
  note: string;
  /** The colour of each relation stance (`--stance-*`). */
  stance: Readonly<Record<Stance, string>>;
  /** `--graph-topic-1..12`, in order. */
  topic: readonly string[];
}

/** The light values `tokens.css` declares, used only for a token the element cannot resolve. */
export const fallbackGraphPalette: GraphPalette = {
  canvas: "#ffffff",
  label: "#263140",
  labelMuted: "#4a5668",
  note: "#527017",
  stance: {
    supports: "#1a7345",
    contradicts: "#b3261e",
    extends: "#2a5f9e",
    depends_on: "#9a4a00",
    example_of: "#7048b8",
    related: "#5a6577"
  },
  topic: [
    "#3d6f9e",
    "#a0522d",
    "#3f7f4f",
    "#7d5aa6",
    "#7f7020",
    "#5b6878",
    "#4e7a28",
    "#4a5aa8",
    "#7c5634",
    "#8a4a92",
    "#1d7470",
    "#a83a64"
  ]
};

/** The topic colour of `colourIndex` in `palette` (the index is taken modulo the count). */
export function topicColour(palette: GraphPalette, colourIndex: number): string {
  if (palette.topic.length === 0) return palette.note;
  return palette.topic[wrap(colourIndex, palette.topic.length)]!;
}

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
    canvas: color(graphTokenNames.canvas, fallbackGraphPalette.canvas),
    label: color(graphTokenNames.label, fallbackGraphPalette.label),
    labelMuted: color(graphTokenNames.labelMuted, fallbackGraphPalette.labelMuted),
    note: color(graphTokenNames.note, fallbackGraphPalette.note),
    stance: Object.fromEntries(
      stances.map((stance) => [
        stance,
        color(graphStanceTokenNames[stance], fallbackGraphPalette.stance[stance])
      ])
    ) as Record<Stance, string>,
    topic: fallbackGraphPalette.topic.map((fallback, index) =>
      color(graphTopicTokenName(index), fallback)
    )
  };
}

export function samePalette(left: GraphPalette, right: GraphPalette): boolean {
  return (
    left.canvas === right.canvas &&
    left.label === right.label &&
    left.labelMuted === right.labelMuted &&
    left.note === right.note &&
    stances.every((stance) => left.stance[stance] === right.stance[stance]) &&
    left.topic.length === right.topic.length &&
    left.topic.every((colour, index) => colour === right.topic[index])
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
 * differs, so a canvas repaints with the new colours without being rebuilt. The returned function
 * stops watching and is safe to call twice.
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

/**
 * The shell's layout constants (design record docs/f5-workspace.md §3 and §4.9; docs/f5-decisions.md
 * D8 as amended by gate D's A1 and A2) as typed configuration, not `tokens.css` entries. This module
 * is the one source: `layout()` reads it, and the shell writes the same numbers onto its element as
 * the custom properties `--rail-w`, `--nav-w`, `--ctx-w`, `--prev-w`, `--spine-w`, `--row-h`,
 * `--ind`, `--top-pl`, `--top-gap` and `--top-min`, and its container query from `prevShowsAt`.
 */

export type LayoutTierName = "compact" | "narrow" | "standard" | "wide";

/** One breakpoint's widths, in px. A tier applies from `minWidth` up to the next tier. */
export interface LayoutTier {
  name: LayoutTierName;
  minWidth: number;
  railW: number;
  /** One rail item: as wide as the rail less its margin; no padding, so a long word fits (§5.1). */
  railItemW: number;
  navW: number;
  /** The context panel, docked from 1280 px, otherwise the overlay a 40 px strip opens. */
  ctxW: number;
  /** The previous panel's compact form, when it shows. */
  prevW: number;
  spineW: number;
  rowH: number;
  /** Tree indent per level. */
  ind: number;
  /** Top panel padding and the gap beside spines. */
  topPl: number;
  topGap: number;
}

export const layoutConfig = {
  /** Narrowest first; `tierFor` takes the last tier whose `minWidth` the viewport reaches. */
  tiers: [
    {
      name: "compact",
      minWidth: 0,
      railW: 64,
      railItemW: 56,
      navW: 224,
      ctxW: 304,
      prevW: 216,
      spineW: 40,
      rowH: 28,
      ind: 8,
      topPl: 16,
      topGap: 12
    },
    {
      name: "narrow",
      minWidth: 1180,
      railW: 72,
      railItemW: 60,
      navW: 256,
      ctxW: 304,
      prevW: 224,
      spineW: 40,
      rowH: 28,
      ind: 12,
      topPl: 24,
      topGap: 16
    },
    {
      name: "standard",
      minWidth: 1280,
      railW: 72,
      railItemW: 60,
      navW: 256,
      ctxW: 304,
      prevW: 224,
      spineW: 40,
      rowH: 28,
      ind: 12,
      topPl: 24,
      topGap: 16
    },
    {
      name: "wide",
      minWidth: 1440,
      railW: 72,
      railItemW: 60,
      navW: 272,
      ctxW: 320,
      prevW: 240,
      spineW: 40,
      rowH: 28,
      ind: 12,
      topPl: 24,
      topGap: 16
    }
  ] as const satisfies readonly LayoutTier[],
  /** The top panel's floor: a 520 px reading column plus 24 px padding each side (A1, cal.). */
  topMin: 568,
  /** The floor at the window minimum, a 960-999 px window (design record §3). */
  topMinAtWindowMin: 552,
  /** Below this window width the floor is `topMinAtWindowMin`. */
  windowMinBandEnd: 1000,
  /** Spines beyond this many merge into one "+N" spine at the far left. */
  maxSpines: 6,
  /** The context panel docks from this window width; below it is a strip (A2). */
  contextDockedFrom: 1280,
  /** The context panel's strip below `contextDockedFrom`; it opens the `ctxW` overlay. */
  contextStripW: 40,
  /** Below this window width the compact tier applies. */
  compactBelow: 1180,
  /** The omni trigger in the top bar keeps at least this width. */
  omniMin: 240,
  /** The window minimum (unchanged). */
  windowMin: 960
} as const;

/** The tier a window `viewportWidth` px wide lays out with. */
export function tierFor(viewportWidth: number): LayoutTier {
  const tiers: readonly LayoutTier[] = layoutConfig.tiers;
  let tier = tiers[0] as LayoutTier;
  for (const candidate of tiers) if (viewportWidth >= candidate.minWidth) tier = candidate;
  return tier;
}

/** Docked from 1280 px; below that, a 40 px strip that opens a 304 px overlay (A2). */
export function contextMode(viewportWidth: number): "docked" | "strip" {
  return viewportWidth >= layoutConfig.contextDockedFrom ? "docked" : "strip";
}

/** The top panel's floor at this window width: 568, or 552 at a 960-999 px window. */
export function topMinFor(viewportWidth: number): number {
  return viewportWidth < layoutConfig.windowMinBandEnd
    ? layoutConfig.topMinAtWindowMin
    : layoutConfig.topMin;
}

const widestPrevW = Math.max(...layoutConfig.tiers.map((tier) => tier.prevW));

/**
 * The stack width from which the previous panel shows in its compact form: the widest previous
 * panel, one spine and the top panel's floor, 848 px. D8 and the design record's container query
 * (§3, §18) name one threshold for every tier, so the narrower previous panel of the smaller tiers
 * leaves the top panel more than its floor.
 */
export const prevShowsAt = (tier: LayoutTier): number =>
  widestPrevW + tier.spineW + layoutConfig.topMin;

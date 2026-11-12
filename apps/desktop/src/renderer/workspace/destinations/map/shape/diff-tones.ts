/**
 * The colours of the structural diff, as design tokens. Kept free of imports so the contrast check
 * (`scripts/contrast/diff-blocks.test.ts`) reads exactly what the blocks draw with.
 */

/** Colour never stands alone: every tone pairs with a glyph (`diff-marks.tsx`) and a word. */
export type DiffTone = "success" | "danger" | "info" | "neutral";

/**
 * The tokens each tone draws with: the tint behind a block and the ink of its glyph. Text on a tint
 * is `--text-*`. `npm run contrast` covers the state tints and `diff-blocks.test.ts` checks these
 * exact pairs, the selection ring, the dashed outline and the focus outline in both themes.
 */
export const diffToneTokens = {
  success: { fill: "--state-success-soft", ink: "--state-success" },
  danger: { fill: "--state-danger-soft", ink: "--state-danger" },
  info: { fill: "--state-info-soft", ink: "--state-info" },
  neutral: { fill: "--surface-soft", ink: "--text-secondary" }
} as const satisfies Record<DiffTone, { fill: string; ink: string }>;

export const toneVar = (token: string): string => `var(${token})`;

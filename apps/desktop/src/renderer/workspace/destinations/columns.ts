import { layoutConfig } from "../layout-config";

/**
 * The side columns of the destination roots, in px (design record §3, "Destination layouts"): the
 * Inbox's item list and the Map's inspector are narrower in the compact tier, below 1180 px. Typed
 * configuration, written onto the root as a custom property by the component that uses it.
 */
export const destinationColumns = {
  inboxList: { standard: 360, compact: 300 },
  mapInspector: { standard: 400, compact: 320 }
} as const;

type Column = keyof typeof destinationColumns;

/** The width of a side column in a window `viewportWidth` px wide. */
export function columnWidth(column: Column, viewportWidth: number): number {
  const widths = destinationColumns[column];
  return viewportWidth < layoutConfig.compactBelow ? widths.compact : widths.standard;
}

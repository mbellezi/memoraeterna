export const graphTypography = {
  labelFont: "Inter, ui-sans-serif, system-ui, sans-serif",
  labelSize: 12,
  labelWeight: "500",
  edgeLabelFont: "Arial",
  edgeLabelSize: 14,
  edgeLabelWeight: "normal"
};

export function graphNodeSize(degree: number): number {
  return Math.min(13, 3.5 + Math.log2(degree + 1) * 1.8);
}

export function zoomVisualStrength(ratio: number): number {
  const farRatio = 1.25;
  const nearRatio = 0.16;
  const progress = Math.max(0, Math.min(1, (farRatio - ratio) / (farRatio - nearRatio)));
  return progress * progress * (3 - 2 * progress);
}

export function isLabelOutsideViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  horizontalMargin: number,
  verticalMargin: number
): boolean {
  return x < horizontalMargin || x > width - horizontalMargin ||
    y < verticalMargin || y > height - verticalMargin;
}

export function relationLabelRevealAt(edgeKey: string, confidence: number, edgeCount: number): number {
  const samplingFraction = Math.min(1, 2_400 / Math.max(1, edgeCount));
  const eligibility = stableFraction(edgeKey, 17);
  if (eligibility > samplingFraction) return 2;
  return Math.max(0.22, Math.min(0.9, 0.72 - confidence * 0.22 + stableFraction(edgeKey, 31) * 0.34));
}

export function nodeLabelOpacity(cameraRatio: number, importance: number): number {
  const strength = zoomVisualStrength(cameraRatio);
  const start = Math.max(0.05, 0.62 - Math.log2(importance + 1) * 0.1);
  const progress = Math.max(0, Math.min(1, (strength - start) / (1 - start)));
  return progress * progress * (3 - 2 * progress);
}

export function zoomCompensatedEdgeSize(cameraRatio: number, screenThickness = 1.8): number {
  return screenThickness * Math.sqrt(Math.max(0.0001, cameraRatio));
}

export const relationHitAreaScreenThickness = 10;

export function positionOverlayWithinViewport(
  anchor: { x: number; y: number },
  overlay: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 14,
  margin = 8
): { x: number; y: number } {
  const preferredX = anchor.x + gap;
  const preferredY = anchor.y + gap;
  const alternateX = anchor.x - gap - overlay.width;
  const alternateY = anchor.y - gap - overlay.height;
  const x = preferredX + overlay.width <= viewport.width - margin ? preferredX : alternateX;
  const y = preferredY + overlay.height <= viewport.height - margin ? preferredY : alternateY;
  return {
    x: Math.max(margin, Math.min(x, Math.max(margin, viewport.width - overlay.width - margin))),
    y: Math.max(margin, Math.min(y, Math.max(margin, viewport.height - overlay.height - margin)))
  };
}

function stableFraction(value: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

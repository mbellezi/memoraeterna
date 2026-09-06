export type LodLevel = "overview" | "hubs" | "detail";

export function lodFromRatio(ratio: number): LodLevel {
  if (ratio >= 1.25) return "overview";
  if (ratio >= 0.52) return "hubs";
  return "detail";
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

export function linkedNodeSpringForce(
  node: { x: number; y: number },
  attractor: { x: number; y: number },
  restLength: number,
  stiffness = 0.065
): { x: number; y: number } {
  const deltaX = attractor.x - node.x;
  const deltaY = attractor.y - node.y;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance < 0.0001) return { x: 0, y: 0 };
  const magnitude = (distance - restLength) * stiffness;
  return { x: deltaX / distance * magnitude, y: deltaY / distance * magnitude };
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

export function isNodeVisibleAtLod(
  lod: LodLevel,
  isCommunity: boolean,
  importance: number,
  hubThreshold: number
): boolean {
  if (lod === "overview") return isCommunity;
  if (isCommunity) return false;
  return lod === "detail" || importance >= hubThreshold;
}

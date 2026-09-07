export interface GraphHoverTarget { type: "node" | "edge"; key: string; x: number; y: number }

/** Highlight dwell is independent of pointer inactivity required by the information card. */
export class GraphHoverIntent {
  private target: GraphHoverTarget | null = null;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private suspended = false;

  constructor(
    private readonly highlight: (target: GraphHoverTarget | null) => void,
    private readonly preview: (target: GraphHoverTarget | null) => void
  ) {}

  enter(target: GraphHoverTarget) {
    if (this.suspended) return;
    if (this.target?.key === target.key && this.target.type === target.type) { this.move(target); return; }
    this.clear();
    this.target = target;
    this.highlightTimer = setTimeout(() => {
      this.highlightTimer = null;
      if (!this.suspended && this.target) this.highlight(this.target);
    }, 100);
    this.schedulePreview();
  }

  move(point: { x: number; y: number }) {
    if (this.suspended || !this.target) return;
    this.target = { ...this.target, x: point.x, y: point.y };
    this.schedulePreview();
  }

  leave(type: GraphHoverTarget["type"], key: string) {
    if (this.target?.key === key && this.target.type === type) this.clear();
  }

  private schedulePreview() {
    if (this.previewTimer !== null) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      if (!this.suspended && this.target) this.preview(this.target);
    }, 1_000);
  }

  clear() {
    if (this.highlightTimer !== null) clearTimeout(this.highlightTimer);
    if (this.previewTimer !== null) clearTimeout(this.previewTimer);
    this.highlightTimer = null;
    this.previewTimer = null;
    this.target = null;
    this.highlight(null);
    this.preview(null);
  }

  suspend() { this.suspended = true; this.clear(); }
  resume() { this.suspended = false; }
  dispose() { this.suspend(); }
}

interface GraphWheelInput { deltaY: number; deltaMode: number; ctrlKey: boolean; shiftKey: boolean }

export interface GraphZoomBounds { ratio: number; minimum: number; maximum: number }

interface Dimensions { width: number; height: number }

interface CapturableWheelEvent { preventDefault(): void; stopImmediatePropagation(): void }

export function captureGraphWheelEvent(event: CapturableWheelEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/** Wheel velocity follows the latest physical scroll rate and decays briefly after input stops. */
export class GraphWheelMotion {
  private velocity = 0;
  private lastFrameAt: number | null = null;
  private lastInputAt: number | null = null;
  private readonly decayTime = 55;
  private readonly maxFrameTravel = 5.04;

  constructor(private readonly sensitivity = 1) {}

  get active() { return Math.abs(this.velocity) >= 0.00004; }

  push(event: GraphWheelInput, now: number) {
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    // Normalize physical units without switching sensitivity at arbitrary pixel thresholds.
    const pixels = event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1);
    const elapsedInput = this.lastInputAt === null ? 1000 / 60 : Math.max(4, Math.min(80, now - this.lastInputAt));
    const adjustedPixels = pixels * (event.ctrlKey ? 4 : 1);
    const speedBoost = 1 + 2 * Math.abs(adjustedPixels) / (Math.abs(adjustedPixels) + 80);
    const travel = Math.sign(adjustedPixels) * 0.006 * Math.pow(Math.abs(adjustedPixels), 0.88)
      * speedBoost * (event.shiftKey ? 0.25 : 1);
    const measuredVelocity = travel * this.sensitivity / elapsedInput;
    if (!this.active || this.lastFrameAt === null || now - this.lastFrameAt > 120) {
      this.lastFrameAt = now;
    }
    this.lastInputAt = now;
    // Replace rather than accumulate: macOS/Chromium already encode free-wheel
    // speed and momentum in the event magnitude and cadence.
    this.velocity = measuredVelocity;
  }

  /** Natural-log scale change for this frame; the caller applies exp(delta) to the camera ratio. */
  advance(now: number, bounds?: GraphZoomBounds): number {
    if (!this.active || this.lastFrameAt === null) { this.cancel(); return 0; }
    const elapsed = Math.max(0, now - this.lastFrameAt);
    this.lastFrameAt = Math.max(now, this.lastFrameAt);
    if (elapsed === 0) return 0;
    // Do not catch up lost animation time in one frame after a busy/backgrounded renderer.
    if (elapsed > 120) { this.cancel(); return 0; }
    const visibleElapsed = Math.min(20, elapsed);
    const rawDelta = this.velocity * this.decayTime * (1 - Math.exp(-visibleElapsed / this.decayTime));
    this.velocity *= Math.exp(-elapsed / this.decayTime);
    const limitedDelta = Math.max(-this.maxFrameTravel, Math.min(this.maxFrameTravel, rawDelta));
    const delta = bounds ? softenGraphZoomDelta(limitedDelta, bounds) : limitedDelta;
    if (limitedDelta !== 0 && delta === 0) { this.cancel(); return 0; }
    if (!this.active) this.cancel();
    return delta;
  }

  cancel() { this.velocity = 0; this.lastFrameAt = null; this.lastInputAt = null; }
}

/** Eases logarithmic wheel travel into either camera boundary instead of clipping abruptly. */
export function softenGraphZoomDelta(delta: number, bounds: GraphZoomBounds): number {
  if (delta === 0) return 0;
  const boundary = delta > 0 ? bounds.maximum : bounds.minimum;
  const remaining = delta > 0
    ? Math.log(boundary / bounds.ratio)
    : Math.log(bounds.ratio / boundary);
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  if (remaining <= 0.001) return Math.sign(delta) * remaining;
  const proximity = Math.max(0, Math.min(1, remaining / 1.6));
  const easing = proximity * proximity * (3 - 2 * proximity);
  const softenedTravel = Math.abs(delta) * (0.04 + easing * 0.96);
  return Math.sign(delta) * Math.min(remaining * 0.65, softenedTravel);
}

/** Ratio at which the graph's longest visible dimension occupies the requested viewport fraction. */
export function graphZoomOutRatio(
  cameraRatio: number,
  graphSpan: Dimensions,
  viewport: Dimensions,
  fixedPadding = 0,
  viewportFraction = 0.5
): number {
  const availableWidth = Math.max(1, viewport.width * viewportFraction - fixedPadding);
  const availableHeight = Math.max(1, viewport.height * viewportFraction - fixedPadding);
  const scale = Math.max(graphSpan.width / availableWidth, graphSpan.height / availableHeight);
  return scale > 0 && Number.isFinite(scale) ? cameraRatio * scale : Math.max(1, cameraRatio);
}

export function zoomOutCenteringStrength(ratio: number, maximum: number): number {
  if (!(ratio > 0) || !(maximum > 0)) return 0;
  const proximity = Math.max(0, Math.min(1, 1 - Math.log(maximum / ratio) / 1.2));
  return proximity * proximity * (3 - 2 * proximity);
}

/** The dynamic zoom-out ceiling must never clamp motion in the zoom-in direction. */
export function boundedGraphWheelRatio(
  ratio: number,
  logarithmicDelta: number,
  minimum: number,
  zoomOutMaximum: number
): number {
  const next = ratio * Math.exp(logarithmicDelta);
  return Math.max(minimum, logarithmicDelta > 0 ? Math.min(zoomOutMaximum, next) : next);
}

export const graphMutedColor = "#949494";
export const graphHighlightColor = "#fca5a5";

export function blendGraphColor(from: string, to: string, progress: number, opacity = 1): string {
  const start = Number.parseInt(from.slice(1), 16);
  const end = Number.parseInt(to.slice(1), 16);
  const fraction = Math.max(0, Math.min(1, progress));
  const channels = [16, 8, 0].map((shift) => {
    const value = start >> shift & 255;
    return Math.round(value + ((end >> shift & 255) - value) * fraction);
  });
  return `rgba(${channels.join(", ")}, ${opacity})`;
}

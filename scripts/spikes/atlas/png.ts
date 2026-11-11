// A dependency-free PNG scatter plot: an RGB raster of filled discs, encoded with node:zlib. The
// spike's pictures are for a human to look at (one colour per level-1 branch), so there are no
// axes, no text and no anti-aliasing beyond a one-pixel soft edge.
import { crc32, deflateSync } from "node:zlib";

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([head, body, tail]);
}

/** Encodes `rgb` (width x height x 3 bytes, row-major) as an 8-bit RGB PNG. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  if (rgb.length !== width * height * 3) throw new Error("The raster does not match its size.");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0; // filter: none
    raw.set(rgb.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

export type Rgb = readonly [number, number, number];

/** Twelve distinguishable hues (a categorical wheel); branches beyond twelve reuse them. */
export const branchPalette: readonly Rgb[] = [
  [31, 119, 180],
  [255, 127, 14],
  [44, 160, 44],
  [214, 39, 40],
  [148, 103, 189],
  [140, 86, 75],
  [227, 119, 194],
  [23, 190, 207],
  [188, 189, 34],
  [0, 0, 0],
  [120, 144, 156],
  [255, 193, 7]
];
export const unlabelledColour: Rgb = [200, 200, 200];

export interface ScatterOptions {
  size?: number;
  /** Disc radius in pixels. */
  radius?: number;
  margin?: number;
}

/**
 * Draws `points` (n x 2) scaled to fit a square canvas, coloured by `labels` (-1 is grey). Labels are
 * drawn from the biggest branch to the smallest so a big branch never hides a small one.
 */
export function scatterPng(
  points: Float64Array,
  labels: Int32Array,
  options: ScatterOptions = {}
): Buffer {
  const size = options.size ?? 1000;
  const radius = options.radius ?? 3;
  const margin = options.margin ?? 24;
  const n = points.length / 2;
  const raster = new Uint8Array(size * size * 3).fill(255);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const x = points[2 * i] as number;
    const y = points[2 * i + 1] as number;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = (size - 2 * margin) / span;
  const offsetX = (size - (maxX - minX) * scale) / 2;
  const offsetY = (size - (maxY - minY) * scale) / 2;
  const counts = new Map<number, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const rank = new Map(
    [...counts.entries()]
      .filter(([label]) => label >= 0)
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([label], index) => [label, index] as const)
  );
  const order = Array.from({ length: n }, (_, index) => index).sort((a, b) => {
    // Grey first, then the biggest branch down to the smallest, which ends up on top.
    const ra = labels[a]! < 0 ? Infinity : (counts.get(labels[a]!) ?? 0);
    const rb = labels[b]! < 0 ? Infinity : (counts.get(labels[b]!) ?? 0);
    return rb - ra || a - b;
  });
  const reach = radius + 1;
  for (const i of order) {
    const label = labels[i] as number;
    const colour =
      label < 0 ? unlabelledColour : branchPalette[(rank.get(label) ?? 0) % branchPalette.length]!;
    const cx = offsetX + ((points[2 * i] as number) - minX) * scale;
    const cy = size - (offsetY + ((points[2 * i + 1] as number) - minY) * scale);
    const x0 = Math.max(0, Math.floor(cx - reach));
    const x1 = Math.min(size - 1, Math.ceil(cx + reach));
    const y0 = Math.max(0, Math.floor(cy - reach));
    const y1 = Math.min(size - 1, Math.ceil(cy + reach));
    for (let y = y0; y <= y1; y += 1)
      for (let x = x0; x <= x1; x += 1) {
        const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (distance > radius + 0.5) continue;
        const cover = distance <= radius - 0.5 ? 1 : radius + 0.5 - distance;
        const at = (y * size + x) * 3;
        for (let c = 0; c < 3; c += 1)
          raster[at + c] = Math.round(
            (raster[at + c] as number) * (1 - cover) + colour[c]! * cover
          );
      }
  }
  return encodePng(size, size, raster);
}

// Seeded pseudo-random numbers (Mulberry32) so every engine run is reproducible. The engine
// never calls Math.random: every random choice derives from a seed and a label (D22).

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Standard normal sample (Box-Muller). */
  gaussian(): number;
  /** Shuffles in place and returns the array. */
  shuffle<T>(values: T[]): T[];
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e3779b9;
  let spare: number | null = null;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    gaussian: () => {
      if (spare !== null) {
        const value = spare;
        spare = null;
        return value;
      }
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      const radius = Math.sqrt(-2 * Math.log(u));
      spare = radius * Math.sin(2 * Math.PI * v);
      return radius * Math.cos(2 * Math.PI * v);
    },
    shuffle: <T>(values: T[]): T[] => {
      for (let index = values.length - 1; index > 0; index -= 1) {
        const other = Math.floor(next() * (index + 1));
        const swap = values[index] as T;
        values[index] = values[other] as T;
        values[other] = swap;
      }
      return values;
    }
  };
}

/** Derives an independent 32-bit seed from a base seed and a label (FNV-1a over the label). */
export function deriveSeed(seed: number, label: string | number): number {
  let hash = (seed ^ 0x811c9dc5) >>> 0;
  for (const char of String(label)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

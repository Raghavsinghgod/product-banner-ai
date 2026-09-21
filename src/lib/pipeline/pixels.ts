// Shared color/pixel math helpers used across the pipeline.
// Keeping these in one place avoids subtle inconsistencies (e.g. one file
// rounding luminance differently than another) and documents the conventions:
//
//   - Luminance is always Rec. 601 (0.299 R + 0.587 G + 0.114 B), the same
//     coefficient set the shadow, upscale, and analysis engines were tuned
//     against. Do NOT switch to 709 without re-tuning thresholds.
//   - All buffers are RGBA, 8 bits per channel, row-major, stride 4.

/** Clamp a value into the 0..255 byte range used by all image buffers. */
export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Clamp a value into an arbitrary [min, max] range. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Rec. 601 luminance of a pixel (0..255 scale when inputs are 0..255). */
export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Chroma magnitude (0..~1 for 8-bit inputs): distance from gray. */
export function chroma(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

/** Smoothstep between 0 and 1 — the standard C1-continuous fade curve. */
export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/** Deterministic PRNG (mulberry32) — same seed, same sequence, everywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 3-iteration separable box blur — a fast, close approximation of a Gaussian
 * with O(1) cost per pixel regardless of radius (sliding-window sums).
 * Returns a new buffer; the input is not modified.
 */
export function boxBlur3(
  src: Float32Array,
  w: number,
  h: number,
  r: number,
): Float32Array {
  let cur = src;
  for (let pass = 0; pass < 3; pass++) cur = boxBlurOnce(cur, w, h, r);
  return cur;
}

function boxBlurOnce(
  src: Float32Array,
  w: number,
  h: number,
  r: number,
): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const norm = 1 / (2 * r + 1);
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * norm;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * norm;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/**
 * Chamfer distance transform inside a binary mask (foreground = 1).
 * Approximates Euclidean distance with a two-pass 3-4 weighted chamfer;
 * result is in "pixel" units (divided by 3 at the end so a unit step = 1).
 * Essential for: contact shadows (shadow.ts) and alpha feathering (segment.ts).
 */
export function distanceInside(
  fg: Uint8Array,
  w: number,
  h: number,
): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(fg.length);
  for (let i = 0; i < fg.length; i++) d[i] = fg[i] ? INF : 0;
  // forward pass (top-left -> bottom-right)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!fg[i]) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + 3);
      if (y > 0) m = Math.min(m, d[i - w] + 3);
      if (x > 0 && y > 0) m = Math.min(m, d[i - w - 1] + 4);
      if (x < w - 1 && y > 0) m = Math.min(m, d[i - w + 1] + 4);
      d[i] = m;
    }
  }
  // backward pass (bottom-right -> top-left)
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!fg[i]) continue;
      let m = d[i];
      if (x < w - 1) m = Math.min(m, d[i + 1] + 3);
      if (y < h - 1) m = Math.min(m, d[i + w] + 3);
      if (x < w - 1 && y < h - 1) m = Math.min(m, d[i + w + 1] + 4);
      if (x > 0 && y < h - 1) m = Math.min(m, d[i + w - 1] + 4);
      d[i] = m;
    }
  }
  for (let i = 0; i < fg.length; i++) d[i] /= 3;
  return d;
}

/** Distance transform of the mask's complement (background -> nearest fg). */
export function distanceOutside(
  bin: Uint8Array,
  w: number,
  h: number,
): Float32Array {
  const inv = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) inv[i] = bin[i] ? 0 : 1;
  return distanceInside(inv, w, h);
}

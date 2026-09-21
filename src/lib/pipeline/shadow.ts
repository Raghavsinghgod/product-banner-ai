// Custom realistic shadow renderer — the secret weapon.
// Everything here is hand-rolled pixel math; no external APIs.
//
// Professional-grade rewrite. The old engine stamped a binary silhouette
// repeatedly and faked blur with a distance falloff — hard stepped edges, no
// true penumbra. This version renders light physically:
//
//   1. Coverage accumulation: the silhouette is swept along the shadow vector
//      in ~40 weighted steps. Where many steps overlap (near contact) coverage
//      saturates to a dense umbra; where few overlap (the far tip) it thins
//      into penumbra. The overlap integral IS the area-light physics.
//   2. Two-scale filtering: the coverage buffer is box-blurred (3 passes ≈
//      Gaussian) at a tight radius and a wide radius, then blended by the
//      distance from the contact footprint — crisp at contact, progressively
//      softer away. This is the classic studio-shadow response.
//   3. Contact shadow (ambient occlusion): a shape-aware tight band from the
//      silhouette distance transform, widened by softness.
//   4. Deterministic organic edges: seeded sine-sum jitter per sweep step, so
//      edges look natural but renders are perfectly reproducible.
//
// Light semantics: `direction` is the light azimuth — 0° = light from the
// right (shadow falls left), 90° = light from above (shadow falls down),
// 180° = light from the left. Shadow is always cast AWAY from the light.

import type { Cutout } from "./segment";

export type ShadowOptions = {
  /** Light azimuth in degrees: 0 = from the right, 90 = from above. */
  direction: number;
  /** Cast length as a fraction of max(bboxW, bboxH). */
  length: number;
  /** 0..1 — penumbra width and overall blur. */
  softness: number;
  /** 0..1 maximum darkness of the shadow core. */
  opacity: number;
  /** Render the tight contact (ambient occlusion) band. */
  contact: boolean;
};

export const DEFAULT_SHADOW: ShadowOptions = {
  direction: 55,
  length: 0.7,
  softness: 0.6,
  opacity: 0.42,
  contact: true,
};

/** Build the shadow layer as an alpha mask the same size as the banner canvas. */
export function renderShadow(
  cutout: Cutout,
  place: { x: number; y: number; scale: number },
  canvasW: number,
  canvasH: number,
  opts: ShadowOptions,
): Uint8ClampedArray {
  const n = canvasW * canvasH;
  const mask = new Uint8ClampedArray(n);

  // ---- rasterize the product silhouette (binary) at placement -------------
  const sil = new Uint8Array(n);
  const { alpha, width: cw, height: ch, box } = cutout;
  const drawW = Math.max(1, Math.round(box.w * place.scale));
  const drawH = Math.max(1, Math.round(box.h * place.scale));
  const baseX = Math.round(place.x - (box.x + box.w / 2) * place.scale);
  const baseY = Math.round(place.y - (box.y + box.h / 2) * place.scale);
  const silList: number[] = [];
  for (let dy = 0; dy < drawH; dy++) {
    const sy = box.y + Math.min(ch - 1, Math.floor(dy / place.scale));
    for (let dx = 0; dx < drawW; dx++) {
      const sx = box.x + Math.min(cw - 1, Math.floor(dx / place.scale));
      if (alpha[(sy * cw + sx) * 4 + 3] > 60) {
        const px = baseX + dx;
        const py = baseY + dy;
        if (px >= 0 && py >= 0 && px < canvasW && py < canvasH) {
          const j = py * canvasW + px;
          if (!sil[j]) {
            sil[j] = 1;
            silList.push(j);
          }
        }
      }
    }
  }
  if (silList.length === 0) return mask;

  const longest = Math.max(box.w, box.h) * place.scale;

  // ---- 1. coverage accumulation: sweep the silhouette ----------------------
  const travel = longest * opts.length;
  const cast = new Float32Array(n);
  if (travel > 0.5) {
    const rad = (opts.direction * Math.PI) / 180;
    // cast AWAY from the light: mirror the azimuth
    const dirX = -Math.cos(rad);
    const dirY = Math.sin(rad) * 0.85; // ground-plane foreshortening

    const steps = Math.max(10, Math.round(40 * (0.45 + opts.length)));
    // deterministic jitter phases (same seed -> reproducible renders)
    const rng = mulberry32(0x9e3779b9);
    const phase1 = rng() * Math.PI * 2;
    const phase2 = rng() * Math.PI * 2;

    // total weight for normalization so acc saturates exactly at umbra
    let wSum = 0;
    const weights = new Float32Array(steps);
    for (let s = 0; s < steps; s++) {
      const t = (s + 1) / steps;
      weights[s] = Math.pow(1 - t, 1.6);
      wSum += weights[s];
    }

    // pre-dilated silhouettes for the area-light spread (radii 0..3)
    const dil: Uint8Array[] = [sil];
    for (let r = 1; r <= 3; r++) dil.push(boxDilate8(dil[r - 1], canvasW, canvasH));

    for (let s = 0; s < steps; s++) {
      const t = (s + 1) / steps;
      const dist = travel * t;
      const w = weights[s];
      // organic edge wobble (deterministic)
      const jx = 0.5 * Math.sin(phase1 + t * 6.1) + 0.3 * Math.sin(phase2 + t * 13.7);
      const ox = dirX * dist + jx * longest * 0.02;
      const oy = dirY * dist;
      const src = dil[Math.min(3, Math.floor(t * 4))];
      stampWeighted(src, silList, canvasW, canvasH, ox, oy, w, cast);
    }
    if (wSum > 0) for (let i = 0; i < n; i++) cast[i] /= wSum;
  }

  // ---- 2. two-scale filtering: sharp at contact, soft away -----------------
  let castSoft = cast;
  if (travel > 0.5) {
    const rNear = Math.max(1, Math.round(longest * 0.012));
    const rFar = Math.max(rNear + 1, Math.round(longest * (0.02 + 0.1 * opts.softness)));
    const tight = boxBlur3(cast, canvasW, canvasH, rNear);
    const soft = boxBlur3(cast, canvasW, canvasH, Math.min(rFar, 40));
    // distance from the contact footprint drives the blend
    const dOut = distanceOutside(sil, canvasW, canvasH);
    const reach = Math.max(1, longest * (0.12 + 0.5 * opts.softness));
    castSoft = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = dOut[i] / reach;
      if (m > 1) m = 1;
      const sm = m * m * (3 - 2 * m); // smoothstep
      castSoft[i] = tight[i] * (1 - sm) + soft[i] * sm;
    }
  }

  // ---- 3. contact shadow (ambient occlusion) -------------------------------
  const ao = new Float32Array(n);
  if (opts.contact) {
    const inner = distanceInside(sil, canvasW, canvasH);
    const outside = distanceOutside(sil, canvasW, canvasH);
    const band = 3 + 5 * opts.softness;
    const ampOut = 0.32 * (0.75 + 0.25 * opts.softness);
    const ampIn = 0.4;
    for (let i = 0; i < n; i++) {
      if (sil[i]) {
        const crevice = Math.max(0, 5 - inner[i]) / 5;
        ao[i] = ampIn * crevice;
      } else {
        const d = outside[i];
        if (d < band) {
          const t = 1 - d / band;
          ao[i] = ampOut * t * t;
        }
      }
    }
  }

  // ---- 4. composite + tone map ---------------------------------------------
  const op = Math.max(0, Math.min(1, opts.opacity));
  for (let i = 0; i < n; i++) {
    let v = Math.max(castSoft[i] * op, ao[i]);
    if (v > 0) {
      v = Math.pow(Math.min(1, v), 1.15); // keep cores rich, tails natural
      mask[i] = Math.round(v * 255);
    }
  }

  return mask;
}

/** Paint the shadow mask onto a destination context as black pixels with alpha. */
export function paintShadow(
  ctx: CanvasRenderingContext2D,
  mask: Uint8ClampedArray,
  w: number,
  h: number,
) {
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const a = mask[i];
    if (a > 0) {
      img.data[i * 4] = 24;
      img.data[i * 4 + 1] = 26;
      img.data[i * 4 + 2] = 30;
      img.data[i * 4 + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ---- internals ---------------------------------------------------------------

/** Add `w` coverage at (x+ox, y+oy) for every silhouette pixel. */
function stampWeighted(
  src: Uint8Array,
  silList: number[],
  w: number,
  h: number,
  ox: number,
  oy: number,
  weight: number,
  dst: Float32Array,
) {
  const ioX = Math.round(ox);
  const ioY = Math.round(oy);
  for (let k = 0; k < silList.length; k++) {
    const i = silList[k];
    if (!src[i]) continue;
    const x = (i % w) + ioX;
    const y = ((i / w) | 0) + ioY;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    dst[y * w + x] += weight;
  }
}

/** 8-connected dilation by radius 1. */
function boxDilate8(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (src[i]) {
        out[i] = 1;
        continue;
      }
      if (
        (x > 0 && src[i - 1]) ||
        (x < w - 1 && src[i + 1]) ||
        (y > 0 && src[i - w]) ||
        (y < h - 1 && src[i + w]) ||
        (x > 0 && y > 0 && src[i - w - 1]) ||
        (x < w - 1 && y > 0 && src[i - w + 1]) ||
        (x > 0 && y < h - 1 && src[i + w - 1]) ||
        (x < w - 1 && y < h - 1 && src[i + w + 1])
      ) {
        out[i] = 1;
      }
    }
  }
  return out;
}

/** Approximate Gaussian blur via 3 iterated separable box blurs. */
function boxBlur3(
  src: Float32Array,
  w: number,
  h: number,
  r: number,
): Float32Array {
  let cur = src;
  for (let pass = 0; pass < 3; pass++) {
    cur = boxBlurOnce(cur, w, h, r);
  }
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
      const add = Math.min(w - 1, x + r + 1);
      const sub = Math.max(0, x - r);
      sum += src[row + add] - src[row + sub];
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * norm;
      const add = Math.min(h - 1, y + r + 1);
      const sub = Math.max(0, y - r);
      sum += tmp[add * w + x] - tmp[sub * w + x];
    }
  }
  return out;
}

function distanceInside(bin: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) d[i] = bin[i] ? INF : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!bin[i]) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + 3);
      if (y > 0) m = Math.min(m, d[i - w] + 3);
      if (x > 0 && y > 0) m = Math.min(m, d[i - w - 1] + 4);
      if (x < w - 1 && y > 0) m = Math.min(m, d[i - w + 1] + 4);
      d[i] = m;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!bin[i]) continue;
      let m = d[i];
      if (x < w - 1) m = Math.min(m, d[i + 1] + 3);
      if (y < h - 1) m = Math.min(m, d[i + w] + 3);
      if (x < w - 1 && y < h - 1) m = Math.min(m, d[i + w + 1] + 4);
      if (x > 0 && y < h - 1) m = Math.min(m, d[i + w - 1] + 4);
      d[i] = m;
    }
  }
  for (let i = 0; i < bin.length; i++) d[i] /= 3;
  return d;
}

function distanceOutside(bin: Uint8Array, w: number, h: number): Float32Array {
  const inv = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) inv[i] = bin[i] ? 0 : 1;
  return distanceInside(inv, w, h);
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

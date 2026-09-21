// Custom realistic shadow renderer — the demo's "secret weapon".
// Everything is hand-rolled pixel math; no external APIs, no canvas filters.
//
// HOW TO READ THIS FILE
// ---------------------
// Two public entry points, one physics core:
//
//   renderShadowIntensity(...) → Float32Array (normalized 0..1 ink per pixel)
//       The EXPENSIVE part: silhouette rasterization, the coverage sweep,
//       two-scale filtering, contact AO. Depends only on geometry
//       (placement + direction + length + softness) — NOT on opacity.
//
//   toneMapShadow(intensity, ...) → Uint8ClampedArray (0..255 alpha mask)
//       The CHEAP part: one linear pass applying opacity + gamma.
//
// The Studio caches the intensity per geometry and re-runs ONLY toneMapShadow
// when the strength slider moves — that's why the slider stays smooth at full
// resolution. renderShadow() is the one-shot convenience for callers that
// don't cache (banner composer, demo, tests).
//
// THE PHYSICS (why it looks real)
// -------------------------------
//   1. Coverage accumulation: the silhouette is swept along the shadow vector
//      in ~40 weighted steps into a float buffer. Where many steps overlap
//      (near contact) coverage saturates → dense UMBRA; where few overlap
//      (the far tip) it thins → PENUMBRA. The overlap integral IS area-light
//      physics — not a fake falloff.
//   2. Two-scale filtering: the coverage buffer is box-blurred (3 passes ≈
//      Gaussian) at a tight radius and a wide radius, blended by distance
//      from the contact footprint — crisp at contact, softer away (the
//      classic studio-shadow response).
//   3. Contact shadow (ambient occlusion): shape-aware tight band from the
//      silhouette distance transform, widened by softness.
//   4. Deterministic organic edges: seeded sine-sum jitter per sweep step —
//      natural-looking edges, byte-identical renders (tests depend on it).
//
// LIGHT SEMANTICS: `direction` is the light AZIMUTH — 0° = light from the
// right (shadow falls LEFT), 90° = from above (falls DOWN), 180° = from the
// left. Shadow is always cast AWAY from the light. Locked by physics tests.

import type { Cutout } from "./segment";
import { boxBlur3, distanceInside, distanceOutside, mulberry32 } from "./pixels";

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

/**
 * Geometry-independent tone mapping: applies opacity + gamma to a normalized
 * shadow intensity buffer. Split out so the Studio can re-render the strength
 * slider without recomputing the (expensive) coverage/filtering stages.
 */
export function toneMapShadow(
  intensity: Float32Array,
  canvasW: number,
  canvasH: number,
  opts: ShadowOptions,
): Uint8ClampedArray {
  const n = canvasW * canvasH;
  const mask = new Uint8ClampedArray(n);
  const op = Math.max(0, Math.min(1, opts.opacity));
  for (let i = 0; i < n; i++) {
    let v = intensity[i] * op;
    if (v > 0) {
      v = Math.pow(Math.min(1, v), 1.15);
      mask[i] = Math.round(v * 255);
    }
  }
  return mask;
}

/**
 * Compute the normalized shadow intensity field (0..1 per pixel) — all the
 * expensive geometry work (coverage sweep, filtering, AO) but NOT the final
 * opacity/gamma tone mapping. Pair with toneMapShadow for cheap re-renders.
 */
export function renderShadowIntensity(
  cutout: Cutout,
  place: { x: number; y: number; scale: number },
  canvasW: number,
  canvasH: number,
  opts: ShadowOptions,
): Float32Array {
  const n = canvasW * canvasH;
  const intensity = new Float32Array(n);
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
  if (silList.length === 0) return intensity;

  const longest = Math.max(box.w, box.h) * place.scale;

  // ---- 1. coverage accumulation: sweep the silhouette ----------------------
  // Each step stamps a pre-dilated copy of the silhouette (dilation grows
  // with t — the area-light widens as the shadow travels) at increasing
  // distance along the cast vector, weighted by (1-t)^1.6. Weights are
  // normalized so coverage saturates at exactly 1.0 in the umbra.
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
  // Blend a tight blur (near footprint) into a wide blur (far away) using a
  // smoothstep over the distance from the product. distanceOutside is shared
  // with Stage 3 below — it's a full-canvas chamfer pass, never run twice.
  let sharedOutside: Float32Array | null = null;
  const getOutside = () => (sharedOutside ??= distanceOutside(sil, canvasW, canvasH));

  let castSoft = cast;
  if (travel > 0.5) {
    const rNear = Math.max(1, Math.round(longest * 0.012));
    const rFar = Math.max(rNear + 1, Math.round(longest * (0.02 + 0.1 * opts.softness)));
    const tight = boxBlur3(cast, canvasW, canvasH, rNear);
    const soft = boxBlur3(cast, canvasW, canvasH, Math.min(rFar, 40));
    // distance from the contact footprint drives the blend
    const dOut = getOutside();
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
  // A tight dark band hugging the silhouette: outside it falls off with
  // distance squared; inside, crevices (small distance-to-edge) darken most —
  // this is what makes the product look like it WEIGHS something.
  const ao = new Float32Array(n);
  if (opts.contact) {
    const inner = distanceInside(sil, canvasW, canvasH);
    const outside = getOutside();
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

  // ---- 4. composite: normalize intensity (tone-mapping is a separate step) -
  for (let i = 0; i < n; i++) {
    intensity[i] = Math.max(castSoft[i], ao[i]);
  }

  return intensity;
}

/**
 * One-shot convenience: intensity + tone mapping in a single call. The Studio
 * uses the split API (renderShadowIntensity + toneMapShadow) so the strength
 * slider only redoes the cheap tone-mapping step.
 */
export function renderShadow(
  cutout: Cutout,
  place: { x: number; y: number; scale: number },
  canvasW: number,
  canvasH: number,
  opts: ShadowOptions,
): Uint8ClampedArray {
  return toneMapShadow(renderShadowIntensity(cutout, place, canvasW, canvasH, opts), canvasW, canvasH, opts);
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

/** Add `w` coverage at (x+ox, y+oy) for every silhouette pixel.
 *  (src limits stamps to the pre-dilated ring — the area-light spread.) */
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

/** 8-connected dilation by radius 1 (the area-light grows as it travels). */
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

// (blur + distance-transform + PRNG helpers live in ./pixels — shared with
//  segment.ts and upscale.ts so the tuning stays consistent across engines.)

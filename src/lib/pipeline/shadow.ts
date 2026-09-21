// Custom realistic shadow renderer — the secret weapon.
// Everything here is hand-rolled pixel math; no external APIs.
//
// Layers:
//  1. Contact shadow (ambient occlusion): tight dark band where the product
//     actually touches the surface, shape-aware (silhouette distance transform).
//  2. Cast shadow: silhouette heaved along a light direction with per-step
//     horizontal jitter (height noise) and progressive blur — soft at contact,
//     crisp directionally, faint at the tip.

import type { Cutout } from "./segment";

export type ShadowOptions = {
  direction: number; // degrees, 0 = light from right -> shadow cast left
  length: number; // cast length as fraction of max(bboxW, bboxH)
  softness: number; // 0..1 overall blur strength
  opacity: number; // 0..1 max darkness
  contact: boolean; // render the tight contact band
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
  const mask = new Uint8ClampedArray(n); // 0..255 shadow alpha

  // Rasterize the product silhouette (binary) at placement
  const sil = new Uint8Array(n);
  const { alpha, width: cw, height: ch, box } = cutout;
  const drawW = Math.max(1, Math.round(box.w * place.scale));
  const drawH = Math.max(1, Math.round(box.h * place.scale));
  const baseX = Math.round(place.x - (box.x + box.w / 2) * place.scale);
  const baseY = Math.round(place.y - (box.y + box.h / 2) * place.scale);
  for (let dy = 0; dy < drawH; dy++) {
    const sy = box.y + Math.min(ch - 1, Math.floor(dy / place.scale));
    for (let dx = 0; dx < drawW; dx++) {
      const sx = box.x + Math.min(cw - 1, Math.floor(dx / place.scale));
      if (alpha[(sy * cw + sx) * 4 + 3] > 60) {
        const px = baseX + dx;
        const py = baseY + dy;
        if (px >= 0 && py >= 0 && px < canvasW && py < canvasH) {
          sil[py * canvasW + px] = 1;
        }
      }
    }
  }

  // ---- 1. Contact shadow (ambient occlusion via distance transform) ------
  if (opts.contact) {
    const inner = distanceInside(sil, canvasW, canvasH);
    const outside = distanceOutside(sil, canvasW, canvasH);
    const strength = 0.65 + 0.35 * opts.softness;
    for (let i = 0; i < n; i++) {
      if (sil[i]) {
        // crevices get darker (AO), flat tops stay light
        const crevice = Math.max(0, 6 - inner[i]) / 6;
        mask[i] = Math.max(mask[i], 110 * crevice * strength);
      } else {
        const d = outside[i];
        if (d <= 5) {
          const t = 1 - d / 5;
          mask[i] = Math.max(mask[i], 150 * t * t * strength);
        }
      }
    }
  }

  // ---- 2. Cast shadow: heaved silhouette + progressive blur --------------
  const dirRad = (opts.direction * Math.PI) / 180;
  const dirX = Math.cos(dirRad);
  const dirY = Math.sin(dirRad);
  const longest = Math.max(box.w, box.h) * place.scale;
  const steps = Math.max(8, Math.round(38 * (0.5 + opts.length)));
  const travel = longest * opts.length;
  if (travel > 0.5) {
  const heaved = new Uint8Array(n);
  const rng = mulberry32(0x9e3779b9);
  // deterministic jitter profile: sum of two sines + tiny noise
  const phase1 = rng() * Math.PI * 2;
  const phase2 = rng() * Math.PI * 2;
  const noise = new Float32Array(steps);
  for (let s = 0; s < steps; s++) {
    const t = s / steps;
    noise[s] =
      0.55 * Math.sin(phase1 + t * 6.1) +
      0.3 * Math.sin(phase2 + t * 13.7) +
      0.15 * (rng() * 2 - 1);
  }

  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const dist = travel * t;
    const ox = dirX * dist + noise[s - 1] * longest * 0.018;
    const oy = dirY * dist * (0.82 + 0.18 * Math.sin(phase1)); // foreshortened vertical drift
    const fade = (1 - t) * (1 - t); // quadratic falloff
    const grow = 1 + t * 0.05; // slight expansion away from contact
    stampScaled(sil, canvasW, canvasH, ox, oy, grow, heaved, fade);
  }

  // Distance outward from the heaved region -> progressive blur kernel size
  const heavedOut = distanceOutside(heaved, canvasW, canvasH);
  const blurBase = 2 + 14 * opts.softness;
  for (let i = 0; i < n; i++) {
    const d = heavedOut[i];
    if (d === 0 && heaved[i]) {
      mask[i] = Math.max(mask[i], 255 * opts.opacity);
    } else if (d > 0 && d < blurBase * 2.2) {
      const t = 1 - d / (blurBase * 2.2);
      const a = 255 * opts.opacity * t * t;
      mask[i] = Math.max(mask[i], a);
    }
  }
  } // end cast guard (travel > 0.5)

  // Gamma lift so shadow cores stay rich but edges fall off naturally
  for (let i = 0; i < n; i++) {
    if (mask[i] > 0) {
      const v = mask[i] / 255;
      mask[i] = Math.round(Math.pow(v, 1.25) * 255);
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

/** Stamp src into dst offset by (ox, oy) scaled about the product base center. */
function stampScaled(
  src: Uint8Array,
  w: number,
  h: number,
  ox: number,
  oy: number,
  grow: number,
  dst: Uint8Array,
  fade: number,
) {
  // Only stamp where src is set; grow achieved by stamping 4 sub-offsets
  const sub = grow > 1 ? 4 : 1;
  for (let i = 0; i < w * h; i++) {
    if (!src[i]) continue;
    const x = i % w;
    const y = (i / w) | 0;
    for (let s = 0; s < sub; s++) {
      const ang = (s / sub) * Math.PI * 2;
      const rr = grow > 1 ? (grow - 1) * 6 : 0;
      const px = Math.round(x + ox + Math.cos(ang) * rr);
      const py = Math.round(y + oy + Math.sin(ang) * rr);
      if (px >= 0 && py >= 0 && px < w && py < h) {
        const j = py * w + px;
        if (!dst[j]) dst[j] = 1;
        else if (fade > 0.9) dst[j] = 1;
      }
    }
  }
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

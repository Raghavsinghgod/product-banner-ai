// Generative design engine — a unique, coherent studio scene on demand.
//
// HOW UNIQUENESS WORKS: a seed drives a mulberry32 PRNG that picks the scene's
// specifics (palette family, light angle, shapes, floor, grain) — while
// HARMONY RULES (not randomness) constrain how those choices relate to the
// product: the backdrop hue is derived from the product's dominant color via
// analogous/complement/neutral strategies, so every random design still
// flatters the product. Consequences:
//
//   same seed  → byte-identical design (the "Replay this exact design" button)
//   new seed   → a genuinely different, never-repeated look
//
// paintDesign() draws at banner resolution on a 2D canvas; the compositor
// renders it behind the cutout in place of a fixed backdrop gradient.

import type { StyleAnalysis } from "./styles";

export type GeneratedDesign = {
  seed: number;
  /** Base gradient stops (top, bottom) in css color strings. */
  top: string;
  bottom: string;
  /** Accent hue (0..360) harmonized with the product palette. */
  accentHue: number;
  /** Light setup chosen for this scene. */
  light: {
    /** Light azimuth in degrees (drives the shadow engine to match!). */
    direction: number;
    softness: number;
    opacity: number;
    /** Warm (1) .. cool (-1) light tint. */
    temperature: number;
  };
  /** Surface treatment of the backdrop. */
  surface: {
    /** Subtle vignette strength 0..1. */
    vignette: number;
    /** Paper-grain amount 0..1. */
    grain: number;
    /** Optional soft geometric shapes in the backdrop. */
    shapes: Array<{
      kind: "circle" | "arc" | "band";
      x: number; y: number; r: number;
      alpha: number;
      hue: number;
    }>;
    /** Floor style under the product. */
    floor: "seam" | "reflect" | "none";
  };
  /** Suggested backdrop family name for the UI. */
  family: string;
};

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
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
 * HSL color with explicit alpha, in the legacy comma-separated syntax
 * canvas 2D accepts everywhere (`hsla(h, s%, l%, a)`).
 * NOTE: the modern space-separated form `hsl(h s% l% / a)` is what `hsl()`
 * above emits for opaque fills, but `addColorStop` chokes on mixing that
 * syntax with a comma alpha — so gradients always use THIS helper.
 */
function hsla(h: number, s: number, l: number, a: number): string {
  return `hsla(${Math.round(((h % 360) + 360) % 360)}, ${Math.round(s)}%, ${Math.round(l)}%, ${a})`;
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

const FAMILIES = [
  "Editorial",
  "Atelier",
  "Gallery",
  "Sunlit",
  "Nocturne",
  "Pastel Study",
] as const;

/**
 * Generate a unique-but-coherent design from an analysis + seed.
 * Harmony rules (not randomness) pick the *relationship* between the design
 * and the product; randomness picks the specifics.
 */
export function generateDesign(analysis: StyleAnalysis | null, seed: number): GeneratedDesign {
  const rng = makeRng(seed);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

  // --- palette harmony: derive the backdrop hue from the product palette ---
  // dominant product hue (0 if unknown/neutral)
  let productHue = 0;
  let productSat = 0;
  if (analysis && analysis.palette.length > 0) {
    // read the most saturated palette color
    let best = 0;
    for (const hex of analysis.palette) {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      if (sat > productSat) {
        productSat = sat;
        let h = 0;
        if (mx !== mn) {
          const d = mx - mn;
          if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
          else if (mx === g) h = ((b - r) / d + 2) * 60;
          else h = ((r - g) / d + 4) * 60;
        }
        productHue = h;
      }
    }
  }

  // harmony strategy: analogous / complement / near-neutral
  const strategy = productSat > 0.3 ? pick(["analogous", "complement", "analogous"] as const) : pick(["neutral-warm", "neutral-cool"] as const);
  let baseHue: number;
  let sat: number;
  if (strategy === "analogous") baseHue = productHue + (rng() * 40 - 20);
  else if (strategy === "complement") baseHue = productHue + 180 + (rng() * 24 - 12);
  else baseHue = rng() < 0.5 ? 30 + rng() * 20 : 200 + rng() * 30;
  sat = strategy.startsWith("neutral") ? 8 + rng() * 14 : 16 + rng() * 22;

  const family = pick(FAMILIES);
  const dark = family === "Nocturne" || (family === "Gallery" && rng() < 0.35);
  const topL = dark ? 14 + rng() * 10 : 88 + rng() * 6;
  const botL = dark ? 7 + rng() * 6 : topL - (10 + rng() * 14);
  const hueDrift = rng() * 16 - 8;

  // --- light: coherent with the family, matched later by the shadow engine ---
  const direction = Math.round(rng() * 180);
  const temperature = family === "Sunlit" ? 0.5 + rng() * 0.5 : rng() * 1.4 - 0.7;

  // --- surface: shapes + grain + vignette ---
  const shapeCount = Math.floor(rng() * 3); // 0..2 shapes
  const shapes: GeneratedDesign["surface"]["shapes"] = [];
  for (let i = 0; i < shapeCount; i++) {
    shapes.push({
      kind: pick(["circle", "arc", "band"] as const),
      x: 0.15 + rng() * 0.7,
      y: 0.12 + rng() * 0.45,
      r: 0.18 + rng() * 0.35,
      alpha: 0.05 + rng() * 0.09,
      hue: baseHue + hueDrift + (rng() * 30 - 15),
    });
  }

  return {
    seed,
    top: hsl(baseHue, sat, topL),
    bottom: hsl(baseHue + hueDrift, sat * 0.9, botL),
    accentHue: (baseHue + 180) % 360,
    light: {
      direction,
      softness: 0.4 + rng() * 0.5,
      opacity: 0.3 + rng() * 0.25,
      temperature,
    },
    surface: {
      vignette: dark ? 0.4 + rng() * 0.3 : 0.12 + rng() * 0.2,
      grain: family === "Editorial" || family === "Atelier" ? 0.05 + rng() * 0.08 : rng() * 0.04,
      shapes,
      floor: pick(["seam", "reflect", "none"] as const),
    },
    family,
  };
}

/** Warm/cool light tint as rgba overlay color for the light pool. */
export function lightTint(temperature: number): string {
  // temperature 1 = warm (sunset), -1 = cool (north window)
  const t = Math.max(-1, Math.min(1, temperature));
  const h = t >= 0 ? 36 - t * 14 : 210 + Math.abs(t) * 16;
  const s = 40 + Math.abs(t) * 45;
  return hsl(h, s, 88);
}

/**
 * Paint a generated design onto a canvas of W x H.
 * Deterministic per design (no hidden state).
 */
export function paintDesign(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  design: GeneratedDesign,
) {
  const { surface } = design;

  // base gradient
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, design.top);
  g.addColorStop(1, design.bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // soft geometric shapes behind the product
  for (const s of surface.shapes) {
    ctx.save();
    ctx.globalAlpha = s.alpha;
    ctx.fillStyle = hsl(s.hue, 30, 60);
    if (s.kind === "circle") {
      ctx.beginPath();
      ctx.arc(s.x * W, s.y * H, s.r * Math.min(W, H), 0, Math.PI * 2);
      ctx.fill();
    } else if (s.kind === "arc") {
      ctx.beginPath();
      ctx.lineWidth = Math.min(W, H) * 0.02;
      ctx.strokeStyle = hsl(s.hue, 30, 60);
      ctx.arc(s.x * W, s.y * H, s.r * Math.min(W, H), Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    } else {
      // band: wide diagonal stripe
      ctx.translate(s.x * W, s.y * H);
      ctx.rotate(-0.35);
      ctx.fillRect(-W, -H * 0.045, W * 2, H * 0.09);
    }
    ctx.restore();
  }

  // light pool from the design's light direction (ties backdrop to shadow)
  const rad = (design.light.direction * Math.PI) / 180;
  const lx = W * (0.5 + Math.cos(rad) * 0.28);
  const ly = H * (0.16 + Math.sin(rad) * 0.06);
  const pool = ctx.createRadialGradient(lx, ly, 0, lx, ly, Math.max(W, H) * 0.75);
  // Warm/cool light tint, re-derived at reduced lightness + 0.34 alpha —
  // computed directly (NOT by string surgery on lightTint's output, which
  // produced invalid `hsla(210 40% 72%, 0.34)` and threw in addColorStop).
  const t = Math.max(-1, Math.min(1, design.light.temperature));
  const tintHue = t >= 0 ? 36 - t * 14 : 210 + Math.abs(t) * 16;
  const tintSat = 40 + Math.abs(t) * 45;
  pool.addColorStop(0, hsla(tintHue, tintSat, 72, 0.34));
  pool.addColorStop(1, "hsla(0, 0%, 50%, 0)");
  ctx.fillStyle = pool;
  ctx.fillRect(0, 0, W, H);

  // floor treatment
  if (surface.floor === "seam") {
    const fy = H * 0.72;
    const fg = ctx.createLinearGradient(0, fy, 0, H);
    fg.addColorStop(0, "hsla(0, 0%, 50%, 0)");
    fg.addColorStop(1, "hsla(0, 0%, 20%, 0.10)");
    ctx.fillStyle = fg;
    ctx.fillRect(0, fy, W, H - fy);
    ctx.strokeStyle = "hsla(0, 0%, 30%, 0.10)";
    ctx.lineWidth = Math.max(1, H * 0.002);
    ctx.beginPath();
    ctx.moveTo(0, fy);
    ctx.lineTo(W, fy);
    ctx.stroke();
  } else if (surface.floor === "reflect") {
    const fy = H * 0.76;
    const rg = ctx.createLinearGradient(0, fy, 0, H);
    rg.addColorStop(0, "hsla(0, 0%, 100%, 0.10)");
    rg.addColorStop(0.5, "hsla(0, 0%, 100%, 0.02)");
    rg.addColorStop(1, "hsla(0, 0%, 100%, 0)");
    ctx.fillStyle = rg;
    ctx.fillRect(0, fy, W, H - fy);
  }

  // vignette
  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
  vg.addColorStop(0, "hsla(0, 0%, 0%, 0)");
  vg.addColorStop(1, `hsla(0, 0%, 0%, ${surface.vignette.toFixed(2)})`);
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  // paper grain (procedural, sparse — cheap and deterministic)
  if (surface.grain > 0.01) {
    const rng = makeRng(design.seed ^ 0x5f3759df);
    const dots = Math.floor(W * H * 0.002);
    ctx.fillStyle = `hsla(0, 0%, 0%, ${(surface.grain * 0.5).toFixed(3)})`;
    for (let i = 0; i < dots; i++) {
      const x = rng() * W;
      const y = rng() * H;
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.fillStyle = `hsla(0, 0%, 100%, ${(surface.grain * 0.4).toFixed(3)})`;
    for (let i = 0; i < dots; i++) {
      const x = rng() * W;
      const y = rng() * H;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

/** Random seed for the "surprise me" flow. */
export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

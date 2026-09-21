// Targeted tests for the pipeline changes: style analysis, style
// recommendation, the segment -> analyze integration, and the shadow
// renderer's math. Run with: bun test tests/
import { describe, expect, test } from "bun:test";

import type { Cutout } from "../src/lib/pipeline/segment";
import { segment } from "../src/lib/pipeline/segment";
import { renderShadow, DEFAULT_SHADOW } from "../src/lib/pipeline/shadow";
import {
  analyzeCutout,
  getStyle,
  OUTPUT_STYLES,
  recommendStyles,
} from "../src/lib/pipeline/styles";

// --------------------------------------------------------------- fixtures

/** Build a synthetic Cutout: a solid-color rectangle with RGB preserved. */
function makeCutout(
  rgb: [number, number, number],
  w = 40,
  h = 40,
  inset = 10,
): Cutout {
  const alpha = new Uint8ClampedArray(w * h * 4);
  for (let y = inset; y < h - inset; y++) {
    for (let x = inset; x < w - inset; x++) {
      const p = (y * w + x) * 4;
      alpha[p] = rgb[0];
      alpha[p + 1] = rgb[1];
      alpha[p + 2] = rgb[2];
      alpha[p + 3] = 255;
    }
  }
  return {
    alpha,
    width: w,
    height: h,
    softPixels: 0,
    touchedEdges: new Set(),
    box: { x: inset, y: inset, w: w - inset * 2, h: h - inset * 2 },
  };
}

/** Synthetic photo: solid light-gray background + colored product block. */
function makePhoto(
  bg: [number, number, number],
  product: [number, number, number],
  w = 40,
  h = 40,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const inside =
      i % w >= 8 && i % w < w - 8 && Math.floor(i / w) >= 8 && Math.floor(i / w) < h - 8;
    const c = inside ? product : bg;
    rgba[i * 4] = c[0];
    rgba[i * 4 + 1] = c[1];
    rgba[i * 4 + 2] = c[2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

// -------------------------------------------------- OUTPUT_STYLES integrity

describe("OUTPUT_STYLES", () => {
  test("contains exactly the five shipping styles", () => {
    expect(OUTPUT_STYLES.map((s) => s.id)).toEqual([
      "pure-white",
      "white-shadow",
      "premium-desk",
      "studio",
      "moody",
    ]);
  });

  test("pure-white is the only shadowless style", () => {
    for (const s of OUTPUT_STYLES) {
      if (s.id === "pure-white") expect(s.shadows).toBe(false);
      else expect(s.shadows).toBe(true);
    }
  });

  test("getStyle falls back to the first style on unknown id", () => {
    expect(getStyle("nope" as never).id).toBe("pure-white");
  });

  test("every shadowed style has opacity within the engine's slider range", () => {
    for (const s of OUTPUT_STYLES) {
      if (!s.shadows) continue;
      expect(s.shadow.opacity).toBeGreaterThanOrEqual(0.1);
      expect(s.shadow.opacity).toBeLessThanOrEqual(0.8);
      expect(s.shadow.direction).toBeGreaterThanOrEqual(0);
      expect(s.shadow.direction).toBeLessThanOrEqual(180);
    }
  });
});

// ----------------------------------------------------------- analyzeCutout

describe("analyzeCutout", () => {
  test("extracts the dominant palette color from a solid cutout", () => {
    const a = analyzeCutout(makeCutout([200, 60, 60])); // red mug
    expect(a.palette.length).toBeGreaterThanOrEqual(1);
    const hex = a.palette[0];
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    // dominant color should be recognizably red (r channel dominant)
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(120);
    expect(b).toBeLessThan(120);
  });

  test("reads real RGB, not zeroed channels (regression for the RGB fix)", () => {
    const a = analyzeCutout(makeCutout([240, 240, 240])); // near-white product
    expect(a.tone).toBeGreaterThan(0.8);
  });

  test("classifies a bright matte product correctly", () => {
    const a = analyzeCutout(makeCutout([235, 235, 235]));
    expect(a.tone).toBeGreaterThan(0.8);
    expect(a.category).toBe("General product");
    expect(a.softGoods).toBe(false);
  });

  test("flags skin-ish tones as soft goods", () => {
    const a = analyzeCutout(makeCutout([210, 170, 140])); // warm tan (apparel-like)
    expect(a.softGoods).toBe(true);
    expect(a.category).toBe("Soft goods / apparel");
  });

  test("measures stay within sane bounds", () => {
    const a = analyzeCutout(makeCutout([120, 40, 200]));
    expect(a.tone).toBeGreaterThanOrEqual(0);
    expect(a.tone).toBeLessThanOrEqual(1);
    expect(a.contrast).toBeGreaterThanOrEqual(0);
    expect(a.saturation).toBeGreaterThanOrEqual(0);
    expect(a.saturation).toBeLessThanOrEqual(1);
    expect(a.glossy).toBeGreaterThanOrEqual(0);
    expect(a.glossy).toBeLessThanOrEqual(1);
  });
});

// --------------------------------------------------------- recommendStyles

describe("recommendStyles", () => {
  test("bright products land on a white style first", () => {
    const a = analyzeCutout(makeCutout([240, 240, 240]));
    const rec = recommendStyles(a);
    expect(rec).toHaveLength(5);
    // Both white styles must beat every non-white style for bright products;
    // white-shadow (the flagship default) edges out pure-white.
    expect(rec[0]).toBe("white-shadow");
    expect(rec[1]).toBe("pure-white");
  });

  test("dark products get pushed toward moody", () => {
    const bright = recommendStyles(analyzeCutout(makeCutout([240, 240, 240])));
    const dark = recommendStyles(analyzeCutout(makeCutout([25, 25, 30])));
    expect(dark.indexOf("moody")).toBeLessThan(bright.indexOf("moody"));
  });

  test("recommendations include every style exactly once", () => {
    const rec = recommendStyles(analyzeCutout(makeCutout([10, 180, 90])));
    expect(new Set(rec).size).toBe(5);
  });
});

// ------------------------------------------------- segment -> analyze flow

describe("segment + analyzeCutout integration", () => {
  test("a cutout from segment() yields a usable analysis (RGB survives the pipeline)", () => {
    const photo = makePhoto([210, 208, 202], [200, 60, 60]);
    const cutout = segment(photo, 40, 40, { tolerance: 26 });
    const a = analyzeCutout(cutout);
    expect(a.palette.length).toBeGreaterThanOrEqual(1);
    // The red product should survive into the analysis: tone must not be
    // neutral gray, and the palette should not be the background color.
    expect(a.saturation).toBeGreaterThan(0.1);
    expect(a.category).not.toBe("Dark product");
  });

  test("segment output feeds renderShadow without crashing and produces ink", () => {
    const photo = makePhoto([210, 208, 202], [200, 60, 60]);
    const cutout = segment(photo, 40, 40, { tolerance: 26 });
    const W = 200;
    const H = 200;
    const place = { x: W / 2, y: H * 0.72, scale: 2 };
    const mask = renderShadow(cutout, place, W, H, DEFAULT_SHADOW);
    expect(mask).toHaveLength(W * H);
    let inked = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] > 0) inked++;
    expect(inked).toBeGreaterThan(0);
  });

  test("zero-length cast with no contact yields (near-)empty mask — shadowless gating is meaningful", () => {
    const cutout = makeCutout([200, 60, 60]);
    const W = 160;
    const H = 160;
    const place = { x: W / 2, y: H * 0.7, scale: 1.5 };
    const mask = renderShadow(
      cutout,
      place,
      W,
      H,
      { direction: 55, length: 0, softness: 0.6, opacity: 0.42, contact: false },
    );
    let inked = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] > 0) inked++;
    expect(inked).toBe(0);
  });
});

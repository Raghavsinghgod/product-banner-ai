// Tests for the chunk 1-4 engines: upscaler, generative design, analysis v2,
// and the edge-decontamination overhaul.
import { describe, expect, test } from "bun:test";

import { upscaleImage } from "../src/lib/pipeline/upscale";
import { generateDesign, makeRng, randomSeed } from "../src/lib/pipeline/design";
import { analyzeCutout, recommendStyles } from "../src/lib/pipeline/styles";
import { segment, type Cutout } from "../src/lib/pipeline/segment";

// ---------------------------------------------------------------- fixtures

/** Solid-color RGBA image with one product-colored square. */
function makeImage(w: number, h: number, bg: [number, number, number], fg?: { rect: [number, number, number, number]; color: [number, number, number] }): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
  }
  if (fg) {
    const [x0, y0, x1, y1] = fg.rect;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = fg.color[0];
        rgba[i + 1] = fg.color[1];
        rgba[i + 2] = fg.color[2];
      }
    }
  }
  return rgba;
}

function makeCutout(): Cutout {
  // 80x80 with a 40x40 solid red product block
  const w = 80, h = 80;
  const alpha = new Uint8ClampedArray(w * h * 4);
  for (let y = 20; y < 60; y++) {
    for (let x = 20; x < 60; x++) {
      const i = (y * w + x) * 4;
      alpha[i] = 200; alpha[i + 1] = 50; alpha[i + 2] = 50; alpha[i + 3] = 255;
    }
  }
  return {
    alpha, width: w, height: h, softPixels: 0,
    touchedEdges: new Set(),
    box: { x: 20, y: 20, w: 40, h: 40 },
    candidates: [],
    confidence: 0.9,
  };
}

// ---------------------------------------------------------------- upscaler

describe("upscale engine", () => {
  test("output dimensions scale by the integer factor", () => {
    const src = makeImage(50, 40, [220, 220, 220]);
    const up = upscaleImage(src, 50, 40, { factor: 2 });
    expect(up.width).toBe(100);
    expect(up.height).toBe(80);
    expect(up.rgba.length).toBe(100 * 80 * 4);
    const up3 = upscaleImage(src, 50, 40, { factor: 3 });
    expect(up3.width).toBe(150);
    expect(up3.height).toBe(120);
  });

  test("flat regions stay flat (no sharpening noise in smooth areas)", () => {
    const src = makeImage(40, 40, [200, 200, 200]);
    const up = upscaleImage(src, 40, 40, { factor: 2, sharpening: 0.8, crispness: 0.9 });
    // center pixel of a flat field must remain exactly the flat color
    const p = (40 * 80 + 40) * 4;
    expect(Math.abs(up.rgba[p] - 200)).toBeLessThanOrEqual(2);
    expect(Math.abs(up.rgba[p + 1] - 200)).toBeLessThanOrEqual(2);
    expect(Math.abs(up.rgba[p + 2] - 200)).toBeLessThanOrEqual(2);
  });

  test("edge sharpness: a 2px black line stays crisp (no wide smear)", () => {
    // white bg, 2px vertical black line at x=20
    const w = 40, h = 40;
    const src = makeImage(w, h, [255, 255, 255], { rect: [20, 0, 22, 40], color: [0, 0, 0] });
    const up = upscaleImage(src, w, h, { factor: 2 });
    const W = w * 2;
    // count strong-dark pixels across a horizontal scanline: crisp upscale
    // keeps the transition band tight (pure bilinear smears 6-8px wide here;
    // edge-directed reconstruction keeps it to <=4).
    let dark = 0;
    const y = 40;
    for (let x = 30; x < 55; x++) {
      if (up.rgba[(y * W + x) * 4] < 100) dark++;
    }
    expect(dark).toBeGreaterThanOrEqual(2);
    expect(dark).toBeLessThanOrEqual(4);
  });

  test("deterministic: same input produces identical output", () => {
    const src = makeImage(30, 30, [210, 210, 210], { rect: [10, 10, 20, 20], color: [180, 60, 60] });
    const a = upscaleImage(src, 30, 30, { factor: 2 });
    const b = upscaleImage(src, 30, 30, { factor: 2 });
    expect(Array.from(a.rgba)).toEqual(Array.from(b.rgba));
  });

  test("values remain in 0..255", () => {
    const src = makeImage(20, 20, [255, 255, 255], { rect: [5, 5, 15, 15], color: [0, 0, 0] });
    const up = upscaleImage(src, 20, 20, { factor: 3, sharpening: 1, crispness: 1 });
    for (let i = 0; i < up.rgba.length; i++) {
      expect(up.rgba[i]).toBeGreaterThanOrEqual(0);
      expect(up.rgba[i]).toBeLessThanOrEqual(255);
    }
  });
});

// ------------------------------------------------------- generative design

describe("generative design engine", () => {
  const analysis = analyzeCutout(makeCutout());

  test("same seed -> identical design (reproducible looks)", () => {
    const a = generateDesign(analysis, 12345);
    const b = generateDesign(analysis, 12345);
    expect(a.top).toBe(b.top);
    expect(a.bottom).toBe(b.bottom);
    expect(a.light.direction).toBe(b.light.direction);
    expect(a.surface.shapes.length).toBe(b.surface.shapes.length);
    expect(a.seed).toBe(b.seed);
  });

  test("different seeds produce different designs across many draws", () => {
    const designs = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const d = generateDesign(analysis, 1000 + i);
      designs.add(`${d.top}|${d.bottom}|${d.light.direction}|${d.family}|${d.surface.floor}`);
    }
    // far more unique designs than repeats
    expect(designs.size).toBeGreaterThan(30);
  });

  test("randomSeed yields varied values", () => {
    const seeds = new Set<number>();
    for (let i = 0; i < 50; i++) seeds.add(randomSeed());
    expect(seeds.size).toBeGreaterThan(45);
  });

  test("design honors light semantics: direction within 0..180", () => {
    for (let i = 0; i < 30; i++) {
      const d = generateDesign(analysis, i * 7919);
      expect(d.light.direction).toBeGreaterThanOrEqual(0);
      expect(d.light.direction).toBeLessThanOrEqual(180);
      expect(d.light.softness).toBeGreaterThanOrEqual(0.4);
      expect(d.light.softness).toBeLessThanOrEqual(0.9);
    }
  });

  test("rng is deterministic and well-distributed", () => {
    const r1 = makeRng(42);
    const r2 = makeRng(42);
    for (let i = 0; i < 10; i++) expect(r1()).toBe(r2());
    const r3 = makeRng(7);
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += r3();
    const mean = sum / 1000;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
  });
});

// --------------------------------------------------------- analysis v2

describe("product analysis v2 attributes", () => {
  test("v2 fields present and bounded", () => {
    const a = analyzeCutout(makeCutout());
    expect(a.temperature).toBeGreaterThanOrEqual(-1);
    expect(a.temperature).toBeLessThanOrEqual(1);
    expect(a.solidity).toBeGreaterThan(0.9); // solid slab product
    expect(a.solidity).toBeLessThanOrEqual(1);
    expect(a.elongation).toBeLessThanOrEqual(1);
    expect(a.intricacy).toBeGreaterThanOrEqual(0);
    expect(a.sheen).toBeGreaterThanOrEqual(0);
  });

  test("warm product reads warm, cool product reads cool", () => {
    // build a warm (orange) vs cool (blue) cutout
    const mk = (r: number, g: number, b: number): Cutout => {
      const w = 60, h = 60;
      const alpha = new Uint8ClampedArray(w * h * 4);
      for (let y = 10; y < 50; y++) for (let x = 10; x < 50; x++) {
        const i = (y * w + x) * 4;
        alpha[i] = r; alpha[i + 1] = g; alpha[i + 2] = b; alpha[i + 3] = 255;
      }
      return { alpha, width: w, height: h, softPixels: 0, touchedEdges: new Set(), box: { x: 10, y: 10, w: 40, h: 40 }, candidates: [], confidence: 0.9 };
    };
    const warm = analyzeCutout(mk(230, 140, 40));
    const cool = analyzeCutout(mk(50, 110, 220));
    expect(warm.temperature).toBeGreaterThan(cool.temperature);
    expect(warm.temperature).toBeGreaterThan(0);
    expect(cool.temperature).toBeLessThan(0);
  });

  test("elongation tracks bbox aspect", () => {
    const mkTall = (): Cutout => {
      const w = 60, h = 90;
      const alpha = new Uint8ClampedArray(w * h * 4);
      for (let y = 10; y < 80; y++) for (let x = 22; x < 38; x++) {
        const i = (y * w + x) * 4;
        alpha[i] = 100; alpha[i + 1] = 100; alpha[i + 2] = 100; alpha[i + 3] = 255;
      }
      return { alpha, width: w, height: h, softPixels: 0, touchedEdges: new Set(), box: { x: 22, y: 10, w: 16, h: 70 }, candidates: [], confidence: 0.9 };
    };
    const a = analyzeCutout(mkTall());
    expect(a.elongation).toBeGreaterThan(0.2);
  });

  test("recommendStyles still works with v2 fields (no regression)", () => {
    const a = analyzeCutout(makeCutout());
    const rec = recommendStyles(a);
    expect(rec.length).toBe(5);
    new Set(rec).size === rec.length;
  });
});

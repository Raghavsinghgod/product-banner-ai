// Tests for the AI matting integration data path (pure parts — no model).
import { describe, expect, test } from "bun:test";

import { matteToCutout, type MattingResult } from "../src/lib/pipeline/aiMatting";

function sourceImage(w: number, h: number): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    // colorful gradient so we can verify RGB passthrough
    data[i * 4] = (i * 7) & 255;
    data[i * 4 + 1] = (i * 13) & 255;
    data[i * 4 + 2] = (i * 29) & 255;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

function matteWith(
  w: number,
  h: number,
  alphaAt: (x: number, y: number) => number,
): MattingResult {
  const alpha = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      alpha[i + 3] = alphaAt(x, y);
    }
  }
  return { alpha, width: w, height: h, confidence: 0.88 };
}

describe("AI matting data path", () => {
  test("centered product matte: alpha copied, RGB from source, bbox tight", () => {
    const w = 40, h = 40;
    const src = sourceImage(w, h);
    // square product 10..30
    const matte = matteWith(w, h, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30 ? 255 : 0));
    const cutout = matteToCutout(src, matte);

    expect(cutout.width).toBe(w);
    expect(cutout.height).toBe(h);
    expect(cutout.box).toEqual({ x: 10, y: 10, w: 20, h: 20 });

    // inside: alpha 255, RGB matches source
    const inIdx = (15 * w + 15) * 4;
    expect(cutout.alpha[inIdx + 3]).toBe(255);
    expect(cutout.alpha[inIdx]).toBe(src.data[inIdx]);
    expect(cutout.alpha[inIdx + 1]).toBe(src.data[inIdx + 1]);
    expect(cutout.alpha[inIdx + 2]).toBe(src.data[inIdx + 2]);

    // outside: alpha 0
    expect(cutout.alpha[(5 * w + 5) * 4 + 3]).toBe(0);

    // confidence from the matte flows through
    expect(cutout.confidence).toBe(0.88);

    // candidate list populated for the UI
    expect(cutout.candidates.length).toBe(1);
    expect(cutout.candidates[0].score).toBe(1);
  });

  test("empty matte (no foreground) falls back to full-frame box, does not crash", () => {
    const w = 20, h = 20;
    const src = sourceImage(w, h);
    const matte = matteWith(w, h, () => 0);
    const cutout = matteToCutout(src, matte);
    expect(cutout.box).toEqual({ x: 0, y: 0, w: 20, h: 20 });
    expect(cutout.alpha.every((v, i) => (i % 4 === 3 ? v === 0 : true))).toBe(true);
  });

  test("full-frame matte reports full-frame box", () => {
    const w = 15, h = 12;
    const src = sourceImage(w, h);
    const matte = matteWith(w, h, () => 200);
    const cutout = matteToCutout(src, matte);
    expect(cutout.box).toEqual({ x: 0, y: 0, w: 15, h: 12 });
  });

  test("soft (partial) alpha values preserved for edge feathering", () => {
    const w = 10, h = 10;
    const src = sourceImage(w, h);
    const matte = matteWith(w, h, (x) => (x < 5 ? 128 : 255));
    const cutout = matteToCutout(src, matte);
    expect(cutout.alpha[(0 * w + 0) * 4 + 3]).toBe(128);
    expect(cutout.alpha[(0 * w + 8) * 4 + 3]).toBe(255);
  });
});

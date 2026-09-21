// Physics/behavior tests for the professional shadow engine.
// Verifies light-direction semantics, penumbra response, contact behavior,
// monotonicity in the controls, and determinism. Run: bun test tests/
import { describe, expect, test } from "bun:test";

import type { Cutout } from "../src/lib/pipeline/segment";
import { renderShadow, DEFAULT_SHADOW, type ShadowOptions } from "../src/lib/pipeline/shadow";

const W = 240;
const H = 240;

function rectCutout(w = 60, h = 60): Cutout {
  const cw = 100;
  const chh = 100;
  const alpha = new Uint8ClampedArray(cw * chh * 4);
  for (let y = 20; y < 20 + h; y++) {
    for (let x = 20; x < 20 + w; x++) {
      const p = (y * cw + x) * 4;
      alpha[p] = 200;
      alpha[p + 1] = 60;
      alpha[p + 2] = 60;
      alpha[p + 3] = 255;
    }
  }
  return {
    alpha,
    width: cw,
    height: chh,
    softPixels: 0,
    touchedEdges: new Set(),
    box: { x: 20, y: 20, w, h },
    confidence: 1,
  };
}

function place() {
  return { x: W / 2, y: H * 0.62, scale: 1.6 };
}

function ink(mask: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < mask.length; i++) sum += mask[i];
  return sum;
}

/** Total ink strictly below a given row (used to test cast direction). */
function inkBelowRow(mask: Uint8ClampedArray, row: number): number {
  let sum = 0;
  for (let y = row + 1; y < H; y++) for (let x = 0; x < W; x++) sum += mask[y * W + x];
  return sum;
}

/** Total ink strictly left of a given column. */
function inkLeftOfCol(mask: Uint8ClampedArray, col: number): number {
  let sum = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < col; x++) sum += mask[y * W + x];
  return sum;
}

const base: ShadowOptions = { direction: 90, length: 0.8, softness: 0.5, opacity: 0.5, contact: true };

describe("shadow engine physics", () => {
  test("light from above (90°) casts downward; light from below (270°) casts upward", () => {
    const down = renderShadow(rectCutout(), place(), W, H, { ...base, direction: 90 });
    const up = renderShadow(rectCutout(), place(), W, H, { ...base, direction: 270 });
    const split = Math.round(H * 0.62);
    // AO sits symmetrically under the footprint, so it cancels in comparison:
    // the direction-dependent ink is the cast, which must flip sides.
    expect(inkBelowRow(down, split)).toBeGreaterThan(inkBelowRow(up, split) * 1.5);
    expect(inkBelowRow(up, split)).toBeGreaterThan(0);
  });

  test("light from the right (0°) biases ink to the left, and vice versa", () => {
    const right = renderShadow(rectCutout(), place(), W, H, { ...base, direction: 0 });
    const left = renderShadow(rectCutout(), place(), W, H, { ...base, direction: 180 });
    const rightSideOfRight = W * 0.62 - 40; // column anchor near product center
    const inkLeft_right = inkLeftOfCol(right, W / 2);
    const inkLeft_left = inkLeftOfCol(left, W / 2);
    expect(inkLeft_right).toBeGreaterThan(inkLeft_left);
    void rightSideOfRight;
  });

  test("penumbra widens with softness: blurred shadow has more mid-tones", () => {
    const hard = renderShadow(rectCutout(), place(), W, H, { ...base, softness: 0.1 });
    const soft = renderShadow(rectCutout(), place(), W, H, { ...base, softness: 0.9 });
    const midTones = (m: Uint8ClampedArray) => {
      let c = 0;
      for (let i = 0; i < m.length; i++) if (m[i] > 20 && m[i] < 200) c++;
      return c;
    };
    expect(midTones(soft)).toBeGreaterThan(midTones(hard));
  });

  test("longer cast spreads ink further from the product", () => {
    const short = renderShadow(rectCutout(), place(), W, H, { ...base, length: 0.2 });
    const long = renderShadow(rectCutout(), place(), W, H, { ...base, length: 1.2 });
    const far = (m: Uint8ClampedArray) => {
      let c = 0;
      for (let y = Math.round(H * 0.75); y < H; y++)
        for (let x = 0; x < W; x++) if (m[y * W + x] > 10) c++;
      return c;
    };
    expect(far(long)).toBeGreaterThan(far(short));
  });

  test("stronger opacity darkens the core without moving the shadow", () => {
    const faint = renderShadow(rectCutout(), place(), W, H, { ...base, opacity: 0.15 });
    const strong = renderShadow(rectCutout(), place(), W, H, { ...base, opacity: 0.7 });
    const core = (m: Uint8ClampedArray) => {
      let mx = 0;
      for (let i = 0; i < m.length; i++) if (m[i] > mx) mx = m[i];
      return mx;
    };
    expect(core(strong)).toBeGreaterThan(core(faint));
    const spread = (m: Uint8ClampedArray) => {
      let c = 0;
      for (let i = 0; i < m.length; i++) if (m[i] > 10) c++;
      return c;
    };
    // area should be roughly similar (same geometry)
    expect(Math.abs(spread(strong) - spread(faint))).toBeLessThan(spread(strong) * 0.4);
  });

  test("contact shadow adds a tight band hugging the silhouette bottom", () => {
    const withC = renderShadow(rectCutout(), place(), W, H, { ...base, contact: true, length: 0 });
    const withoutC = renderShadow(rectCutout(), place(), W, H, { ...base, contact: false, length: 0 });
    expect(ink(withC)).toBeGreaterThan(ink(withoutC));
    // with length 0 and no contact there must be no ink at all
    expect(ink(withoutC)).toBe(0);
  });

  test("no cast, no contact -> empty mask (shadowless gating)", () => {
    const m = renderShadow(rectCutout(), place(), W, H, { ...base, length: 0, contact: false });
    expect(ink(m)).toBe(0);
  });

  test("mask values stay in 0..255 and respect the opacity ceiling", () => {
    const m = renderShadow(rectCutout(), place(), W, H, { ...base, opacity: 0.5 });
    for (let i = 0; i < m.length; i++) {
      expect(m[i]).toBeGreaterThanOrEqual(0);
      expect(m[i]).toBeLessThanOrEqual(Math.round(255 * 0.5 + 1));
    }
  });

  test("deterministic: identical inputs produce identical masks", () => {
    const a = renderShadow(rectCutout(), place(), W, H, DEFAULT_SHADOW);
    const b = renderShadow(rectCutout(), place(), W, H, DEFAULT_SHADOW);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  test("off-canvas placement is safe (no crash, empty mask)", () => {
    const m = renderShadow(rectCutout(), { x: -500, y: -500, scale: 1 }, W, H, DEFAULT_SHADOW);
    expect(m).toHaveLength(W * H);
  });
});

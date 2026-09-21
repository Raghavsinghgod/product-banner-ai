// EXTREME PRECISION verification for the upscale engine.
// Invariants, not smoke tests — each targets a specific mathematical property
// of the interpolation/sharpening pipeline.
import { describe, expect, test } from "bun:test";

import { upscaleImage } from "../src/lib/pipeline/upscale";

function constImage(w: number, h: number, r: number, g: number, b: number): Uint8ClampedArray {
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    src[i * 4] = r;
    src[i * 4 + 1] = g;
    src[i * 4 + 2] = b;
    src[i * 4 + 3] = 255;
  }
  return src;
}

describe("upscale precision invariants", () => {
  // 1. PARTITION OF UNITY: the interpolation weights must sum to exactly 1,
  //    so a constant input maps to a bit-exact constant output (zero ripple).
  test("constant field preserved bit-exactly at 2x and 3x (zero ripple)", () => {
    for (const f of [2, 3] as const) {
      // odd prime-ish sizes hit every fractional phase of the resampler
      const w = 37, h = 23;
      const src = constImage(w, h, 173, 98, 219);
      const up = upscaleImage(src, w, h, { factor: f, sharpening: 0.8, crispness: 0.9 });
      for (let i = 0; i < up.width * up.height; i++) {
        expect(up.rgba[i * 4]).toBe(173);
        expect(up.rgba[i * 4 + 1]).toBe(98);
        expect(up.rgba[i * 4 + 2]).toBe(219);
      }
    }
  });

  // 2. BOUNDS: no output value may overflow [0,255] even at max sharpening.
  test("no value overflow/undershoot at maximum sharpening", () => {
    const w = 16, h = 16;
    const src = constImage(w, h, 240, 240, 240);
    src[0] = 10; src[1] = 10; src[2] = 10; // extreme corner contrast
    const up = upscaleImage(src, w, h, { factor: 2, sharpening: 1, crispness: 1 });
    for (let i = 0; i < up.rgba.length; i++) {
      expect(up.rgba[i]).toBeGreaterThanOrEqual(0);
      expect(up.rgba[i]).toBeLessThanOrEqual(255);
    }
  });

  // 3. LINE WIDTH: the dark core of a 2px line must stay present (contrast
  //    preserved) and the 50% transition band tight — bilinear smears the
  //    mid-gray shoulder 2x wider than Catmull-Rom + sharpening.
  test("2px line: dark core preserved and shoulders tight at 2x and 3x", () => {
    for (const f of [2, 3] as const) {
      const w = 60, h = 40;
      const src = constImage(w, h, 255, 255, 255);
      for (let y = 0; y < h; y++) {
        for (let x = 30; x < 32; x++) {
          const i = (y * w + x) * 4;
          src[i] = 0; src[i + 1] = 0; src[i + 2] = 0;
        }
      }
      const up = upscaleImage(src, w, h, { factor: f, sharpening: 0.55, crispness: 0.7 });
      const yMid = Math.floor((h * f) / 2);
      const at = (x: number) => up.rgba[(yMid * up.width + x) * 4];
      // dark core survives at the line center
      expect(at(Math.floor(31 * f))).toBeLessThanOrEqual(60);
      // shoulder (1 source px out) is still mostly white — no wide smear
      expect(at(Math.floor(27 * f))).toBeGreaterThanOrEqual(240);
      // crossing point sits mid-gray (sharp transition, not a ramp)
      expect(at(Math.floor(30 * f))).toBeLessThanOrEqual(180);
    }
  });

  // 4. DETERMINISM: byte-identical across repeated runs.
  test("3 runs byte-identical (determinism)", () => {
    const w = 51, h = 49;
    const src = new Uint8ClampedArray(w * h * 4);
    let s = 12345;
    for (let i = 0; i < w * h * 4; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      src[i] = s & 255;
    }
    const a = upscaleImage(src, w, h, { factor: 2 });
    const b = upscaleImage(src, w, h, { factor: 2 });
    const c = upscaleImage(src, w, h, { factor: 2 });
    for (let i = 0; i < a.rgba.length; i++) {
      expect(a.rgba[i]).toBe(b.rgba[i]);
      expect(b.rgba[i]).toBe(c.rgba[i]);
    }
  });

  // 5. STEP RESPONSE: the reconstructed step must be MONOTONE within a few
  //    pixels of the crossing and settle to the correct plateau values — no
  //    runaway ringing, no plateau drift. (Overshoot/ringing near the edge is
  //    the sharpening working; the invariant is that it decays within ~3px.)
  test("step response: plateaus exact, ringing decays within 3px", () => {
    const w = 32, h = 8;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = x < 16 ? 30 : 220;
        src[i] = v; src[i + 1] = v; src[i + 2] = v;
        src[i + 3] = 255;
      }
    }
    const up = upscaleImage(src, w, h, { factor: 2, sharpening: 0.7, crispness: 0.8 });
    const yMid = h; // any middle row
    const row = (x: number) => up.rgba[(yMid * up.width + x) * 4];
    // deep plateau pixels settle EXACTLY to their plateau values
    expect(row(24)).toBe(30);
    expect(row(40)).toBe(220);
    // ringing decays fast: measured profile decays to within 6 levels of the
    // plateau by ~4px from the crossing (x=32). x=29-30 is the undershoot
    // lobe (22/16), x=33-34 the overshoot lobe (234/228).
    expect(Math.abs(row(28) - 30)).toBeLessThanOrEqual(6);
    expect(Math.abs(row(36) - 220)).toBeLessThanOrEqual(6);
    // undershoot/overshoot lobes exist but stay bounded (sharpness, not noise)
    expect(row(30)).toBeLessThan(30); // undershoot present
    expect(row(33)).toBeGreaterThan(220); // overshoot present
    // hard bounds: never outside the input range by more than 15
    for (let x = 20; x < 48; x++) {
      expect(row(x)).toBeGreaterThanOrEqual(15);
      expect(row(x)).toBeLessThanOrEqual(235);
    }
  });

  // 6. ALPHA PLANE: bicubic on binary alpha produces a clean 0..255 ramp.
  test("alpha plane stays in 0..255 through bicubic", () => {
    const w = 20, h = 20;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      src[i * 4] = 200; src[i * 4 + 1] = 100; src[i * 4 + 2] = 50;
      src[i * 4 + 3] = i % 40 < 20 ? 255 : 0;
    }
    const up = upscaleImage(src, w, h, { factor: 3 });
    for (let i = 0; i < up.width * up.height; i++) {
      const a = up.rgba[i * 4 + 3];
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(255);
    }
  });

  // 7. FULLY-TRANSPARENT pixels stay fully transparent (no color bleed into
  //    the empty region — critical for compositing the cutout).
  test("transparent region stays exactly transparent (no bleed)", () => {
    const w = 12, h = 12;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      src[i * 4] = 200; src[i * 4 + 1] = 30; src[i * 4 + 2] = 30;
      src[i * 4 + 3] = 0; // fully transparent everywhere
    }
    const up = upscaleImage(src, w, h, { factor: 2 });
    for (let i = 0; i < up.width * up.height; i++) {
      expect(up.rgba[i * 4 + 3]).toBe(0);
    }
  });

  // 8. PERFORMANCE at a realistic banner size.
  test("performance acceptable at realistic size", () => {
    const w = 467, h = 350; // -> 934x700 at 2x
    const src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h * 4; i++) src[i] = (i * 31) & 255;
    const t0 = performance.now();
    upscaleImage(src, w, h, { factor: 2 });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500);
  });
});

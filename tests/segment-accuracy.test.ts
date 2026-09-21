// Accuracy tests for the professional-grade segmentation engine.
// Synthetic scenes come with exact ground-truth masks, so we can measure
// IoU (intersection over union) — the standard segmentation metric.
// Run with: bun test tests/
import { describe, expect, test } from "bun:test";

import { segment, type Cutout } from "../src/lib/pipeline/segment";

type RGB = [number, number, number];

/** Binary foreground mask derived from a cutout's alpha (threshold 128). */
function maskOf(c: Cutout): Uint8Array {
  const m = new Uint8Array(c.width * c.height);
  for (let i = 0; i < m.length; i++) m[i] = c.alpha[i * 4 + 3] >= 128 ? 1 : 0;
  return m;
}

/** IoU between predicted mask and ground truth, with the prediction's
 *  bbox cropped against the truth's bbox to be size-agnostic. */
function iou(c: Cutout, truth: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < truth.length; i++) {
    const p = c.alpha[i * 4 + 3] >= 128 ? 1 : 0;
    if (p && truth[i]) inter++;
    if (p || truth[i]) union++;
  }
  return union === 0 ? 1 : inter / union;
}

class SceneBuilder {
  rgba: Uint8ClampedArray;
  truth: Uint8Array;
  constructor(
    public w: number,
    public h: number,
    bg: RGB,
  ) {
    this.rgba = new Uint8ClampedArray(w * h * 4);
    this.truth = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      this.rgba[i * 4] = bg[0];
      this.rgba[i * 4 + 1] = bg[1];
      this.rgba[i * 4 + 2] = bg[2];
      this.rgba[i * 4 + 3] = 255;
    }
  }
  rect(x0: number, y0: number, x1: number, y1: number, color: RGB, product = true) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * this.w + x;
        this.rgba[i * 4] = color[0];
        this.rgba[i * 4 + 1] = color[1];
        this.rgba[i * 4 + 2] = color[2];
        this.truth[i] = product ? 1 : 0;
      }
    }
    return this;
  }
  /** Fill truth=1 pixels with per-pixel noise around their color. */
  noise(seed: number, amp: number) {
    let s = seed >>> 0;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s / 0xffffffff) * 2 - 1;
    };
    for (let i = 0; i < this.w * this.h; i++) {
      if (!this.truth[i]) continue;
      const d = rnd() * amp;
      this.rgba[i * 4] = Math.max(0, Math.min(255, this.rgba[i * 4] + d));
      this.rgba[i * 4 + 1] = Math.max(0, Math.min(255, this.rgba[i * 4 + 1] + d));
      this.rgba[i * 4 + 2] = Math.max(0, Math.min(255, this.rgba[i * 4 + 2] + d));
    }
    return this;
  }
  run(opts = {}) {
    return segment(this.rgba, this.w, this.h, opts);
  }
}

// ------------------------------------------------------------------ tests

describe("segmentation accuracy (IoU vs ground truth)", () => {
  test("flat background, distinct product — near-perfect cutout", () => {
    const s = new SceneBuilder(120, 120, [230, 228, 222]).rect(
      30,
      25,
      90,
      95,
      [190, 60, 60],
    );
    const c = s.run();
    const score = iou(c, s.truth);
    expect(score).toBeGreaterThan(0.9);
    expect(c.confidence).toBeGreaterThan(0.5);
  });

  test("two-tone background (wall + desk line) — no leak through the seam", () => {
    const s = new SceneBuilder(140, 140, [225, 223, 216])
      .rect(0, 100, 140, 140, [120, 88, 60], false) // desk surface
      .rect(40, 35, 100, 105, [40, 90, 170]); // product straddling the seam
    const c = s.run();
    const score = iou(c, s.truth);
    // the old single-threshold engine leaked on this class of scene
    expect(score).toBeGreaterThan(0.85);
  });

  test("vertical gradient background — modeled, not thresholded", () => {
    const w = 120;
    const h = 120;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const truth = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const t = y / h;
        // 220 -> 150 vertical luminance ramp
        const bg = Math.round(220 - 70 * t);
        const product = x >= 35 && x < 85 && y >= 30 && y < 100;
        const col: RGB = product ? [200, 70, 50] : [bg, bg, bg - 4];
        rgba[i * 4] = col[0];
        rgba[i * 4 + 1] = col[1];
        rgba[i * 4 + 2] = col[2];
        rgba[i * 4 + 3] = 255;
        truth[i] = product ? 1 : 0;
      }
    }
    const c = segment(rgba, w, h);
    expect(iou(c, truth)).toBeGreaterThan(0.85);
  });

  test("noisy background and product — cleanup keeps the object solid", () => {
    const s = new SceneBuilder(120, 120, [215, 212, 205])
      .rect(35, 30, 90, 95, [70, 130, 90])
      .noise(0x1234567, 14);
    const c = s.run();
    const score = iou(c, s.truth);
    expect(score).toBeGreaterThan(0.75);
  });

  test("low-contrast product still separated without swallowing the frame", () => {
    // product only ~18% lighter than the backdrop — hard case
    const s = new SceneBuilder(120, 120, [200, 200, 200]).rect(
      30,
      30,
      90,
      90,
      [236, 236, 238],
    );
    const c = s.run();
    const frac = (c.box.w * c.box.h) / (120 * 120);
    // must NOT have given up and kept the entire frame
    expect(frac).toBeLessThan(0.95);
    const score = iou(c, s.truth);
    expect(score).toBeGreaterThan(0.5);
  });

  test("product with an enclosed hole (handle) — hole is preserved", () => {
    const s = new SceneBuilder(120, 120, [235, 233, 228])
      .rect(30, 30, 90, 90, [60, 60, 200]) // product block
      .rect(52, 50, 68, 66, [235, 233, 228], true); // hole: bg-colored, truth=1
    const c = s.run();
    // center of the hole must remain foreground (alpha >= 128)
    const center = 58 * 120 + 60;
    expect(c.alpha[center * 4 + 3]).toBeGreaterThanOrEqual(128);
    expect(iou(c, s.truth)).toBeGreaterThan(0.85);
  });

  test("small speckle islands are discarded, main object kept", () => {
    const s = new SceneBuilder(120, 120, [230, 228, 222])
      .rect(40, 40, 85, 90, [180, 50, 140])
      .rect(8, 8, 14, 14, [180, 50, 140]) // speckle 1
      .rect(104, 100, 111, 107, [180, 50, 140]); // speckle 2
    const c = s.run();
    // speckles must be gone
    expect(c.alpha[(10 * 120 + 10) * 4 + 3]).toBe(0);
    expect(c.alpha[(103 * 120 + 107) * 4 + 3]).toBe(0);
    // main object must remain
    expect(c.alpha[(60 * 120 + 60) * 4 + 3]).toBeGreaterThanOrEqual(128);
    expect(iou(c, s.truth)).toBeGreaterThan(0.8);
  });

  test("confidence reflects quality: clean scene scores higher than ambiguous", () => {
    const clean = new SceneBuilder(120, 120, [230, 228, 222])
      .rect(30, 25, 90, 95, [190, 60, 60])
      .run();
    const hard = new SceneBuilder(120, 120, [200, 200, 200])
      .rect(30, 30, 90, 90, [236, 236, 238])
      .run();
    expect(clean.confidence).toBeGreaterThan(hard.confidence);
  });

  test("full-frame product (touches all edges) does not crash and reports it", () => {
    const s = new SceneBuilder(100, 100, [210, 208, 200]).rect(
      0,
      0,
      100,
      100,
      [50, 120, 80],
    );
    const c = s.run();
    expect(c.width).toBe(100);
    expect(c.box.w).toBeGreaterThan(0);
  });
});

describe("segmentation invariants", () => {
  test("alpha is 255 well inside the object and 0 well outside", () => {
    const s = new SceneBuilder(100, 100, [225, 223, 216]).rect(
      25,
      25,
      75,
      75,
      [200, 60, 60],
    );
    const c = s.run();
    expect(c.alpha[(50 * 100 + 50) * 4 + 3]).toBe(255);
    expect(c.alpha[(10 * 100 + 10) * 4 + 3]).toBe(0);
    expect(c.alpha[(95 * 100 + 95) * 4 + 3]).toBe(0);
  });

  test("RGB channels carry the source colors (needed by style analysis)", () => {
    const s = new SceneBuilder(100, 100, [225, 223, 216]).rect(
      25,
      25,
      75,
      75,
      [10, 200, 30],
    );
    const c = s.run();
    const p = (50 * 100 + 50) * 4;
    expect(c.alpha[p]).toBe(10);
    expect(c.alpha[p + 1]).toBe(200);
    expect(c.alpha[p + 2]).toBe(30);
  });

  test("bbox tight around the product", () => {
    const s = new SceneBuilder(100, 100, [225, 223, 216]).rect(
      30,
      20,
      70,
      80,
      [90, 60, 200],
    );
    const c = s.run();
    expect(c.box.x).toBeLessThanOrEqual(31);
    expect(c.box.y).toBeLessThanOrEqual(21);
    expect(c.box.x + c.box.w).toBeGreaterThanOrEqual(69);
    expect(c.box.y + c.box.h).toBeGreaterThanOrEqual(79);
    // and not wildly larger
    expect(c.box.w).toBeLessThanOrEqual(44);
    expect(c.box.h).toBeLessThanOrEqual(64);
  });

  test("candidates always present, best candidate matches primary bbox", () => {
    const s = new SceneBuilder(120, 120, [228, 226, 220]).rect(35, 30, 85, 95, [190, 60, 60]);
    const c = s.run();
    expect(c.candidates.length).toBeGreaterThan(0);
    const top = c.candidates[0];
    expect(top.box.x).toBe(c.box.x);
    expect(top.box.y).toBe(c.box.y);
    expect(top.box.w).toBe(c.box.w);
    expect(top.box.h).toBe(c.box.h);
    expect(top.score).toBeGreaterThan(0);
  });

  test("cluttered scene: centrality beats a bigger off-center object", () => {
    // A centered product and a LARGER clutter object pushed toward a corner.
    // Old behavior (largest wins) would pick the clutter; ranking must not.
    const s = new SceneBuilder(160, 160, [228, 226, 220])
      .rect(50, 55, 100, 105, [190, 60, 60]) // product, 50x50, centered
      .rect(105, 4, 155, 50, [60, 130, 90]); // clutter, 50x50, near top-right
    const c = s.run();
    expect(c.candidates.length).toBeGreaterThanOrEqual(2);
    // primary is the centered product, not the bigger corner-hugging blob
    const px = c.box.x + c.box.w / 2;
    const py = c.box.y + c.box.h / 2;
    expect(Math.abs(px - 80)).toBeLessThan(30);
    expect(Math.abs(py - 80)).toBeLessThan(30);
    expect(c.candidates[0].score).toBeGreaterThan(c.candidates[1].score);
    // both objects survive in the alpha, but framing follows the product
    expect(c.alpha[(29 * 160 + 125) * 4 + 3]).toBeGreaterThanOrEqual(128);
    expect(c.alpha[(80 * 160 + 80) * 4 + 3]).toBeGreaterThanOrEqual(128);
  });

  test("deterministic: same input, same output", () => {
    const s1 = new SceneBuilder(80, 80, [220, 218, 210]).rect(20, 20, 60, 60, [200, 80, 40]);
    const a = s1.run();
    const s2 = new SceneBuilder(80, 80, [220, 218, 210]).rect(20, 20, 60, 60, [200, 80, 40]);
    const b = s2.run();
    expect(iou(a, maskOf(b))).toBe(1);
  });
});

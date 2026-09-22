// AI matting — shared types + cutout assembly.
//
// MODEL: BiRefNet_lite (MIT license — ZhengPeng7 et al.; ONNX conversion by
// onnx-community) via Transformers.js on ONNX Runtime Web.
//
// ARCHITECTURE: the model itself loads and runs inside a Web Worker —
// see aiMattingWorker.ts (worker side) and aiMattingClient.ts (main-thread
// client with the watchdog that guarantees the UI can never hang). This file
// holds only the pure, DOM-free pieces: the MattingResult type and the
// matte→Cutout assembly, which is why tests can run it in Bun directly.
//
// FALLBACK: when the AI stage fails (model unavailable, watchdog fired,
// inference error), the caller re-runs the custom segment.ts engine — the
// app always produces a cutout, AI-grade or heuristic.

export type MattingResult = {
  /** Full-size RGBA where RGB is unused and A = model alpha (0..255). */
  alpha: Uint8ClampedArray;
  width: number;
  height: number;
  /** Mean model confidence inside the predicted foreground. */
  confidence: number;
};

import type { Cutout } from "./segment";

/**
 * Combine an AI matte with the source image into a Cutout, computing the
 * tight bounding box of the predicted foreground and the mean confidence.
 * Accepts a plain { data, width, height } so it runs in workers and tests.
 */
export function matteToCutout(
  source: { data: Uint8ClampedArray; width: number; height: number },
  matte: MattingResult,
): Cutout {
  const { width: w, height: h } = source;
  const n = w * h;
  const alpha = new Uint8ClampedArray(n * 4);
  const m = matte.alpha;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const a = m[p + 3];
    alpha[p] = source.data[p];
    alpha[p + 1] = source.data[p + 1];
    alpha[p + 2] = source.data[p + 2];
    alpha[p + 3] = a;
    if (a > 128) {
      const x = i % w;
      const y = (i / w) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) {
    minX = 0; minY = 0; maxX = w - 1; maxY = h - 1;
  }

  return {
    alpha,
    width: w,
    height: h,
    softPixels: 0,
    touchedEdges: new Set<number>(),
    box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    candidates: [
      {
        box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
        area: (maxX - minX + 1) * (maxY - minY + 1),
        score: 1,
      },
    ],
    confidence: matte.confidence,
  };
}

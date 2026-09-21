// Web Worker entry for the segmentation pipeline. Runs the full professional
// engine (color model -> guided flood -> cleanup -> matting) off the main
// thread so the UI never blocks during processing.
import { segment } from "./segment";

type SegRequest = {
  id: number;
  buffer: ArrayBuffer;
  width: number;
  height: number;
  tolerance: number;
  softness: number;
  noRetry?: boolean;
};

const post = (msg: unknown, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? []);

self.addEventListener("message", (e: MessageEvent) => {
  const req = e.data as SegRequest;
  try {
    const rgba = new Uint8ClampedArray(req.buffer);
    const cutout = segment(rgba, req.width, req.height, {
      tolerance: req.tolerance,
      softness: req.softness,
      noRetry: req.noRetry,
    });
    const out = cutout.alpha.buffer as ArrayBuffer;
    post(
      {
        id: req.id,
        ok: true,
        alpha: out,
        width: cutout.width,
        height: cutout.height,
        softPixels: cutout.softPixels,
        touchedEdges: Array.from(cutout.touchedEdges),
        box: cutout.box,
        confidence: cutout.confidence,
      },
      [out],
    );
  } catch (err) {
    post({ id: req.id, ok: false, error: String(err) });
  }
});

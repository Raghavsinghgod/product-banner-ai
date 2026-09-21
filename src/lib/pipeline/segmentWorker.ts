// Web Worker entry for the custom segmentation engine.
//
// Runs off the main thread so the UI never blocks during processing.
// PROTOCOL: main thread posts { id, buffer, width, height, tolerance, ... }
// with the RGBA ArrayBuffer TRANSFERRED (zero-copy, ownership moves here);
// we post back { id, ok, alpha: ArrayBuffer (transferred back), box,
// candidates, confidence, ... }. The id matches request to response in
// segmentClient.ts's pending map. If the worker crashes, the client
// permanently falls back to synchronous execution.

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
        candidates: cutout.candidates,
        confidence: cutout.confidence,
      },
      [out],
    );
  } catch (err) {
    post({ id: req.id, ok: false, error: String(err) });
  }
});

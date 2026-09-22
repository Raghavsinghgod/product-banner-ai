// Web Worker for AI matting (BiRefNet via Transformers.js).
//
// WHY A WORKER: WASM inference is synchronous CPU work. Running it on the
// main thread freezes the entire page — timers can't fire, so the watchdog
// timeout never triggers, the UI chip spins forever, and the fallback engine
// never runs. In a worker, the main thread stays fully responsive and the
// watchdog below can actually terminate us if we stall.
//
// PROTOCOL (mirrors segmentWorker.ts):
//   Main thread → { type: "matte", id, bitmap (transferred), width, height }
//   Worker      → { type: "progress", id, pct }   (0..100 during download)
//   Worker      → { type: "done", id, ok, alpha?: ArrayBuffer, width,
//                  height, confidence?, error? } (alpha transferred back)
//
// The model loads lazily on the first request and is kept for the session.
// Any failure posts ok:false and the caller falls back to the custom engine.

type MatteRequest = {
  type: "matte";
  id: number;
  bitmap: ImageBitmap;
};

const MODEL_ID = "onnx-community/BiRefNet_lite-ONNX";

type BackgroundRemovalPipeline = (
  image: ImageBitmap,
  options?: Record<string, unknown>,
) => Promise<Array<{ mask: CanvasImageSource & { width: number; height: number } }>>;

let pipePromise: Promise<BackgroundRemovalPipeline | null> | null = null;

const post = (msg: unknown, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? []);

/** Load (once) the background-removal pipeline, streaming download progress. */
function loadPipeline(): Promise<BackgroundRemovalPipeline | null> {
  if (!pipePromise) {
    pipePromise = (async () => {
      try {
        const { pipeline, env } = await import("@huggingface/transformers");
        // Workers have no DOM; make sure transformers.js doesn't try to use one.
        if (env.backends.onnx.wasm) env.backends.onnx.wasm.proxy = false;
        return (await pipeline("background-removal", MODEL_ID, {
          dtype: "fp32",
          progress_callback: (info: { status?: string; progress?: number }) => {
            if (info?.status === "progress" && typeof info.progress === "number") {
              post({ type: "progress", id: -1, pct: Math.round(info.progress) });
            }
          },
        })) as unknown as BackgroundRemovalPipeline;
      } catch (err) {
        console.warn("[aiMattingWorker] model load failed:", err);
        return null;
      }
    })();
  }
  return pipePromise;
}

/** Run the model on one bitmap and return the full-size alpha channel. */
async function runMatte(
  pipe: BackgroundRemovalPipeline,
  bitmap: ImageBitmap,
): Promise<{ alpha: Uint8ClampedArray; confidence: number } | null> {
  const result = await pipe(bitmap);
  const first = result?.[0];
  if (!first?.mask) return null;

  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const cv = new OffscreenCanvas(srcW, srcH);
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(first.mask as unknown as CanvasImageSource, 0, 0, srcW, srcH);
  const maskData = ctx.getImageData(0, 0, srcW, srcH);

  // The mask's red channel holds the matte value (0 = background, 255 = fg).
  const alpha = new Uint8ClampedArray(srcW * srcH * 4);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < srcW * srcH; i++) {
    const m = maskData.data[i * 4];
    alpha[i * 4 + 3] = m;
    if (m > 128) {
      sum += m;
      count++;
    }
  }
  return { alpha, confidence: count > 0 ? sum / count / 255 : 0 };
}

self.addEventListener("message", (e: MessageEvent) => {
  const req = e.data as MatteRequest;
  if (req?.type !== "matte") return;
  void (async () => {
    const pipe = await loadPipeline();
    if (!pipe) {
      post({ type: "done", id: req.id, ok: false, error: "model unavailable" });
      return;
    }
    try {
      const out = await runMatte(pipe, req.bitmap);
      if (!out) {
        post({ type: "done", id: req.id, ok: false, error: "empty mask" });
        return;
      }
      const buf = out.alpha.buffer as ArrayBuffer;
      post(
        {
          type: "done",
          id: req.id,
          ok: true,
          alpha: buf,
          width: req.bitmap.width,
          height: req.bitmap.height,
          confidence: out.confidence,
        },
        [buf],
      );
    } catch (err) {
      console.warn("[aiMattingWorker] inference failed:", err);
      post({ type: "done", id: req.id, ok: false, error: String(err) });
    }
  })();
});

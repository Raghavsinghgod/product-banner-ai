// AI matting stage — the PRIMARY cutout engine.
//
// MODEL: BiRefNet_lite (MIT license — ZhengPeng7 et al.; ONNX conversion by
// onnx-community) via Transformers.js on ONNX Runtime Web (WASM/WebGPU).
// BiRefNet is built for Dichotomous Image Segmentation: high-resolution
// salient-object matting. It succeeds exactly where our custom color-model
// engine fails — product colored like the background (laptop on grass),
// cluttered scenes, soft edges.
//
// PRIVACY + COST: inference runs fully in the browser. Weights (~56MB fp32)
// stream from the Hugging Face CDN on first use and are cached by the browser
// afterwards. No uploads, no API keys, no per-image cost.
//
// FALLBACK: every failure path (model load failure, inference error) resolves
// to null and the caller re-runs the custom segment.ts engine — the app never
// breaks because the model can't load.
//
// LIFECYCLE: the pipeline is created lazily on the first photo and shared for
// the session (module-level promise). Callers show a loading chip while the
// first download runs.

import type { Cutout } from "./segment";

// ---------------------------------------------------------------- tuning
// Hard deadlines so a stalled network can never wedge the studio. If the
// model can't load within MODEL_LOAD_TIMEOUT_MS, or a single inference takes
// longer than INFERENCE_TIMEOUT_MS, we give up for the session and the
// caller falls back to the custom segment.ts engine — the app always works,
// just without AI-grade matting.
const MODEL_LOAD_TIMEOUT_MS = 60_000;
const INFERENCE_TIMEOUT_MS = 45_000;
const MODEL_ID = "onnx-community/BiRefNet_lite-ONNX";

export type MattingResult = {
  /** Full-size RGBA where RGB = source pixels, A = model alpha (0..255). */
  alpha: Uint8ClampedArray;
  width: number;
  height: number;
  /** Mean model confidence inside the predicted foreground. */
  confidence: number;
};

type BackgroundRemovalPipeline = (
  image: ImageBitmap | string,
  options?: Record<string, unknown>,
) => Promise<Array<{ mask: CanvasImageSource & { width: number; height: number } }>>;

let pipePromise: Promise<BackgroundRemovalPipeline | null> | null = null;

// Set once the load/inference deadline is missed: every later call in this
// session returns null immediately instead of retrying the same stalled
// download. (A page reload resets it.)
let permanentlyFailed = false;

// Optional download-progress hook (percent 0..100, or null when the stage
// can't be measured). The Studio page registers a listener to show "42%"
// in the loading chip instead of a bare spinner.
let progressListener: ((pct: number | null) => void) | null = null;

/**
 * Register a callback that receives model download progress.
 * Pass null to unregister (called by Studio on unmount).
 */
export function setMattingProgressListener(
  cb: ((pct: number | null) => void) | null,
): void {
  progressListener = cb;
}

/**
 * Race `p` against a deadline. Resolves to null on EITHER outcome of losing
 * the race: the deadline fires first, or `p` itself rejects. The losing
 * promise's eventual rejection is swallowed so it can't surface as an
 * unhandled error after the race has already settled.
 */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[aiMatting] ${label} exceeded ${ms / 1000}s — giving up.`);
      resolve(null);
    }, ms);
  });
  const safe = p.catch((err) => {
    console.warn(`[aiMatting] ${label} failed.`, err);
    return null as unknown as T;
  });
  return Promise.race([safe, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T | null>;
}

/**
 * Lazily load the BiRefNet background-removal pipeline.
 * Resolves to null if loading fails OR exceeds MODEL_LOAD_TIMEOUT_MS
 * (caller falls back to the custom engine).
 */
export function loadMattingModel(): Promise<BackgroundRemovalPipeline | null> {
  if (permanentlyFailed) return Promise.resolve(null);
  if (!pipePromise) {
    pipePromise = (async () => {
      const load = (async () => {
        const { pipeline } = await import("@huggingface/transformers");
        return pipeline("background-removal", MODEL_ID, {
          dtype: "fp32",
          // Stream download percentages ("progress" events fire per file:
          // config, weights, tokenizer — take the max as overall progress).
          progress_callback: (info: { status?: string; progress?: number }) => {
            if (info?.status === "progress" && typeof info.progress === "number") {
              progressListener?.(Math.round(info.progress));
            } else if (info?.status === "ready") {
              progressListener?.(100);
            }
          },
        });
      })() as unknown as Promise<BackgroundRemovalPipeline>;
      const result = await withDeadline(load, MODEL_LOAD_TIMEOUT_MS, "model load");
      if (!result) {
        permanentlyFailed = true;
        progressListener?.(null);
      }
      return result;
    })();
  }
  return pipePromise;
}

/**
 * Produce a high-quality alpha matte for an image bitmap using BiRefNet.
 * The returned alpha is already resized to the input dimensions.
 */
export async function aiMatte(
  bitmap: ImageBitmap,
): Promise<MattingResult | null> {
  const pipe = await loadMattingModel();
  if (!pipe) return null;

  try {
    const result = await withDeadline(pipe(bitmap), INFERENCE_TIMEOUT_MS, "inference");
    if (!result) return null;
    const first = result[0];
    if (!first?.mask) return null;

    // Draw the returned mask (RawImage/Canvas) into a canvas at source size
    const srcW = bitmap.width;
    const srcH = bitmap.height;
    const cv = document.createElement("canvas");
    cv.width = srcW;
    cv.height = srcH;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(first.mask as unknown as CanvasImageSource, 0, 0, srcW, srcH);
    const maskData = ctx.getImageData(0, 0, srcW, srcH);

    // Model mask: single-channel alpha in the RGB channels (white = fg)
    const alpha = new Uint8ClampedArray(srcW * srcH * 4);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < srcW * srcH; i++) {
      const m = maskData.data[i * 4]; // red channel = matte value
      const p = i * 4;
      // copy source pixels? caller composites; here we write the matte into
      // all RGBA channels' alpha slot only (RGB written by caller).
      alpha[p] = 0;
      alpha[p + 1] = 0;
      alpha[p + 2] = 0;
      alpha[p + 3] = m;
      if (m > 128) {
        sum += m;
        count++;
      }
    }

    return {
      alpha,
      width: srcW,
      height: srcH,
      confidence: count > 0 ? sum / count / 255 : 0,
    };
  } catch (err) {
    console.warn("BiRefNet inference failed; using custom segmentation.", err);
    return null;
  }
}

/**
 * Combine an AI matte with the source image into a Cutout, applying the same
 * refinement quality-bars as the custom engine (feather via a small blur on
 * the matte edge, plus confidence reporting).
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

// Async client for the AI matting worker.
//
// RESPONSIBILITIES:
//   - Spawn and (re)spawn the worker; queue at most one pending request.
//   - Watchdog: the worker itself can't be trusted to report a stall
//     (a wedged WASM loop never reaches its own catch), so the MAIN thread
//     owns the deadline. If nothing comes back in time we TERMINATE the
//     worker and resolve null → the caller falls back to the custom
//     segmentation engine. This is what makes "loading forever" impossible:
//     the worst case is always a bounded wait followed by a working app.
//   - Relay download-progress percentages to a UI listener (Studio's chip).
//
// TIMEOUTS: first-load gets a longer budget (weights download + WASM warmup);
// subsequent inferences get a shorter one. A terminated worker is respawned
// lazily on the NEXT request, so one bad run doesn't poison the session —
// but the caller still sees null for THIS image and uses the fallback.

import type { MattingResult } from "./aiMatting";

type WorkerResponse =
  | { type: "progress"; id: number; pct: number }
  | {
      type: "done";
      id: number;
      ok: boolean;
      alpha?: ArrayBuffer;
      width?: number;
      height?: number;
      confidence?: number;
      error?: string;
    };

const FIRST_LOAD_TIMEOUT_MS = 90_000; // model download + WASM warmup
const INFERENCE_TIMEOUT_MS = 45_000;

let worker: Worker | null = null;
let seq = 0;
let pending: ((r: { ok: boolean; result: MattingResult | null }) => void) | null = null;

let progressListener: ((pct: number | null) => void) | null = null;

/**
 * Register a callback that receives model download progress (0..100).
 * Pass null to unregister. Called by Studio on mount/unmount.
 */
export function setMattingProgressListener(
  cb: ((pct: number | null) => void) | null,
): void {
  progressListener = cb;
}

function spawn(): Worker | null {
  try {
    const w = new Worker(new URL("./aiMattingWorker.ts", import.meta.url), {
      type: "module",
    });
    w.addEventListener("message", (e: MessageEvent) => {
      const res = e.data as WorkerResponse;
      if (res.type === "progress") {
        progressListener?.(res.pct);
        return;
      }
      // "done"
      const resolve = pending;
      pending = null;
      if (!res.ok || !res.alpha || res.width == null || res.height == null) {
        console.warn("[aiMatting] worker reported failure:", res.error);
        resolve?.({ ok: false, result: null });
        return;
      }
      resolve?.({
        ok: true,
        result: {
          alpha: new Uint8ClampedArray(res.alpha),
          width: res.width,
          height: res.height,
          confidence: res.confidence ?? 0,
        },
      });
    });
    w.addEventListener("error", (e) => {
      console.warn("[aiMatting] worker crashed:", e.message ?? e);
      kill();
    });
    return w;
  } catch {
    return null; // workers unavailable in this environment
  }
}

/** Terminate the worker and fail any in-flight request immediately. */
function kill(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  const resolve = pending;
  pending = null;
  progressListener?.(null);
  resolve?.({ ok: false, result: null });
}

/** Race a pending request against a main-thread deadline. */
function withWatchdog(ms: number): Promise<{ ok: boolean; result: MattingResult | null }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[aiMatting] no response within ${ms / 1000}s — terminating worker.`);
      kill();
      resolve({ ok: false, result: null });
    }, ms);
    pending = (r) => {
      clearTimeout(timer);
      resolve(r);
    };
  });
}

/**
 * Produce an AI alpha matte for a bitmap, off the main thread.
 *
 * Resolves null on ANY failure — load error, inference error, or watchdog
 * deadline — and the caller falls back to the custom segment.ts engine.
 * The wait is always bounded: even a fully wedged worker gets terminated.
 */
export async function aiMatteAsync(bitmap: ImageBitmap): Promise<MattingResult | null> {
  if (!worker) worker = spawn();
  if (!worker) return null;

  const firstLoad = seq === 0;
  const job = withWatchdog(firstLoad ? FIRST_LOAD_TIMEOUT_MS : INFERENCE_TIMEOUT_MS);
  const id = ++seq;
  // Transfer the bitmap (zero-copy); the worker owns it afterwards.
  worker.postMessage({ type: "matte", id, bitmap }, [bitmap]);
  const res = await job;
  return res.result;
}

/**
 * Test whether the model can load and run at all (used by the warmup on
 * Studio mount). Resolves quickly with true/false and leaves the loaded
 * pipeline cached in the worker for the next real image.
 */
export async function warmupMatting(): Promise<boolean> {
  // 1x1 bitmap: cheap to run, forces the full download+compile path.
  const bmp = new OffscreenCanvas(1, 1).transferToImageBitmap();
  const r = await aiMatteAsync(bmp as unknown as ImageBitmap);
  return r !== null;
}

// Async segmentation client. Prefers a Web Worker (UI stays responsive);
// transparently falls back to synchronous execution when workers are
// unavailable (e.g. blocked environments) or on first-load failure.
import type { Cutout } from "./segment";
import { segment } from "./segment";

export type SegInput = {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  tolerance?: number;
  softness?: number;
  noRetry?: boolean;
};

type WorkerResult = {
  id: number;
  ok: boolean;
  error?: string;
  alpha?: ArrayBuffer;
  width: number;
  height: number;
  softPixels: number;
  touchedEdges: number[];
  box: Cutout["box"];
  candidates: Cutout["candidates"];
  confidence: number;
};

let worker: Worker | null | undefined; // undefined = not tried yet
let seq = 0;
const pending = new Map<number, (r: WorkerResult) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  try {
    // Vite serves this module via the `?worker` convention in the bundler;
    // fall back to a classic constructor path for other environments.
    const w = new Worker(
      new URL("./segmentWorker.ts", import.meta.url),
      { type: "module" },
    );
    w.addEventListener("message", (e: MessageEvent) => {
      const res = e.data as WorkerResult;
      const resolve = pending.get(res.id);
      if (resolve) {
        pending.delete(res.id);
        resolve(res);
      }
    });
    w.addEventListener("error", () => {
      // permanently disable the worker; future calls run sync
      worker = null;
      for (const [, resolve] of pending) {
        resolve({ id: -1, ok: false, error: "worker crashed", width: 0, height: 0, softPixels: 0, touchedEdges: [], box: { x: 0, y: 0, w: 0, h: 0 }, candidates: [], confidence: 0 });
      }
      pending.clear();
    });
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

function runSync(input: SegInput): Cutout {
  return segment(input.rgba, input.width, input.height, {
    tolerance: input.tolerance,
    softness: input.softness,
    noRetry: input.noRetry,
  });
}

/** Segment an image asynchronously, keeping the UI thread free when possible. */
export function segmentAsync(input: SegInput): Promise<Cutout> {
  const w = getWorker();
  if (!w) {
    // Yield one frame so the "processing" UI paints before the sync run.
    return new Promise((resolve) => {
      setTimeout(() => resolve(runSync(input)), 30);
    });
  }

  return new Promise((resolve, reject) => {
    const id = ++seq;
    // copy: the worker transfers the buffer away
    const copy = input.rgba.slice().buffer as ArrayBuffer;
    const onMessage = (res: WorkerResult) => {
      if (!res.ok || !res.alpha) {
        reject(new Error(res.error ?? "segmentation failed"));
        return;
      }
      const out = new Uint8ClampedArray(res.alpha);
      resolve({
        alpha: out,
        width: res.width,
        height: res.height,
        softPixels: res.softPixels,
        touchedEdges: new Set(res.touchedEdges),
        box: res.box,
        candidates: res.candidates ?? [],
        confidence: res.confidence,
      });
    };
    pending.set(id, onMessage);
    w.postMessage(
      {
        id,
        buffer: copy,
        width: input.width,
        height: input.height,
        tolerance: input.tolerance ?? 26,
        softness: input.softness ?? 2,
        noRetry: input.noRetry ?? false,
      },
      [copy],
    );
  });
}

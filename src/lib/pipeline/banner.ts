// Banner composer: studio backdrops, social ratios, product compositing, export.

import type { Cutout } from "./segment";
import { renderShadow, paintShadow, type ShadowOptions } from "./shadow";

export type BackdropId =
  | "studio"
  | "warm"
  | "mint"
  | "blush"
  | "sky"
  | "paper"
  | "walnut"
  | "charcoal";
export type RatioId = "4:5" | "1:1" | "16:9";

export const BACKDROPS: Array<{
  id: BackdropId;
  label: string;
  from: string;
  to: string;
  swatch: string;
  dark?: boolean;
}> = [
  { id: "studio", label: "Studio", from: "#f7f6f3", to: "#e9e6df", swatch: "#f0eee8" },
  { id: "warm", label: "Warm", from: "#f6efe4", to: "#e7d7c2", swatch: "#efe3d2" },
  { id: "mint", label: "Mint", from: "#e8f2ee", to: "#d2e5dc", swatch: "#dcebe4" },
  { id: "blush", label: "Blush", from: "#f7edeb", to: "#ecd9d6", swatch: "#f1e3e0" },
  { id: "sky", label: "Sky", from: "#eaf0f6", to: "#d4e1ee", swatch: "#dfe9f2" },
  { id: "paper", label: "Paper", from: "#fbfaf7", to: "#f2f0ea", swatch: "#f6f5f0" },
  { id: "walnut", label: "Walnut", from: "#6b4a34", to: "#452e20", swatch: "#5a3e2b", dark: true },
  { id: "charcoal", label: "Charcoal", from: "#33373b", to: "#1e2124", swatch: "#282c30", dark: true },
];

export const RATIOS: Array<{ id: RatioId; label: string; w: number; h: number; hint: string }> = [
  { id: "4:5", label: "4:5", w: 1080, h: 1350, hint: "Vinted / Depop / IG feed" },
  { id: "1:1", label: "1:1", w: 1080, h: 1080, hint: "Square listing" },
  { id: "16:9", label: "16:9", w: 1280, h: 720, hint: "Shop banner" },
];

export type Placement = { x: number; y: number; scale: number };

export type BannerOptions = {
  backdrop: BackdropId;
  ratio: RatioId;
  shadow: ShadowOptions;
};

export function getRatio(id: RatioId) {
  return RATIOS.find((r) => r.id === id) ?? RATIOS[0];
}

export function getBackdrop(id: BackdropId) {
  return BACKDROPS.find((b) => b.id === id) ?? BACKDROPS[0];
}

/** Scale product to ~62% of canvas height (width-capped), baseline at ~72% height. */
export function autoPlacement(cutout: Cutout, W: number, H: number): Placement {
  const { box } = cutout;
  const scale = Math.min((H * 0.62) / box.h, (W * 0.72) / box.w);
  return { x: W / 2, y: H * 0.72, scale };
}

// Cache the full-size cutout canvas so re-renders (slider drags) stay cheap.
const cutoutCanvasCache = new WeakMap<Cutout, HTMLCanvasElement>();

export function cutoutToCanvas(cutout: Cutout): HTMLCanvasElement {
  let c = cutoutCanvasCache.get(cutout);
  if (!c) {
    c = document.createElement("canvas");
    c.width = cutout.width;
    c.height = cutout.height;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(cutout.width, cutout.height);
    const n = cutout.width * cutout.height;
    for (let i = 0; i < n; i++) {
      img.data[i * 4] = cutout.alpha[i * 4];
      img.data[i * 4 + 1] = cutout.alpha[i * 4 + 1];
      img.data[i * 4 + 2] = cutout.alpha[i * 4 + 2];
      img.data[i * 4 + 3] = cutout.alpha[i * 4 + 3];
    }
    ctx.putImageData(img, 0, 0);
    cutoutCanvasCache.set(cutout, c);
  }
  return c;
}

export function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  backdrop: BackdropId,
) {
  const bd = getBackdrop(backdrop);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, bd.from);
  g.addColorStop(1, bd.to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // soft top light
  const r = ctx.createRadialGradient(W * 0.5, H * 0.16, 0, W * 0.5, H * 0.16, W * 0.95);
  if (bd.dark) {
    r.addColorStop(0, "rgba(255,255,255,0.07)");
    r.addColorStop(1, "rgba(255,255,255,0)");
  } else {
    r.addColorStop(0, "rgba(255,255,255,0.5)");
    r.addColorStop(1, "rgba(255,255,255,0)");
  }
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, W, H);

  // grounding band under the product
  const f = ctx.createLinearGradient(0, H * 0.55, 0, H);
  if (bd.dark) {
    f.addColorStop(0, "rgba(0,0,0,0)");
    f.addColorStop(1, "rgba(0,0,0,0.22)");
  } else {
    f.addColorStop(0, "rgba(60,55,45,0)");
    f.addColorStop(1, "rgba(60,55,45,0.07)");
  }
  ctx.fillStyle = f;
  ctx.fillRect(0, H * 0.55, W, H * 0.45);
}

export function drawProduct(
  ctx: CanvasRenderingContext2D,
  cutout: Cutout,
  place: Placement,
) {
  const { box } = cutout;
  const drawW = Math.max(1, Math.round(box.w * place.scale));
  const drawH = Math.max(1, Math.round(box.h * place.scale));
  const off = cutoutToCanvas(cutout);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    off,
    box.x,
    box.y,
    box.w,
    box.h,
    place.x - drawW / 2,
    place.y - drawH / 2,
    drawW,
    drawH,
  );
}

/** Full render: backdrop -> cast + contact shadow -> product. */
export function drawBanner(
  ctx: CanvasRenderingContext2D,
  cutout: Cutout,
  place: Placement,
  opts: BannerOptions,
) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  drawBackdrop(ctx, W, H, opts.backdrop);
  const mask = renderShadow(cutout, place, W, H, opts.shadow);
  paintShadow(ctx, mask, W, H);
  drawProduct(ctx, cutout, place);
}

/** Download the canvas as a PNG. */
export function exportBanner(canvas: HTMLCanvasElement, filename = "relight-banner") {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, "image/png");
}

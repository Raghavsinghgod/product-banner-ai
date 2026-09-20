// Procedural demo scene: a "messy phone photo" of a mug on a cluttered desk.
// Drawn with raw canvas 2D — no image assets, fully deterministic.

let cachedBefore: string | null = null;

export function getDemoBefore(): string {
  if (cachedBefore) return cachedBefore;
  const c = document.createElement("canvas");
  c.width = 720;
  c.height = 540;
  const ctx = c.getContext("2d")!;

  // ---- desk wood background with planks ----
  const wood = ctx.createLinearGradient(0, 0, 0, 540);
  wood.addColorStop(0, "#b08a64");
  wood.addColorStop(1, "#93714f");
  ctx.fillStyle = wood;
  ctx.fillRect(0, 0, 720, 540);

  // planks + grain streaks
  const rng = mulberry32(1234);
  ctx.globalAlpha = 0.18;
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i % 2 ? "#8a6a4a" : "#a07c58";
    ctx.fillRect(0, i * 108 + 54, 720, 108);
  }
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = "#5f452e";
  for (let i = 0; i < 60; i++) {
    const y = rng() * 540;
    const x = rng() * 720;
    const len = 40 + rng() * 120;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x + len * 0.3, y + 2, x + len * 0.7, y - 2, x + len, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // ---- clutter behind the mug ----
  drawPen(ctx, 96, 70, -0.5, "#3b82f6");
  drawPen(ctx, 128, 96, 0.35, "#ef4444");
  drawNotebook(ctx, 470, 330, -0.12);
  drawPlant(ctx, 610, 96);
  drawPhone(ctx, 90, 330);
  drawCoaster(ctx, 250, 120);

  // ---- the mug (product) ----
  drawMug(ctx, 360, 300, 1.25);

  // ---- soft window light from top-left ----
  const light = ctx.createLinearGradient(0, 0, 260, 420);
  light.addColorStop(0, "rgba(255,244,214,0.30)");
  light.addColorStop(1, "rgba(255,244,214,0)");
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, 720, 540);

  // ---- phone photo artifacts: vignette, noise, slight desat lens cast ----
  const vig = ctx.createRadialGradient(360, 270, 220, 360, 270, 560);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(20,10,0,0.32)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, 720, 540);

  const img = ctx.getImageData(0, 0, 720, 540);
  const d = img.data;
  const n2 = mulberry32(77);
  for (let i = 0; i < d.length; i += 4) {
    const g = (n2() - 0.5) * 12;
    d[i] = Math.max(0, Math.min(255, d[i] + g));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + g));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + g));
  }
  ctx.putImageData(img, 0, 0);

  cachedBefore = c.toDataURL("image/jpeg", 0.82);
  return cachedBefore;
}

/** Recompose the demo: run cutout + banner pipeline over the messy scene. */
export async function renderDemoAfter(
  place: { x: number; y: number; scale: number },
  opts: { backdrop: string; shadow: import("./shadow").ShadowOptions },
): Promise<string> {
  const before = getDemoBefore();
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("demo image failed"));
    img.src = before;
  });

  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, cv.width, cv.height);

  const { segment } = await import("./segment");
  const cutout = segment(data.data, cv.width, cv.height, { tolerance: 30 });

  const out = document.createElement("canvas");
  out.width = 1080;
  out.height = 1350;
  const octx = out.getContext("2d")!;
  const { drawBanner } = await import("./banner");
  drawBanner(octx, cutout, place, {
    backdrop: opts.backdrop as never,
    ratio: "4:5",
    shadow: opts.shadow,
  });
  return out.toDataURL("image/png");
}

export const DEMO_PLACE = { x: 540, y: 972, scale: 0.62 };

// ---- clutter drawing helpers -------------------------------------------------

function drawMug(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);

  // shadow under mug (part of the messy photo)
  ctx.fillStyle = "rgba(40,20,5,0.30)";
  ctx.beginPath();
  ctx.ellipse(14, 92, 86, 20, 0.06, 0, Math.PI * 2);
  ctx.fill();

  // handle
  ctx.strokeStyle = "#d8d4cf";
  ctx.lineWidth = 17;
  ctx.beginPath();
  ctx.arc(74, 8, 34, -1.15, 1.15);
  ctx.stroke();
  ctx.strokeStyle = "#b9b4ad";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(74, 8, 34, -1.05, 1.05);
  ctx.stroke();

  // body
  const body = ctx.createLinearGradient(-60, -80, 66, 92);
  body.addColorStop(0, "#efece7");
  body.addColorStop(0.55, "#ddd8d1");
  body.addColorStop(1, "#c2bcb2");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-62, -78);
  ctx.lineTo(62, -78);
  ctx.quadraticCurveTo(70, 40, 52, 88);
  ctx.lineTo(-52, 88);
  ctx.quadraticCurveTo(-70, 40, -62, -78);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(90,80,70,0.35)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // rim + inner
  ctx.fillStyle = "#e7e3dd";
  ctx.beginPath();
  ctx.ellipse(0, -78, 63, 15, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#4a4038";
  ctx.beginPath();
  ctx.ellipse(0, -78, 52, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  const coffee = ctx.createLinearGradient(0, -86, 0, -70);
  coffee.addColorStop(0, "#6b4a2e");
  coffee.addColorStop(1, "#4e3320");
  ctx.fillStyle = coffee;
  ctx.beginPath();
  ctx.ellipse(0, -79, 50, 8.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // logo dot
  ctx.fillStyle = "#e0714f";
  ctx.beginPath();
  ctx.arc(-8, 10, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f3b562";
  ctx.beginPath();
  ctx.arc(-3, 14, 6, 0, Math.PI * 2);
  ctx.fill();

  // glaze highlight
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-44, -58);
  ctx.quadraticCurveTo(-52, 0, -40, 62);
  ctx.stroke();

  ctx.restore();
}

function drawPen(ctx: CanvasRenderingContext2D, x: number, y: number, rot: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = "rgba(40,20,5,0.22)";
  ctx.fillRect(-4, 4, 96, 9);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, -5, 92, 10, 5);
  ctx.fill();
  ctx.fillStyle = "#e8e4dc";
  ctx.beginPath();
  ctx.roundRect(84, -4, 14, 8, 4);
  ctx.fill();
  ctx.fillStyle = "#2b2b2b";
  ctx.beginPath();
  ctx.moveTo(98, -2.5);
  ctx.lineTo(108, 0);
  ctx.lineTo(98, 2.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawNotebook(ctx: CanvasRenderingContext2D, x: number, y: number, rot: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = "rgba(40,20,5,0.18)";
  ctx.fillRect(-90, -64, 190, 136);
  ctx.fillStyle = "#3f5d8a";
  ctx.beginPath();
  ctx.roundRect(-95, -70, 180, 130, 8);
  ctx.fill();
  ctx.fillStyle = "#dcd6ca";
  ctx.beginPath();
  ctx.roundRect(-88, -62, 166, 116, 5);
  ctx.fill();
  ctx.strokeStyle = "rgba(90,80,60,0.5)";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(-74, -40 + i * 18);
    ctx.lineTo(62, -40 + i * 18);
    ctx.stroke();
  }
  ctx.strokeStyle = "#8a5a3b";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-88, -62);
  ctx.bezierCurveTo(-30, -20, 30, 40, 78, 54);
  ctx.stroke();
  ctx.restore();
}

function drawPlant(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(40,20,5,0.2)";
  ctx.beginPath();
  ctx.ellipse(6, 66, 52, 13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#b3703f";
  ctx.beginPath();
  ctx.moveTo(-38, 66);
  ctx.lineTo(38, 66);
  ctx.lineTo(28, 6);
  ctx.lineTo(-28, 6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#8f5730";
  ctx.fillRect(-40, 60, 80, 8);
  const leaf = (a: number, len: number, curve: number) => {
    ctx.save();
    ctx.rotate(a);
    const g = ctx.createLinearGradient(0, 0, 0, -len);
    g.addColorStop(0, "#2f7a52");
    g.addColorStop(1, "#49a46f");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(curve, -len * 0.55, 0, -len);
    ctx.quadraticCurveTo(-curve, -len * 0.55, 0, 0);
    ctx.fill();
    ctx.restore();
  };
  for (let i = 0; i < 7; i++) leaf(-0.9 + i * 0.3, 70 + (i % 3) * 18, 22);
  ctx.restore();
}

function drawPhone(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(0.3);
  ctx.fillStyle = "rgba(40,20,5,0.22)";
  ctx.beginPath();
  ctx.roundRect(-36, -62, 78, 132, 14);
  ctx.fill();
  ctx.fillStyle = "#26282c";
  ctx.beginPath();
  ctx.roundRect(-40, -66, 78, 132, 14);
  ctx.fill();
  const scr = ctx.createLinearGradient(0, -60, 40, 60);
  scr.addColorStop(0, "#3d5a80");
  scr.addColorStop(1, "#20344f");
  ctx.fillStyle = scr;
  ctx.beginPath();
  ctx.roundRect(-34, -60, 66, 120, 8);
  ctx.fill();
  ctx.fillStyle = "#12141a";
  ctx.beginPath();
  ctx.roundRect(-14, -56, 26, 7, 3.5);
  ctx.fill();
  ctx.restore();
}

function drawCoaster(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(40,20,5,0.2)";
  ctx.beginPath();
  ctx.ellipse(4, 8, 48, 14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#7c93a8";
  ctx.beginPath();
  ctx.ellipse(0, 0, 46, 15, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#93aabc";
  ctx.beginPath();
  ctx.ellipse(0, -4, 46, 15, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

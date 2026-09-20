// Custom product cutout engine — 100% our own code, no external AI APIs.
// Stage 1: luminance + Sobel gradient edge map
// Stage 2: adaptive multi-seed flood fill from image borders (clears the backdrop)
// Stage 3: morphological open/close + interior hole filling
// Stage 4: soft alpha feathering on the contour (edge-confidence guided)

export type Cutout = {
  alpha: Uint8ClampedArray; // RGBA, RGB = 0, A = alpha (0..255)
  width: number;
  height: number;
  softPixels: number;
  touchedEdges: Set<number>;
  box: { x: number; y: number; w: number; h: number };
};

export type SegmentOptions = {
  tolerance?: number;
  softness?: number;
};

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function segment(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opts: SegmentOptions = {},
): Cutout {
  const n = width * height;
  const tolerance = opts.tolerance ?? 26;
  const softness = opts.softness ?? 2;

  // ---- Stage 1: luminance + Sobel gradient edge map ----------------------
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    lum[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  const edge = new Float32Array(n);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const tl = lum[i - width - 1];
      const t = lum[i - width];
      const tr = lum[i - width + 1];
      const l = lum[i - 1];
      const r = lum[i + 1];
      const bl = lum[i + width - 1];
      const b = lum[i + width];
      const br = lum[i + width + 1];
      const gx = tl + 2 * l + bl - (tr + 2 * r + br);
      const gy = tl + 2 * t + tr - (bl + 2 * b + br);
      edge[i] = Math.min(255, Math.hypot(gx, gy));
    }
  }

  // ---- Stage 2: adaptive multi-seed flood fill from borders --------------
  const bg = new Uint8Array(n); // 1 = background
  const touchedEdges = new Set<number>();
  const seedList: number[] = [];
  const push = (x: number, y: number) => seedList.push(y * width + x);
  const step = Math.max(2, Math.round(Math.min(width, height) / 24));
  for (let x = 0; x < width; x += step) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += step) {
    push(0, y);
    push(width - 1, y);
  }
  push(0, 0);
  push(width - 1, 0);
  push(0, height - 1);
  push(width - 1, height - 1);

  const EDGE_STRONG = 60; // gradients above this stop the fill outright
  const flood = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  for (const seed of seedList) {
    if (!flood[seed]) {
      flood[seed] = 1;
      stack[sp++] = seed;
    }
  }

  while (sp > 0) {
    const i = stack[--sp];
    bg[i] = 1;
    const x = i % width;
    const y = (i / width) | 0;
    const p = i * 4;
    const r0 = rgba[p];
    const g0 = rgba[p + 1];
    const b0 = rgba[p + 2];
    const lum0 = lum[i];
    const isImageEdge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
    if (isImageEdge) {
      if (x === 0) touchedEdges.add(1);
      if (y === 0) touchedEdges.add(2);
      if (x === width - 1) touchedEdges.add(3);
      if (y === height - 1) touchedEdges.add(4);
    }

    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const ny = y + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      if (flood[j] || bg[j]) continue;
      if (edge[j] > EDGE_STRONG) continue;
      const q = j * 4;
      const dist = Math.max(
        Math.abs(rgba[q] - r0),
        Math.abs(rgba[q + 1] - g0),
        Math.abs(rgba[q + 2] - b0),
      );
      const lumDist = Math.abs(lum[j] - lum0);
      const edgeDamp = 1 - Math.min(1, edge[j] / EDGE_STRONG); // 1 on flat, 0 on strong edge
      const eff = tolerance * (0.55 + 0.45 * edgeDamp);
      if (dist <= eff && lumDist <= eff * 1.6) {
        flood[j] = 1;
        stack[sp++] = j;
      }
    }
    if (sp >= n) break; // safety: never exceed stack capacity
  }

  // ---- Stage 3: morphological open/close + hole filling ------------------
  const fg = new Uint8Array(n);
  for (let i = 0; i < n; i++) fg[i] = flood[i] ? 0 : 1;

  const opened = boxErode(fg, width, height, 1); // opening removes speckles
  const closed = boxDilate(opened, width, height, 2);
  // fill enclosed holes: any background region NOT connected to the border is a hole
  const filled = fillHoles(closed, width, height);
  void bg;

  // ---- Stage 4: soft alpha feathering on the contour --------------------
  const alpha = new Uint8ClampedArray(n);
  let softPixels = 0;
  const dist = distanceInside(filled, width, height); // px distance to nearest outside
  const feather = Math.max(1, Math.round(softness));
  for (let i = 0; i < n; i++) {
    if (filled[i]) {
      const d = dist[i];
      const edgeConf = 1 - Math.min(1, edge[i] / 255) * 0.25;
      let a: number;
      if (d <= 1) {
        a = 96 + 96 * edgeConf; // contour pixel: partially soft
      } else if (d <= 1 + feather) {
        a = 170 + 68 * edgeConf;
      } else {
        a = 255;
      }
      alpha[i] = clamp255(a);
      if (a < 250) softPixels++;
    }
  }

  // ---- bbox --------------------------------------------------------------
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    minX = 0;
    minY = 0;
    maxX = width - 1;
    maxY = height - 1;
  }

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = rgba[i * 4];
    out[i * 4 + 1] = rgba[i * 4 + 1];
    out[i * 4 + 2] = rgba[i * 4 + 2];
    out[i * 4 + 3] = alpha[i];
  }

  return {
    alpha: out,
    width,
    height,
    softPixels,
    touchedEdges,
    box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

// ---- helpers ---------------------------------------------------------------

function boxErode(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w || !src[y * w + xx]) {
          v = 0;
          break;
        }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h || !tmp[yy * w + x]) {
          v = 0;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function boxDilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < w && src[y * w + xx]) {
          v = 1;
          break;
        }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < h && tmp[yy * w + x]) {
          v = 1;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Mark background pixels NOT reachable from the border as foreground (fill holes). */
function fillHoles(fg: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(fg.length);
  const stack = new Int32Array(fg.length);
  let sp = 0;
  const visit = (x: number, y: number) => {
    const i = y * w + x;
    if (!outside[i] && !fg[i]) {
      outside[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    visit(x, 0);
    visit(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    visit(0, y);
    visit(w - 1, y);
  }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) visit(x - 1, y);
    if (x < w - 1) visit(x + 1, y);
    if (y > 0) visit(x, y - 1);
    if (y < h - 1) visit(x, y + 1);
  }
  const out = new Uint8Array(fg.length);
  for (let i = 0; i < fg.length; i++) out[i] = fg[i] || !outside[i] ? 1 : 0;
  return out;
}

/** Chebyshev-ish inside distance via two-pass chamfer (3-4 weights, approx euclid). */
function distanceInside(fg: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(fg.length);
  for (let i = 0; i < fg.length; i++) d[i] = fg[i] ? INF : 0;
  // forward pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!fg[i]) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + 3);
      if (y > 0) m = Math.min(m, d[i - w] + 3);
      if (x > 0 && y > 0) m = Math.min(m, d[i - w - 1] + 4);
      if (x < w - 1 && y > 0) m = Math.min(m, d[i - w + 1] + 4);
      d[i] = m;
    }
  }
  // backward pass
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!fg[i]) continue;
      let m = d[i];
      if (x < w - 1) m = Math.min(m, d[i + 1] + 3);
      if (y < h - 1) m = Math.min(m, d[i + w] + 3);
      if (x < w - 1 && y < h - 1) m = Math.min(m, d[i + w + 1] + 4);
      if (x > 0 && y < h - 1) m = Math.min(m, d[i + w - 1] + 4);
      d[i] = m;
    }
  }
  for (let i = 0; i < fg.length; i++) d[i] /= 3; // normalize to ~pixels
  return d;
}

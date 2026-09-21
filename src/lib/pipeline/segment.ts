// Custom product cutout engine — 100% our own code, no external AI APIs.
//
// Professional-grade rewrite. The old engine used a single fixed-threshold
// flood fill, which leaked through low-contrast edges and ate soft shadows.
// This version runs a proper multi-stage segmentation pipeline:
//
//   1. Border sampling + k-means background color model (handles multi-tone
//      and gradient backdrops that a single threshold cannot represent).
//   2. Model-guided flood fill from the borders: a pixel joins the background
//      when it is close to ANY background cluster (Mahalanobis-style weighted
//      distance in RGB), with edge-stopping damped by a Sobel gradient map so
//      fills never run across real product contours.
//   3. Foreground cleanup: connected-component analysis keeps only components
//      that are plausibly the product (size, contact with fill boundary),
//      then morphological open/close + hole filling.
//   4. Signed-distance alpha matting: alpha ramps smoothly across the contour
//      using the signed distance field (negative inside, positive outside),
//      plus edge-aware color decontamination so halo pixels don't tint the
//      composite.
//   5. Auto-retry: if the first pass clearly fails (no product, or everything
//      is product), the tolerance is adapted and the pipeline re-runs.
//   6. A calibrated confidence score (0..1) derived from model separation,
//      contour edge strength, and boundary regularity — surfaced in the UI.

/** A candidate object the detector found, ranked by product-likelihood. */
export type DetectedObject = {
  box: { x: number; y: number; w: number; h: number };
  area: number;
  /** 0..1 product-likelihood score (size + centrality + border contact). */
  score: number;
};

export type Cutout = {
  alpha: Uint8ClampedArray; // RGBA, RGB = source color (decontaminated), A = alpha (0..255)
  width: number;
  height: number;
  softPixels: number;
  touchedEdges: Set<number>;
  /** Bounding box of the PRIMARY object (clutter is excluded from framing). */
  box: { x: number; y: number; w: number; h: number };
  /** All plausible objects, ranked best-first; box === candidates[0].box. */
  candidates: DetectedObject[];
  /** 0..1 calibrated confidence that the segmentation found the real product. */
  confidence: number;
};

export type SegmentOptions = {
  tolerance?: number;
  softness?: number;
  /** Disable the automatic tolerance retry pass. */
  noRetry?: boolean;
};

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

// ---------------------------------------------------------------- utilities

/** Compact RGB k-means with k-means++-style spreading init. */
function kmeans(
  samples: number[], // packed rgb (r<<16|g<<8|b)
  k: number,
  iters = 10,
): Array<[number, number, number]> {
  if (samples.length === 0) return [[255, 255, 255]];
  if (samples.length <= k) {
    return samples.map((s) => [(s >> 16) & 255, (s >> 8) & 255, s & 255]);
  }

  const unpack = (s: number): [number, number, number] => [
    (s >> 16) & 255,
    (s >> 8) & 255,
    s & 255,
  ];

  // spreading init: sort by luminance and pick quantile seeds
  const sorted = samples.slice().sort((a, b) => {
    const la = ((a >> 16) & 255) + ((a >> 8) & 255) + (a & 255);
    const lb = ((b >> 16) & 255) + ((b >> 8) & 255) + (b & 255);
    return la - lb;
  });
  const centers: Array<[number, number, number]> = [];
  for (let c = 0; c < k; c++) {
    const idx = Math.min(
      sorted.length - 1,
      Math.floor(((c + 0.5) / k) * sorted.length),
    );
    centers.push(unpack(sorted[idx]));
  }

  const assign = new Uint8Array(samples.length);
  for (let iter = 0; iter < iters; iter++) {
    let moved = false;
    for (let i = 0; i < samples.length; i++) {
      const [r, g, b] = unpack(samples[i]);
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const [cr, cg, cb] = centers[c];
        const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
        if (d < bd) {
          bd = d;
          bi = c;
        }
      }
      if (assign[i] !== bi) {
        assign[i] = bi;
        moved = true;
      }
    }
    if (!moved && iter > 0) break;
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < samples.length; i++) {
      const a = sums[assign[i]];
      const [r, g, b] = unpack(samples[i]);
      a[0] += r;
      a[1] += g;
      a[2] += b;
      a[3]++;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sums[c][3] > 0) {
        centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      }
    }
  }
  return centers;
}

/** Weighted distance from a pixel to the nearest background cluster center.
 *  The per-channel scale (from cluster variance) makes dark and light
 *  backdrops equally tractable — plain L-infinity under-weights color axes
 *  that happen to be tight. */
function bgDistance(
  r: number,
  g: number,
  b: number,
  centers: Array<[number, number, number]>,
  scale: [number, number, number],
): number {
  let best = Infinity;
  for (const [cr, cg, cb] of centers) {
    const dr = (r - cr) / scale[0];
    const dg = (g - cg) / scale[1];
    const db = (b - cb) / scale[2];
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    if (d < best) best = d;
  }
  return best;
}

/** Sobel gradient magnitude on the luminance channel. */
function sobel(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    lum[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  const edge = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = lum[i - w - 1];
      const t = lum[i - w];
      const tr = lum[i - w + 1];
      const l = lum[i - 1];
      const r = lum[i + 1];
      const bl = lum[i + w - 1];
      const b = lum[i + w];
      const br = lum[i + w + 1];
      const gx = tl + 2 * l + bl - (tr + 2 * r + br);
      const gy = tl + 2 * t + tr - (bl + 2 * b + br);
      edge[i] = Math.min(255, Math.hypot(gx, gy));
    }
  }
  return edge;
}

/** Chebyshev-ish chamfer distance inside the given binary mask. */
function distanceInside(fg: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(fg.length);
  for (let i = 0; i < fg.length; i++) d[i] = fg[i] ? INF : 0;
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
  for (let i = 0; i < fg.length; i++) d[i] /= 3;
  return d;
}

function distanceOutside(bin: Uint8Array, w: number, h: number): Float32Array {
  const inv = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) inv[i] = bin[i] ? 0 : 1;
  return distanceInside(inv, w, h);
}

/** Signed distance: negative inside the mask, positive outside. */
function signedDistance(fg: Uint8Array, w: number, h: number): Float32Array {
  const inside = distanceInside(fg, w, h);
  const outside = distanceOutside(fg, w, h);
  const out = new Float32Array(fg.length);
  for (let i = 0; i < fg.length; i++) out[i] = fg[i] ? -inside[i] : outside[i];
  return out;
}

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

/** Background pixels not reachable from the border become foreground. */
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

/** 4-connected labeled components; returns labels + per-label pixel counts. */
function components(
  bin: Uint8Array,
  w: number,
  h: number,
): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(bin.length).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(bin.length);
  let next = 0;
  for (let s = 0; s < bin.length; s++) {
    if (!bin[s] || labels[s] !== -1) continue;
    let sp = 0;
    stack[sp++] = s;
    labels[s] = next;
    let size = 0;
    while (sp > 0) {
      const i = stack[--sp];
      size++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && bin[i - 1] && labels[i - 1] === -1) {
        labels[i - 1] = next;
        stack[sp++] = i - 1;
      }
      if (x < w - 1 && bin[i + 1] && labels[i + 1] === -1) {
        labels[i + 1] = next;
        stack[sp++] = i + 1;
      }
      if (y > 0 && bin[i - w] && labels[i - w] === -1) {
        labels[i - w] = next;
        stack[sp++] = i - w;
      }
      if (y < h - 1 && bin[i + w] && labels[i + w] === -1) {
        labels[i + w] = next;
        stack[sp++] = i + w;
      }
    }
    sizes.push(size);
    next++;
  }
  return { labels, sizes };
}

// ---------------------------------------------------------------- main pass

function segmentPass(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance: number,
  softness: number,
): Cutout {
  const n = width * height;

  // ---- Stage 1: edge map + background color model -------------------------
  const edge = sobel(rgba, width, height);
  const EDGE_STRONG = 60;

  // Sample the border ring (product photos nearly always have clear backdrop
  // at the frame) and model it with k-means. Up to 4 clusters capture
  // multi-tone walls, desk edges, and gradients.
  const samples: number[] = [];
  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.06));
  const addSample = (x: number, y: number) => {
    const p = (y * width + x) * 4;
    samples.push((rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]);
  };
  for (let x = 0; x < width; x += 2) {
    for (let t = 0; t < ring; t += 2) {
      addSample(x, t);
      addSample(x, height - 1 - t);
    }
  }
  for (let y = ring; y < height - ring; y += 2) {
    for (let t = 0; t < ring; t += 2) {
      addSample(t, y);
      addSample(width - 1 - t, y);
    }
  }
  const bgCenters = kmeans(samples, 4);

  // Per-axis scale from cluster spread: tight axes weigh more.
  const scale: [number, number, number] = [12, 12, 12];
  {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (const [r, g, b] of bgCenters) {
      // distance from the median cluster acts as a spread proxy
      sr += r;
      sg += g;
      sb += b;
    }
    const mr = sr / bgCenters.length;
    const mg = sg / bgCenters.length;
    const mb = sb / bgCenters.length;
    let vr = 0;
    let vg = 0;
    let vb = 0;
    for (const [r, g, b] of bgCenters) {
      vr += (r - mr) ** 2;
      vg += (g - mg) ** 2;
      vb += (b - mb) ** 2;
    }
    // wider spread -> larger scale -> more permissive per channel
    scale[0] = Math.max(8, Math.sqrt(vr / bgCenters.length) * 0.75 + 6);
    scale[1] = Math.max(8, Math.sqrt(vg / bgCenters.length) * 0.75 + 6);
    scale[2] = Math.max(8, Math.sqrt(vb / bgCenters.length) * 0.75 + 6);
  }

  // ---- Stage 2: model-guided, edge-stopped flood from the borders ---------
  const flood = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const seeds = new Set<number>();
  const step = Math.max(2, Math.round(Math.min(width, height) / 24));
  for (let x = 0; x < width; x += step) {
    seeds.add(x); // top row (y = 0)
    seeds.add((height - 1) * width + x); // bottom row
  }
  for (let y = 0; y < height; y += step) {
    seeds.add(y * width); // left column
    seeds.add(y * width + width - 1); // right column
  }
  for (const s of seeds) {
    if (!flood[s]) {
      stack[sp++] = s;
    }
  }

  const touchedEdges = new Set<number>();
  // tolerance acts as a multiplier on the normalized model distance
  const cutoff = tolerance / 12; // 26 -> ~2.2 sigma-ish
  while (sp > 0) {
    const i = stack[--sp];
    flood[i] = 1;
    const x = i % width;
    const y = (i / width) | 0;
    if (x === 0) touchedEdges.add(1);
    if (y === 0) touchedEdges.add(2);
    if (x === width - 1) touchedEdges.add(3);
    if (y === height - 1) touchedEdges.add(4);
    const p = i * 4;
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const ny = y + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      if (flood[j]) continue;
      if (edge[j] > EDGE_STRONG) continue;
      const q = j * 4;
      const dist = bgDistance(rgba[q], rgba[q + 1], rgba[q + 2], bgCenters, scale);
      // edges damp acceptance: near an edge we demand a much closer match
      const edgeDamp = 1 - Math.min(1, edge[j] / EDGE_STRONG) * 0.65;
      if (dist <= cutoff * edgeDamp) {
        stack[sp++] = j;
      }
    }
    if (sp >= n) break;
  }

  // ---- Stage 3: cleanup — shave, opening, components, closing, holes -----
  const fg0 = new Uint8Array(n);
  for (let i = 0; i < n; i++) fg0[i] = flood[i] ? 0 : 1;

  // Contour shave: the edge-stopped flood leaves a 1–2px band of unreached
  // background pixels hugging every contour (Sobel responses span two pixels
  // at a step edge). Release any foreground pixel that touches background
  // AND is still colorimetrically very close to the bg model. This snaps the
  // mask down to the visual boundary without touching product interiors.
  const shaveCutoff = cutoff * 0.5;
  const shaved = new Uint8Array(fg0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!fg0[i]) continue;
      const touchesBg =
        (x > 0 && !fg0[i - 1]) ||
        (x < width - 1 && !fg0[i + 1]) ||
        (y > 0 && !fg0[i - width]) ||
        (y < height - 1 && !fg0[i + width]);
      if (!touchesBg) continue;
      const p = i * 4;
      if (bgDistance(rgba[p], rgba[p + 1], rgba[p + 2], bgCenters, scale) < shaveCutoff) {
        shaved[i] = 0;
      }
    }
  }

  // Opening (erode 1 + dilate 1): strips the remaining 1px blend halo and
  // kills sub-3px speckles in one move.
  const opened = boxDilate(boxErode(shaved, width, height, 1), width, height, 1);  // keep only meaningful components: the product is large and compact
  const { labels, sizes } = components(opened, width, height);
  const minSize = Math.max(24, n * 0.004);
  const compCount = sizes.length;

  // Per-component statistics in a single pass: area, centroid, bbox, and how
  // much of the component sits on the frame border (a clutter/leak cue).
  const compArea = new Float64Array(compCount);
  const compSumX = new Float64Array(compCount);
  const compSumY = new Float64Array(compCount);
  const compMinX = new Int32Array(compCount).fill(width);
  const compMinY = new Int32Array(compCount).fill(height);
  const compMaxX = new Int32Array(compCount).fill(-1);
  const compMaxY = new Int32Array(compCount).fill(-1);
  const compBorder = new Float64Array(compCount);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const l = labels[i];
      if (l < 0) continue;
      compArea[l]++;
      compSumX[l] += x;
      compSumY[l] += y;
      if (x < compMinX[l]) compMinX[l] = x;
      if (y < compMinY[l]) compMinY[l] = y;
      if (x > compMaxX[l]) compMaxX[l] = x;
      if (y > compMaxY[l]) compMaxY[l] = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) compBorder[l]++;
    }
  }

  // Rank every meaningful component as a product candidate. A product is:
  // reasonably large (but not the whole frame), near the image center, and
  // not glued to the photo border.
  const maxDist = Math.hypot(width, height) / 2;
  const scoreOf = (c: number): number => {
    const af = compArea[c] / n;
    // peaked size score: rewards 18%+ of frame, punishes near-total coverage
    const sizeScore = af >= 0.85 ? 0.15 : Math.min(1, af / 0.18);
    const ccx = compSumX[c] / compArea[c];
    const ccy = compSumY[c] / compArea[c];
    const centrality = 1 - Math.hypot(ccx - width / 2, ccy - height / 2) / maxDist;
    const borderFrac = compArea[c] > 0 ? compBorder[c] / compArea[c] : 1;
    return 0.55 * sizeScore + 0.3 * Math.max(0, centrality) + 0.15 * (1 - borderFrac);
  };

  const keep = new Uint8Array(compCount);
  for (let c = 0; c < compCount; c++) {
    keep[c] = sizes[c] >= minSize ? 1 : 0;
  }
  // If nothing qualifies (very small product), keep the largest component.
  if (keep.every((v) => v === 0) && compCount > 0) {
    let big = 0;
    for (let c = 1; c < compCount; c++) if (sizes[c] > sizes[big]) big = c;
    keep[big] = 1;
  }

  // Ranked candidates (best-first), and the primary object drives the bbox so
  // background clutter never inflates the product framing.
  const ranked: number[] = [];
  for (let c = 0; c < compCount; c++) if (keep[c]) ranked.push(c);
  ranked.sort((a, b) => scoreOf(b) - scoreOf(a));
  const candidates: DetectedObject[] = ranked.slice(0, 4).map((c) => ({
    box: { x: compMinX[c], y: compMinY[c], w: compMaxX[c] - compMinX[c] + 1, h: compMaxY[c] - compMinY[c] + 1 },
    area: compArea[c],
    score: scoreOf(c),
  }));
  const primary = ranked.length > 0 ? ranked[0] : -1;

  const fg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    fg[i] = l >= 0 && keep[l] ? 1 : 0;
  }

  // Closing (dilate 1 + erode 1): seals pinholes and gaps without growing
  // the contour (net-neutral on straight edges — critical for IoU accuracy).
  const closedPair = boxErode(boxDilate(fg, width, height, 1), width, height, 1);
  const filled = fillHoles(closedPair, width, height);

  // ---- Stage 4: signed-distance alpha matting + decontamination ----------
  const alpha = new Uint8ClampedArray(n * 4);
  let softPixels = 0;
  const sd = signedDistance(filled, width, height);

  // Precompute background mean color for decontamination blending.
  let br = 0;
  let bg2 = 0;
  let bb = 0;
  let bcount = 0;
  for (let i = 0; i < n; i++) {
    if (!filled[i]) {
      const p = i * 4;
      br += rgba[p];
      bg2 += rgba[p + 1];
      bb += rgba[p + 2];
      bcount++;
    }
  }
  bcount = Math.max(1, bcount);
  const bgMean = [br / bcount, bg2 / bcount, bb / bcount];

  for (let i = 0; i < n; i++) {
    const d = sd[i];
    let a: number;
    if (d <= -1.5) {
      a = 255;
    } else if (d >= 1.5) {
      a = 0;
    } else {
      // smooth ramp across the contour: -1.5..1.5 px -> 255..0
      const t = (d + 1.5) / 3;
      a = Math.round(255 * (1 - t));
      // edge-confidence nudges the ramp toward the visually correct side
      const ec = Math.min(1, edge[i] / 255);
      a = clamp255(a * (1 - ec * 0.15) + (filled[i] ? ec * 20 : 0));
      softPixels++;
    }
    const p = i * 4;
    alpha[p] = rgba[p];
    alpha[p + 1] = rgba[p + 1];
    alpha[p + 2] = rgba[p + 2];
    alpha[p + 3] = a;

    // decontaminate semi-transparent edge pixels: pull RGB away from the
    // backdrop mean to kill halo fringes on the composite
    if (a > 0 && a < 250) {
      const w = a / 255;
      alpha[p] = clamp255(rgba[p] - (rgba[p] - bgMean[0]) * w * 0.35 * (rgba[p] < bgMean[0] ? 1 : 0));
      alpha[p + 1] = clamp255(rgba[p + 1] - (rgba[p + 1] - bgMean[1]) * w * 0.35 * (rgba[p + 1] < bgMean[1] ? 1 : 0));
      alpha[p + 2] = clamp255(rgba[p + 2] - (rgba[p + 2] - bgMean[2]) * w * 0.35 * (rgba[p + 2] < bgMean[2] ? 1 : 0));
    }
  }

  // ---- confidence ---------------------------------------------------------
  // 1. raw separation: literal RGB distance of foreground pixels from the bg
  //    model (unnormalized) — the single best quality signal. A product 180
  //    levels from the backdrop is unambiguous; 36 levels is not.
  let sepSum = 0;
  let sepCount = 0;
  for (let i = 0; i < n; i += 7) {
    if (!filled[i]) continue;
    const p = i * 4;
    let best = Infinity;
    for (const [cr, cg, cb] of bgCenters) {
      const dr = rgba[p] - cr;
      const dg = rgba[p + 1] - cg;
      const db = rgba[p + 2] - cb;
      const d = Math.sqrt(dr * dr + dg * dg + db * db);
      if (d < best) best = d;
    }
    sepSum += best;
    sepCount++;
  }
  const rawSep = sepCount > 0 ? Math.min(1, sepSum / sepCount / 120) : 0;
  // normalized separation kept as a secondary term
  let sepSum2 = 0;
  for (let i = 0; i < n; i += 7) {
    if (!filled[i]) continue;
    const p = i * 4;
    sepSum2 += bgDistance(rgba[p], rgba[p + 1], rgba[p + 2], bgCenters, scale);
  }
  const separation = sepCount > 0 ? Math.min(1, (sepSum2 / sepCount) / 4) : 0;

  // 2. contour edge support: strong Sobel gradients along the boundary
  let contourHits = 0;
  let contourTotal = 0;
  for (let i = 0; i < n; i++) {
    if (filled[i]) continue;
    const x = i % width;
    const y = (i / width) | 0;
    let adjacent = false;
    if (x > 0 && filled[i - 1]) adjacent = true;
    else if (x < width - 1 && filled[i + 1]) adjacent = true;
    else if (y > 0 && filled[i - width]) adjacent = true;
    else if (y < height - 1 && filled[i + width]) adjacent = true;
    if (!adjacent) continue;
    contourTotal++;
    if (edge[i] > 24) contourHits++;
  }
  const edgeSupport = contourTotal > 0 ? contourHits / contourTotal : 0;

  // 3. compactness: perimeter^2 / area near 4pi means blob-like (clean cut)
  let area = 0;
  for (let i = 0; i < n; i++) if (filled[i]) area++;
  const compactness = area > 0 ? Math.min(1, (4 * Math.PI * area) / (contourTotal * contourTotal + 1)) : 0;

  const confidence = Math.max(
    0,
    Math.min(
      1,
      0.35 * rawSep +
        0.3 * edgeSupport +
        0.2 * separation +
        0.15 * Math.min(1, compactness),
    ),
  );

  // ---- bbox: primary object only ------------------------------------------
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  if (primary >= 0) {
    minX = compMinX[primary];
    minY = compMinY[primary];
    maxX = compMaxX[primary];
    maxY = compMaxY[primary];
  } else {
    for (let i = 0; i < n; i++) {
      if (alpha[i * 4 + 3] > 8) {
        const x = i % width;
        const y = (i / width) | 0;
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

  return {
    alpha,
    width,
    height,
    softPixels,
    touchedEdges,
    box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    candidates,
    confidence,
  };
}

// ---------------------------------------------------------------- public API

export function segment(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opts: SegmentOptions = {},
): Cutout {
  const tolerance = opts.tolerance ?? 26;
  const softness = opts.softness ?? 2;

  const first = segmentPass(rgba, width, height, tolerance, softness);
  if (opts.noRetry) return first;

  const areaFrac =
    (first.box.w * first.box.h) / (width * height);

  // Failure mode A: fill leaked everywhere (whole frame kept).
  if (first.box.w > width * 0.97 && first.box.h > height * 0.97) {
    // try a much tighter tolerance
    const tighter = segmentPass(
      rgba,
      width,
      height,
      Math.max(10, tolerance * 0.55),
      softness,
    );
    const tighterFrac = (tighter.box.w * tighter.box.h) / (width * height);
    if (tighterFrac < 0.9 && tighter.confidence >= first.confidence * 0.8) return tighter;
    return first;
  }

  // Failure mode B: nothing usable found (tiny or zero foreground).
  if (areaFrac < 0.005) {
    const looser = segmentPass(
      rgba,
      width,
      height,
      Math.min(60, tolerance * 1.8),
      softness,
    );
    const looserFrac = (looser.box.w * looser.box.h) / (width * height);
    if (looserFrac > areaFrac * 2 && looserFrac < 0.92) return looser;
    return first;
  }

  // Failure mode C: low-confidence pass — one adaptive retry either way.
  if (first.confidence < 0.35) {
    const tighter = segmentPass(
      rgba,
      width,
      height,
      Math.max(10, tolerance * 0.7),
      softness,
      );
    const looser = segmentPass(
      rgba,
      width,
      height,
      Math.min(60, tolerance * 1.4),
      softness,
    );
    const best = [first, tighter, looser].reduce((a, b) =>
      b.confidence > a.confidence ? b : a,
    );
    return best;
  }

  return first;
}

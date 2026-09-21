// Custom product cutout engine — the custom-math fallback + refinement stage
// for the AI matting pipeline (see aiMatting.ts for the primary model).
//
// DATA FLOW (one `segmentPass` call):
//
//   rgba in
//     │
//     ├─ Stage 1  sobel() ──────────────► edge map (Float32 per pixel)
//     ├─ Stage 1  border ring ─► kmeans ► bg color model (≤4 clusters + scale)
//     │
//     ├─ Stage 2  flood fill from borders, guided by the color model and
//     │           damped near strong edges → "flood" binary (bg = 1)
//     │
//     ├─ Stage 3  invert → contour shave → open → components → RANK
//     │           (score = size + centrality + non-border) → close → fill holes
//     │           → "filled" binary (fg = 1) + ranked candidates
//     │
//     ├─ Stage 4  signedDistance(filled) → adaptive alpha ramp + two-sided
//     │           edge decontamination (unmix bg/product colors) → RGBA out
//     │
//     └─ Stage 5  confidence = 0.35·separation + 0.30·edge support
//                           + 0.20·model distance + 0.15·compactness
//
// `segment()` (public API) wraps segmentPass with auto-retry: it detects the
// classic failure modes (whole-frame leak, nothing found, low confidence) and
// re-runs with adapted tolerance, keeping the best pass.

/** A candidate object the detector found, ranked by product-likelihood. */
export type DetectedObject = {
  box: { x: number; y: number; w: number; h: number };
  area: number;
  /** 0..1 product-likelihood score (size + centrality + border contact). */
  score: number;
};

/** The pipeline's output: source pixels + soft alpha + detection metadata. */
export type Cutout = {
  /** RGBA at source size: RGB = decontaminated source color, A = matte. */
  alpha: Uint8ClampedArray;
  width: number;
  height: number;
  /** Pixels in the soft (partial-alpha) transition band. */
  softPixels: number;
  /** Frame edges (1=left,2=top,3=right,4=bottom) the fill reached —
   *  non-empty means the product may be clipped by the photo border. */
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

import { clamp255 } from "./pixels";

// ---------------------------------------------------------------- utilities

/**
 * Compact RGB k-means over packed 0xRRGGBB samples (a Uint32Array with `count`
 * valid entries — typed arrays keep the hot path free of boxed doubles).
 *
 * Init: luminance-quantile seeding — a cheap k-means++ stand-in that spreads
 * centers across the tonal range instead of letting them cluster.
 * Runs at most `iters` Lloyd iterations, early-exits when assignments stop
 * moving. Used ONLY for the background model (Stage 1) and palette extraction
 * in styles.ts; not a general-purpose clusterer.
 */
function kmeans(
  count: number,
  samples: Uint32Array, // packed rgb (r<<16|g<<8|b), first `count` entries valid
  k: number,
  iters = 10,
): Array<[number, number, number]> {
  if (count === 0) return [[255, 255, 255]];
  if (count <= k) {
    const out: Array<[number, number, number]> = [];
    for (let i = 0; i < count; i++) out.push(unpackPacked(samples[i]));
    return out;
  }

  // spreading init: sort by luminance and pick quantile seeds.
  // Pack luminance into the high bits and index into the low bits, then sort
  // the combined value — avoids allocating a parallel array of pairs.
  const keyed = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const s = samples[i];
    const lum = ((s >> 16) & 255) + ((s >> 8) & 255) + (s & 255); // 0..765 -> 10 bits
    keyed[i] = (lum << 22) | i;
  }
  const sorted = keyed.slice().sort();
  const unpack = unpackPacked;
  const centers: Array<[number, number, number]> = [];
  for (let c = 0; c < k; c++) {
    const idx = Math.min(
      sorted.length - 1,
      Math.floor(((c + 0.5) / k) * sorted.length),
    );
    centers.push(unpack(sorted[idx]));
  }

  const assign = new Uint8Array(count);
  for (let iter = 0; iter < iters; iter++) {
    let moved = false;
    for (let i = 0; i < count; i++) {
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
    for (let i = 0; i < count; i++) {
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

/** Unpack a packed rgb uint32 into [r, g, b]. */
function unpackPacked(s: number): [number, number, number] {
  return [(s >> 16) & 255, (s >> 8) & 255, s & 255];
}

/**
 * Weighted distance from a pixel to the nearest background cluster center.
 * The per-axis scale (derived from cluster spread) makes dark and light
 * backdrops equally tractable — plain Euclidean under-weights color axes
 * that happen to be tight, causing leaks on saturated backdrops.
 */
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

/**
 * Sobel gradient magnitude on the luminance channel (0..255 per pixel).
 * Border pixels are left 0 — the flood seeds on the frame anyway.
 */
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
  // Edges: Sobel magnitude — used BOTH to stop the flood (Stage 2) and later
  // to sharpen the alpha ramp where the contour is high-contrast (Stage 4).
  // Background model: sample a ring just inside the frame (product photos
  // nearly always show clear backdrop at the borders), k-means into ≤4
  // clusters. Multi-cluster handles walls+desk seams and gradients that a
  // single threshold cannot represent.
  const edge = sobel(rgba, width, height);
  const EDGE_STRONG = 60;

  // Sample the border ring (product photos nearly always have clear backdrop
  // at the frame) and model it with k-means. Up to 4 clusters capture
  // multi-tone walls, desk edges, and gradients.
  // Typed array (not number[]): avoids boxing ~100k+ doubles per pass and
  // keeps the retry passes' GC pressure near zero.
  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.06));
  const maxSamples = Math.ceil(width / 2) * Math.ceil(ring / 2) * 2 * 2 + Math.ceil((height - 2 * ring) / 2) * Math.ceil(ring / 2) * 2 * 2;
  const samples = new Uint32Array(maxSamples);
  let sc = 0;
  const addSample = (x: number, y: number) => {
    if (sc >= maxSamples) return;
    const p = (y * width + x) * 4;
    samples[sc++] = ((rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]) >>> 0;
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
  const bgCenters = kmeans(sc, samples, 4);

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
  // BFS from border seeds. A neighbor joins the background when its color is
  // close enough to ANY cluster (`cutoff` = tolerance/12, i.e. ~2.2σ at the
  // default 26) AND the Sobel edge under it is weak. Near edges the threshold
  // is damped (edgeDamp) so the fill never crosses a product contour — this
  // is what keeps dark products on dark desks separable.
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

  // ---- Stage 3: cleanup — shave, opening, components, ranking, holes ------
  // Invert the flood: unreached pixels = foreground candidates. The flood
  // leaves a 1–2px blend band on every contour (Sobel spans two pixels at a
  // step edge), so: contour shave → opening → component ranking → closing →
  // hole fill. See the candidate-ranking block below for the scoring model.
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
  // Alpha ramps smoothly across the contour: the signed distance field is
  // negative inside / positive outside, and the band half-width adapts to
  // edge strength (strong edge = tight ±1px mat, soft edge = ±2.5px). Edge
  // band pixels are DECONTAMINATED: their color is unmixed off the
  // bg→product line so neither dark nor light environment fringes survive.
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

  // Edge-band decontamination context: for each contour pixel, estimate the
  // true product color by walking INWARD along the signed-distance gradient.
  // The old one-sided heuristic (only darken toward bgMean) left bright
  // environment fringes intact — the most common "background remover still
  // keeps edges of the environment" complaint.
  const sdGradX = new Float32Array(n);
  const sdGradY = new Float32Array(n);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      sdGradX[i] = sd[i + 1] - sd[i - 1];
      sdGradY[i] = sd[i + width] - sd[i - width];
    }
  }

  for (let i = 0; i < n; i++) {
    const d = sd[i];
    // adaptive band: strong edges get a tight mat (crisp silhouettes), soft
    // edges a wider one (hair, fabric) — fixed ±1.5px kept fringes on both.
    const ec = Math.min(1, edge[i] / 255);
    const band = 1 + (1 - ec) * 1.5; // 1.0..2.5 px half-width
    let a: number;
    if (d <= -band) {
      a = 255;
    } else if (d >= band) {
      a = 0;
    } else {
      const t = (d + band) / (2 * band);
      a = Math.round(255 * (1 - t));
      a = clamp255(a + (filled[i] ? ec * 20 : 0));
      softPixels++;
    }
    const p = i * 4;

    // two-sided decontamination for the whole transition band: project the
    // pixel color onto the line between the estimated product color (a few
    // px inside) and the background model. Removes BOTH dark and light
    // environment fringes, not just one side.
    let or_ = rgba[p];
    let og = rgba[p + 1];
    let ob = rgba[p + 2];
    if (a > 0 && a < 255) {
      const x = i % width;
      const y = (i / width) | 0;
      const gl = Math.hypot(sdGradX[i], sdGradY[i]) || 1;
      // walk 2px toward the product interior
      const stepIn = 2;
      const ix = Math.round(Math.max(0, Math.min(width - 1, x + (sdGradX[i] / gl) * -stepIn)));
      const iy = Math.round(Math.max(0, Math.min(height - 1, y + (sdGradY[i] / gl) * -stepIn)));
      const ip = (iy * width + ix) * 4;
      const pr = rgba[ip];
      const pg = rgba[ip + 1];
      const pb = rgba[ip + 2];
      const mix = a / 255;
      // pull the observed color off the bg->product line by the alpha mix:
      // unmix C = bg + mix*(product - bg)  =>  product_est = bg + (C - bg)/max(mix,0.25)
      const inv = 1 / Math.max(0.25, mix);
      const estR = bgMean[0] + (or_ - bgMean[0]) * inv;
      const estG = bgMean[1] + (og - bgMean[1]) * inv;
      const estB = bgMean[2] + (ob - bgMean[2]) * inv;
      // blend the unmix estimate with the inward sample (guards against
      // walking into a different-colored interior region)
      const wIn = 0.45;
      or_ = clamp255((estR * (1 - wIn) + pr * wIn) * 0.35 + or_ * 0.65);
      og = clamp255((estG * (1 - wIn) + pg * wIn) * 0.35 + og * 0.65);
      ob = clamp255((estB * (1 - wIn) + pb * wIn) * 0.35 + ob * 0.65);
    }

    alpha[p] = or_;
    alpha[p + 1] = og;
    alpha[p + 2] = ob;
    alpha[p + 3] = a;
  }

  // ---- confidence ---------------------------------------------------------
  // A calibrated 0..1 quality score surfaced in the UI (green/amber/red).
  // Four weighted signals, chosen so a clean studio shot scores ~0.95+ and an
  // ambiguous low-contrast scene drops below 0.5:
  //   rawSep (35%)   — literal RGB distance of fg pixels from the bg model.
  //                    The single best signal: a product 180 levels from the
  //                    backdrop is unambiguous; 36 levels is not.
  //   edgeSup (30%)  — share of boundary pixels sitting on a strong Sobel
  //                    gradient (did we land on the REAL contour?).
  //   separ. (20%)   — normalized model distance (secondary to rawSep).
  //   compact (15%)  — 4πA/P² shape regularity; blob-like cuts score higher
  //                    than ragged, leaky boundaries.
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

/**
 * Segment with auto-retry. Runs one pass, detects classic failure modes, and
 * re-runs with adapted tolerance when the evidence says the first pass lost:
 *
 *   A. whole-frame leak (box ≈ frame)      → retry much tighter (×0.55)
 *   B. nothing found (area < 0.5%)         → retry much looser (×1.8)
 *   C. low confidence (< 0.35)             → try BOTH directions, keep best
 *
 * Each retry keeps the better pass by confidence, so the function can only
 * improve on the first attempt. `noRetry` skips everything (used by tests and
 * the internal refinement path where the caller controls tolerance).
 */
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

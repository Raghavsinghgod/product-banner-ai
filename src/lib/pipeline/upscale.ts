// Detail-preserving image upscaler — 100% custom pixel math, no external APIs.
//
// Naive bilinear scaling of a small product photo looks soft, and plain
// sharpening after scaling rings around high-contrast edges (halos). This
// engine works in three stages, all operating on Float32 channels:
//
//   1. Edge-directed interpolation (3x3 window): scale with bilinear, then
//      along strong luminance gradients blend toward edge-directed sampling —
//      sharp diagonal/vertical/horizontal lines stay sharp instead of
//      smearing into steps.
//   2. Adaptive unsharp masking: a luminance high-pass (box-blur diff)
//      amplified with a per-pixel gain that fades to zero near strong edges
//      (halo suppression) — texture gets crisp, silhouettes stay clean.
//      High-contrast structures (text, logos, seams) get an extra
//      "crispness" pass with a tighter kernel and local-contrast floor, so
//      small type and line art read sharply at 2x/3x.
//   3. Chroma denoise: alpha-weighted chroma smoothing that never touches
//      luminance (no color bleeding on the edge alpha).

export type UpscaleOptions = {
  /** Integer scale factor (2 or 3). */
  factor: 2 | 3;
  /** 0..1 texture sharpening strength. */
  sharpening?: number;
  /** 0..1 extra gain for high-contrast structure (text/lines). */
  crispness?: number;
};

export type UpscaledImage = {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
};

/** 3-iteration separable box blur ≈ Gaussian, O(1) per pixel. */
function blur3(src: Float32Array, w: number, h: number, r: number): Float32Array {
  let cur = src;
  for (let pass = 0; pass < 3; pass++) cur = boxBlurOnce(cur, w, h, r);
  return cur;
}

function boxBlurOnce(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * norm;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for ( let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * norm;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/**
 * Upscale an RGBA image by an integer factor with edge-directed detail
 * reconstruction, halo-suppressed unsharp masking and a crisp pass for
 * high-contrast structure. Deterministic.
 */
export function upscaleImage(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opts: UpscaleOptions,
): UpscaledImage {
  const f = opts.factor;
  const W = width * f;
  const H = height * f;
  const n = W * H;

  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const A = new Float32Array(n);
  const L = new Float32Array(n); // luminance

  // ---- stage 1: edge-directed interpolation --------------------------------
  // For each destination pixel, sample the 2x2 source neighbors. Compute the
  // local gradient direction in the source; if the destination sits across a
  // strong edge, sample bilinearly ALONG the edge (weighted toward the
  // neighbor on the same side) instead of across it. This keeps lines crisp.
  const sharpening = opts.sharpening ?? 0.55;
  const crispness = opts.crispness ?? 0.7;

  const sample = (x: number, y: number, ch: 0 | 1 | 2 | 3): number => {
    const xx = Math.max(0, Math.min(width - 1, x));
    const yy = Math.max(0, Math.min(height - 1, y));
    return rgba[(yy * width + xx) * 4 + ch];
  };

  for (let dy = 0; dy < H; dy++) {
    const sy = (dy + 0.5) / f - 0.5; // source-space y
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let dx = 0; dx < W; dx++) {
      const sx = (dx + 0.5) / f - 0.5;
      const x0 = Math.floor(sx);
      const fx = sx - x0;

      const x0c = Math.max(0, Math.min(width - 1, x0));
      const x1c = Math.max(0, Math.min(width - 1, x0 + 1));
      const y0c = Math.max(0, Math.min(height - 1, y0));
      const y1c = Math.max(0, Math.min(height - 1, y0 + 1));

      const i00 = (y0c * width + x0c) * 4;
      const i10 = (y0c * width + x1c) * 4;
      const i01 = (y1c * width + x0c) * 4;
      const i11 = (y1c * width + x1c) * 4;

      // luminance of the four neighbors
      const l00 = 0.299 * rgba[i00] + 0.587 * rgba[i00 + 1] + 0.114 * rgba[i00 + 2];
      const l10 = 0.299 * rgba[i10] + 0.587 * rgba[i10 + 1] + 0.114 * rgba[i10 + 2];
      const l01 = 0.299 * rgba[i01] + 0.587 * rgba[i01 + 1] + 0.114 * rgba[i01 + 2];
      const l11 = 0.299 * rgba[i11] + 0.587 * rgba[i11 + 1] + 0.114 * rgba[i11 + 2];

      // horizontal / vertical edge strength at this sample point
      const gh = Math.abs(l00 - l10) + Math.abs(l01 - l11);
      const gv = Math.abs(l00 - l01) + Math.abs(l10 - l11);

      let r: number, g: number, b: number, a: number, l: number;
      if (gh > gv * 1.35 && gh > 28) {
        // vertical edge — interpolate vertically within each column, then X
        const topL = l00 * (1 - fy) + l01 * fy;
        const topR = l10 * (1 - fy) + l11 * fy;
        // snap: if we are on the dark side, sample only that column
        const wLeft = topL <= topR ? 1 - fx * 0.7 : 1;
        const wRight = 2 - wLeft;
        const wl = wLeft / (wLeft + wRight);
        r = rgba[i00] * (1 - fy) * wl + rgba[i01] * fy * wl + rgba[i10] * (1 - fy) * (1 - wl) + rgba[i11] * fy * (1 - wl);
        g = rgba[i00 + 1] * (1 - fy) * wl + rgba[i01 + 1] * fy * wl + rgba[i10 + 1] * (1 - fy) * (1 - wl) + rgba[i11 + 1] * fy * (1 - wl);
        b = rgba[i00 + 2] * (1 - fy) * wl + rgba[i01 + 2] * fy * wl + rgba[i10 + 2] * (1 - fy) * (1 - wl) + rgba[i11 + 2] * fy * (1 - wl);
        a = rgba[i00 + 3] * (1 - fy) * wl + rgba[i01 + 3] * fy * wl + rgba[i10 + 3] * (1 - fy) * (1 - wl) + rgba[i11 + 3] * fy * (1 - wl);
        l = topL * wl + topR * (1 - wl);
      } else if (gv > gh * 1.35 && gv > 28) {
        // horizontal edge — interpolate horizontally within each row
        const leftL = l00 * (1 - fx) + l10 * fx;
        const rightL = l01 * (1 - fx) + l11 * fx;
        const wTop = leftL <= rightL ? 1 - fy * 0.7 : 1;
        const wBottom = 2 - wTop;
        const wt = wTop / (wTop + wBottom);
        r = rgba[i00] * (1 - fx) * wt + rgba[i10] * fx * wt + rgba[i01] * (1 - fx) * (1 - wt) + rgba[i11] * fx * (1 - wt);
        g = rgba[i00 + 1] * (1 - fx) * wt + rgba[i10 + 1] * fx * wt + rgba[i01 + 1] * (1 - fx) * (1 - wt) + rgba[i11 + 1] * fx * (1 - wt);
        b = rgba[i00 + 2] * (1 - fx) * wt + rgba[i10 + 2] * fx * wt + rgba[i01 + 2] * (1 - fx) * (1 - wt) + rgba[i11 + 2] * fx * (1 - wt);
        a = rgba[i00 + 3] * (1 - fx) * wt + rgba[i10 + 3] * fx * wt + rgba[i01 + 3] * (1 - fx) * (1 - wt) + rgba[i11 + 3] * fx * (1 - wt);
        l = leftL * wt + rightL * (1 - wt);
      } else {
        // smooth area: standard bilinear
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        r = rgba[i00] * w00 + rgba[i10] * w10 + rgba[i01] * w01 + rgba[i11] * w11;
        g = rgba[i00 + 1] * w00 + rgba[i10 + 1] * w10 + rgba[i01 + 1] * w01 + rgba[i11 + 1] * w11;
        b = rgba[i00 + 2] * w00 + rgba[i10 + 2] * w10 + rgba[i01 + 2] * w01 + rgba[i11 + 2] * w11;
        a = rgba[i00 + 3] * w00 + rgba[i10 + 3] * w10 + rgba[i01 + 3] * w01 + rgba[i11 + 3] * w11;
        l = l00 * w00 + l10 * w10 + l01 * w01 + l11 * w11;
      }

      const j = dy * W + dx;
      R[j] = r;
      G[j] = g;
      B[j] = b;
      A[j] = a;
      L[j] = l;
    }
  }

  // ---- stage 2: halo-suppressed unsharp mask -------------------------------
  // high-pass = L - blur(L); gain fades to zero at strong edges so we never
  // overshoot silhouettes (the classic ringing halo of naive sharpening).
  const lo = blur3(L.slice(), W, H, Math.max(1, Math.round(f / 2)));
  // local edge magnitude of the upscaled luminance
  const edgeMag = new Float32Array(n);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = Math.abs(2 * L[i - 1] - L[i - W - 1] - L[i + W - 1]) +
                 Math.abs(2 * L[i + 1] - L[i - W + 1] - L[i + W + 1]);
      const gy = Math.abs(2 * L[i - W] - L[i - W - 1] - L[i - W + 1]) +
                 Math.abs(2 * L[i + W] - L[i + W - 1] - L[i + W + 1]);
      edgeMag[i] = gx + gy;
    }
  }
  const edgeSoft = blur3(edgeMag, W, H, Math.max(1, f));

  // local-contrast floor for the crisp pass: strong 1px-scale structure
  const hi = blur3(L.slice(), W, H, 1);

  for (let i = 0; i < n; i++) {
    const hp = L[i] - lo[i];
    // 0..1 halo suppressor: fades sharpening to zero as local edge grows
    let sup = 1 - Math.min(1, edgeSoft[i] / 60);
    sup = sup * sup * (3 - 2 * sup);
    const gain = sharpening * sup * 1.6;
    let lNew = L[i] + hp * gain;

    // crisp pass: high-contrast micro-structure (text, line art) gets a
    // tighter, stronger boost, gated by actual high local contrast so flat
    // areas stay clean
    const micro = L[i] - hi[i];
    const contrast = Math.abs(micro);
    if (contrast > 2.5) {
      const crispGain = crispness * sup * Math.min(1, (contrast - 2.5) / 12) * 1.3;
      lNew += micro * crispGain;
    }
    // clamp via ratio preservation to avoid color shifts
    const ratio = L[i] > 1 ? lNew / L[i] : 1 + (lNew - L[i]) / 128;
    R[i] = Math.max(0, Math.min(255, R[i] * ratio));
    G[i] = Math.max(0, Math.min(255, G[i] * ratio));
    B[i] = Math.max(0, Math.min(255, B[i] * ratio));
  }

  // ---- stage 3: chroma denoise on semi-transparent edge pixels -------------
  // (cheap: single 1px box on chroma, blended by alpha<250 so interiors are
  // untouched; luminance is never touched)
  const Cr = new Float32Array(n);
  const Cb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    Cr[i] = R[i] - L[i];
    Cb[i] = B[i] - L[i];
  }
  const CrS = blur3(Cr, W, H, 1);
  const CbS = blur3(Cb, W, H, 1);

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const l = Math.max(0, Math.min(255, L[i]));
    const chromaBlend = A[i] > 0 && A[i] < 250 ? 0.45 : 0;
    out[p] = l + Cr[i] * (1 - chromaBlend) + CrS[i] * chromaBlend;
    out[p + 1] = Math.max(0, Math.min(255, G[i]));
    out[p + 2] = l + Cb[i] * (1 - chromaBlend) + CbS[i] * chromaBlend;
    out[p + 3] = A[i];
  }

  return { rgba: out, width: W, height: H };
}

/** Upscale + snap back into an ImageData for canvas consumers. */
export function upscaleToImageData(
  src: ImageData,
  opts: UpscaleOptions,
): ImageData {
  const up = upscaleImage(src.data, src.width, src.height, opts);
  const cv = new ImageData(up.width, up.height);
  cv.data.set(up.rgba);
  return cv;
}

# Relight — AI Product Photo Cleaner

Turn a messy phone photo of a product into a clean, professional banner with
realistic shadows — entirely **on-device**, in seconds. Built for resellers
(Vinted / Depop / eBay) and for hackathon judges who penalize
"just wrap an API" projects.

**Live demo:** _deploy to Vercel/Netlify (config included) and paste the URL_

---

## How it works

```
photo ──► ① AI matting ──► ② refinement ──► ③ shadow engine ──► ④ banner ──► PNG
```

1. **AI matting** — [BiRefNet_lite](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX)
   (**MIT license**) runs fully in the browser via
   [Transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0)
   on ONNX Runtime Web (WASM/WebGPU). Weights (~56 MB fp32) stream from the
   Hugging Face CDN on first use and are cached by the browser afterwards.
   No uploads, no API keys, no per-image cost.
2. **Refinement + fallback** — our own custom segmentation engine
   (border-sampled k-means background color model → edge-stopped guided flood →
   morphological cleanup → signed-distance alpha matting with two-sided edge
   decontamination). It refines the AI mask's edges and serves as the full
   pipeline when the model can't load.
3. **Shadow engine** — 100% custom: coverage-integral umbra/penumbra (the
   silhouette is swept along the light vector in ~40 weighted steps), two-scale
   box-blur filtering (crisp at contact, soft away), shape-aware contact
   ambient occlusion, deterministic organic edge jitter. Physics-invariant tested.
4. **Banner composer** — 8 studio backdrops + a **generative design engine**
   (seeded procedural scenes: palette harmonized to your product, light pools,
   paper grain, shapes), 3 platform ratios, live before/after slider,
   full-resolution PNG export.

Everything runs on-device. Photos never leave the browser.

## Open source & licenses

This project only builds on permissively-licensed work:

| Component | License | Role |
|---|---|---|
| [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) (ZhengPeng7 et al.) | **MIT** | Segmentation model architecture + weights |
| [onnx-community/BiRefNet_lite-ONNX](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) | **MIT** | ONNX conversion used at runtime |
| [Transformers.js](https://github.com/huggingface/transformers.js) | Apache-2.0 | In-browser model runtime |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | MIT | WASM/WebGPU execution |
| Relight's engines (segmentation, shadows, upscaler, design) | MIT (this repo) | Custom code |

**Deliberately NOT used:** remove.bg (proprietary API, paid, uploads photos),
imgly/background-removal-js (AGPL — viral copyleft), briaai/RMBG
(non-commercial license).

## Run locally

```bash
bun install
bun run dev        # dev server
bun run test       # 64-test pipeline suite (IoU, physics, precision invariants)
bun tsc -b --noEmit
```

## Deploy (free)

**Vercel** — `vercel.json` included:

```bash
npm i -g vercel && vercel deploy --prod
```

**Netlify** — build `bun run build`, publish `dist/` (or connect the repo; the
build works out of the box).

No server, no database, no secrets: a pure static SPA, so any free static
host works (Vercel, Netlify, Cloudflare Pages, GitHub Pages).

## Hackathon notes

- **Why not just wrap remove.bg?** Judges penalize it; also it uploads user
  photos and charges per image. Our pipeline is free, private, and demonstrably
  deeper (64 automated tests: IoU ground-truth segmentation accuracy,
  shadow physics invariants, resampler precision proofs).
- **Model provenance**: BiRefNet is MIT — safe to demo, fork, and ship.

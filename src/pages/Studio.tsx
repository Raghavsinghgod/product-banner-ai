import { BeforeAfterSlider } from "@/components/BeforeAfterSlider";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  autoPlacement,
  BACKDROPS,
  drawBackdrop,
  drawBanner,
  drawProduct,
  exportBanner,
  getRatio,
  RATIOS,
  type BackdropId,
  type Placement,
  type RatioId,
} from "@/lib/pipeline/banner";
import { getDemoBefore } from "@/lib/pipeline/demo";
import { paintShadow, renderShadow } from "@/lib/pipeline/shadow";
import { segment, type Cutout } from "@/lib/pipeline/segment";
import { DEFAULT_SHADOW, type ShadowOptions } from "@/lib/pipeline/shadow";
import {
  analyzeCutout,
  getStyle,
  OUTPUT_STYLES,
  recommendStyles,
  type OutputStyleId,
  type StyleAnalysis,
} from "@/lib/pipeline/styles";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Download,
  ImageUp,
  RotateCcw,
  Sparkles,
  Wand2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

type Stage = "empty" | "processing" | "ready" | "error";

const MAX_SIDE = 1400;

const SHADOW_PRESETS: Array<{ id: string; label: string; opts: Partial<ShadowOptions> }> = [
  { id: "studio", label: "Studio soft", opts: { direction: 55, length: 0.65, softness: 0.65, opacity: 0.4, contact: true } },
  { id: "sun", label: "Hard sun", opts: { direction: 30, length: 1.05, softness: 0.28, opacity: 0.5, contact: true } },
  { id: "moody", label: "Moody", opts: { direction: 115, length: 0.85, softness: 0.5, opacity: 0.55, contact: true } },
  { id: "flat", label: "Flat lay", opts: { direction: 90, length: 0.35, softness: 0.75, opacity: 0.3, contact: true } },
];

export default function Studio() {
  const [stage, setStage] = useState<Stage>("empty");
  const [fileName, setFileName] = useState<string | null>(null);
  const [beforeUrl, setBeforeUrl] = useState<string | null>(null);
  const [afterUrl, setAfterUrl] = useState<string | null>(null);
  const [edgeWarning, setEdgeWarning] = useState(false);
  const [fitWarning, setFitWarning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [backdrop, setBackdrop] = useState<BackdropId>("studio");
  const [ratio, setRatio] = useState<RatioId>("4:5");
  const [shadow, setShadow] = useState<ShadowOptions>(DEFAULT_SHADOW);
  const [style, setStyle] = useState<OutputStyleId>("white-shadow");
  const [shadowsOn, setShadowsOn] = useState(true);
  const [analysis, setAnalysis] = useState<StyleAnalysis | null>(null);
  const [recommended, setRecommended] = useState<OutputStyleId[]>([]);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [size, setSize] = useState(100); // percent of auto scale
  const [height, setHeight] = useState(72); // baseline percent of canvas height
  const [tolerance, setTolerance] = useState(26);

  const cutoutRef = useRef<Cutout | null>(null);
  const sourceRef = useRef<{ data: ImageData; width: number; height: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [cutoutTick, setCutoutTick] = useState(0);

  // ---- load a File -------------------------------------------------------
  const loadFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    setStage("processing");
    setFileName(file.name);
    try {
      const bitmap = await createImageBitmap(file);
      await ingestBitmap(bitmap);
    } catch (err) {
      console.error(err);
      setStage("error");
    }
  }, []);

  const ingestBitmap = async (bitmap: ImageBitmap) => {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    sourceRef.current = { data, width: w, height: h };
    setBeforeUrl(cv.toDataURL("image/jpeg", 0.85));

    // give the UI a frame to show the processing state
    await new Promise((r) => setTimeout(r, 30));
    runSegment(data.data, w, h, tolerance);
  };

  // ---- segmentation ------------------------------------------------------
  const runSegment = (rgba: Uint8ClampedArray, w: number, h: number, tol: number) => {
    try {
      const cutout = segment(rgba, w, h, { tolerance: tol });
      const { box } = cutout;
      cutoutRef.current = cutout;
      setConfidence(cutout.confidence);
      setEdgeWarning(cutout.touchedEdges.size > 0);
      const coversAll = box.w > w * 0.97 && box.h > h * 0.97;
      setFitWarning(coversAll);
      // Style analysis + recommendation straight from the cutout pixels,
      // then auto-apply the best-match output style.
      try {
        const a = analyzeCutout(cutout);
        setAnalysis(a);
        const rec = recommendStyles(a);
        setRecommended(rec);
        if (rec[0]) applyStyle(rec[0]);
      } catch {
        setAnalysis(null);
        setRecommended([]);
      }
      setSize(100);
      setHeight(72);
      setCutoutTick((t) => t + 1);
      setStage(coversAll ? "error" : "ready");
    } catch (err) {
      console.error(err);
      setStage("error");
    }
  };

  // ---- load the procedural sample ---------------------------------------
  const loadSample = useCallback(async () => {
    setStage("processing");
    setFileName("sample-mug.jpg");
    try {
      const url = getDemoBefore();
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("sample failed"));
        img.src = url;
      });
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const ctx = cv.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, cv.width, cv.height);
      sourceRef.current = { data, width: cv.width, height: cv.height };
      setBeforeUrl(url);
      await new Promise((r) => setTimeout(r, 30));
      runSegment(data.data, cv.width, cv.height, tolerance);
    } catch (err) {
      console.error(err);
      setStage("error");
    }
  }, [tolerance]);

  // ---- render loop -------------------------------------------------------
  useEffect(() => {
    if (stage !== "ready" || !cutoutRef.current) return;
    let raf = 0;
    const t = setTimeout(() => {
      raf = requestAnimationFrame(() => {
        const cutout = cutoutRef.current;
        if (!cutout) return;
        const r = getRatio(ratio);
        const out = canvasRef.current ?? document.createElement("canvas");
        canvasRef.current = out;
        out.width = r.w;
        out.height = r.h;
        const ctx = out.getContext("2d")!;
        const base = autoPlacement(cutout, r.w, r.h);
        const place: Placement = {
          x: base.x,
          y: (height / 100) * r.h,
          scale: base.scale * (size / 100),
        };
        ctx.clearRect(0, 0, r.w, r.h);
        drawBackdrop(ctx, r.w, r.h, backdrop);
        if (shadowsOn) {
          const mask = renderShadow(cutout, place, r.w, r.h, shadow);
          paintShadow(ctx, mask, r.w, r.h);
        }
        drawProduct(ctx, cutout, place);
        setAfterUrl(out.toDataURL("image/png"));
      });
    }, 40);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(raf);
    };
  }, [stage, cutoutTick, backdrop, ratio, shadow, shadowsOn, size, height]);

  const reset = () => {
    cutoutRef.current = null;
    sourceRef.current = null;
    canvasRef.current = null;
    setStage("empty");
    setBeforeUrl(null);
    setAfterUrl(null);
    setFileName(null);
    setEdgeWarning(false);
    setFitWarning(false);
    setTolerance(26);
    setShadow(DEFAULT_SHADOW);
    setSize(100);
    setHeight(72);
    setAnalysis(null);
    setRecommended([]);
    setConfidence(null);
    setStyle("white-shadow");
    setShadowsOn(true);
    setBackdrop("studio");
  };

  const retrySegmentation = () => {
    const src = sourceRef.current;
    if (!src) return;
    setStage("processing");
    setTimeout(() => runSegment(src.data.data, src.width, src.height, tolerance), 30);
  };

  // Pick one of the five output styles; the style drives backdrop + shadow
  // defaults, but everything stays tweakable afterwards.
  const applyStyle = (id: OutputStyleId) => {
    const def = getStyle(id);
    setStyle(id);
    setBackdrop(def.backdrop);
    setShadowsOn(def.shadows);
    if (def.shadows) setShadow({ ...def.shadow });
  };

  const activePreset = SHADOW_PRESETS.find(
    (p) =>
      p.opts.direction === shadow.direction &&
      p.opts.length === shadow.length &&
      p.opts.softness === shadow.softness &&
      p.opts.opacity === shadow.opacity,
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* top bar */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <Logo size={28} />
          </Link>
          <div className="flex items-center gap-2">
            {fileName && (
              <span className="mr-1 hidden max-w-52 truncate text-sm text-muted-foreground sm:block">
                {fileName}
              </span>
            )}
            <ThemeToggle />
            <Button variant="outline" size="sm" onClick={reset}>
              <RotateCcw className="size-4" />
              New photo
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
        <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
          {/* -------------------------------------------------- controls */}
          <div className="flex flex-col gap-4">
            {/* upload */}
            <Card className="p-5">
              <div className="mb-3 flex items-center gap-2">
                <ImageUp className="size-4 text-primary" />
                <h2 className="font-display text-sm font-semibold tracking-wide uppercase">
                  1 · Photo
                </h2>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) loadFile(f);
                  e.target.value = "";
                }}
              />
              <div
                role="button"
                tabIndex={0}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) loadFile(f);
                }}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 py-7 text-center transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  dragOver ? "border-primary bg-primary/5" : "hover:border-primary/40 hover:bg-muted/50",
                )}
              >
                <div className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                  <ImageUp className="size-5 text-primary" />
                </div>
                <p className="mt-3 text-sm font-medium">Drop a photo or click to browse</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  JPG / PNG — product on any messy background
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-3 w-full"
                onClick={loadSample}
                disabled={stage === "processing"}
              >
                <Sparkles className="size-4 text-primary" />
                Try the sample photo
              </Button>
            </Card>

            {/* output styles */}
            <Card className={cn("p-5", stage !== "ready" && "pointer-events-none opacity-50")}>
              <div className="mb-3 flex items-center gap-2">
                <Sparkles className="size-4 text-primary" />
                <h2 className="font-display text-sm font-semibold tracking-wide uppercase">
                  2 · Output style
                </h2>
              </div>
              <div className="grid gap-2">
                {OUTPUT_STYLES.map((s) => {
                  const rank = recommended.indexOf(s.id);
                  return (
                    <button
                      key={s.id}
                      onClick={() => applyStyle(s.id)}
                      className={cn(
                        "group flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        style === s.id
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/40 hover:bg-muted/50",
                      )}
                    >
                      <span
                        className="size-8 shrink-0 rounded-lg ring-1 ring-black/10"
                        style={{
                          background:
                            s.id === "pure-white"
                              ? "#fff"
                              : s.id === "white-shadow"
                                ? "linear-gradient(180deg,#fff 55%,#ececec)"
                                : s.id === "premium-desk"
                                  ? "linear-gradient(180deg,#6b4a34,#452e20)"
                                  : s.id === "studio"
                                    ? "linear-gradient(180deg,#f7f6f3,#e9e6df)"
                                    : "linear-gradient(180deg,#33373b,#1e2124)",
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          {s.label}
                          {rank === 0 && stage === "ready" && (
                            <Badge
                              variant="secondary"
                              className="h-4 rounded-full px-1.5 text-[10px]"
                            >
                              Best match
                            </Badge>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {s.blurb}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {!shadowsOn && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Shadows are off for this style — flip the switch below to add them.
                </p>
              )}
            </Card>

            {/* backdrop + ratio */}
            <Card className={cn("p-5", stage !== "ready" && "opacity-50 pointer-events-none")}>
              <div className="mb-3 flex items-center gap-2">
                <Wand2 className="size-4 text-primary" />
                <h2 className="font-display text-sm font-semibold tracking-wide uppercase">
                  3 · Backdrop &amp; size
                </h2>
              </div>
              <div className="grid grid-cols-6 gap-2">
                {BACKDROPS.map((b) => (
                  <button
                    key={b.id}
                    title={b.label}
                    onClick={() => setBackdrop(b.id)}
                    className={cn(
                      "h-9 rounded-lg ring-1 ring-black/10 transition-transform hover:scale-105 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      backdrop === b.id && "ring-2 ring-primary ring-offset-2 ring-offset-card",
                    )}
                    style={{ background: b.swatch }}
                    aria-label={b.label}
                  />
                ))}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2">
                {RATIOS.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setRatio(r.id)}
                    className={cn(
                      "rounded-lg border px-2 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      ratio === r.id
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
                    )}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{getRatio(ratio).hint}</p>

              <div className="mt-4 space-y-4">
                <SliderRow label="Product size" value={size} min={40} max={150} onChange={setSize} />
                <SliderRow label="Baseline height" value={height} min={55} max={88} onChange={setHeight} />
              </div>
            </Card>

            {/* shadows */}
            <Card className={cn("p-5", (stage !== "ready" || !shadowsOn) && "opacity-50 pointer-events-none")}>
              <div className="mb-3 flex items-center gap-2">
                <Wand2 className="size-4 text-primary" />
                <h2 className="font-display text-sm font-semibold tracking-wide uppercase">
                  4 · Shadow engine
                </h2>
              </div>
              <button
                onClick={() => setShadowsOn(!shadowsOn)}
                className="mb-4 flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span className="text-muted-foreground">Shadows</span>
                <span
                  className={cn(
                    "relative h-5 w-9 rounded-full transition-colors",
                    shadowsOn ? "bg-primary" : "bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 size-4 rounded-full bg-white shadow transition-all",
                      shadowsOn ? "left-[18px]" : "left-0.5",
                    )}
                  />
                </span>
              </button>
              <div className="grid grid-cols-2 gap-2">
                {SHADOW_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setShadow({ ...shadow, ...p.opts })}
                    className={cn(
                      "rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      activePreset?.id === p.id
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="mt-4 space-y-4">
                <SliderRow
                  label="Light angle"
                  value={shadow.direction}
                  min={0}
                  max={180}
                  suffix="°"
                  onChange={(v) => setShadow({ ...shadow, direction: v })}
                />
                <SliderRow
                  label="Cast length"
                  value={Math.round(shadow.length * 100)}
                  min={10}
                  max={140}
                  suffix="%"
                  onChange={(v) => setShadow({ ...shadow, length: v / 100 })}
                />
                <SliderRow
                  label="Softness"
                  value={Math.round(shadow.softness * 100)}
                  min={0}
                  max={100}
                  suffix="%"
                  onChange={(v) => setShadow({ ...shadow, softness: v / 100 })}
                />
                <SliderRow
                  label="Strength"
                  value={Math.round(shadow.opacity * 100)}
                  min={10}
                  max={80}
                  suffix="%"
                  onChange={(v) => setShadow({ ...shadow, opacity: v / 100 })}
                />
                <button
                  onClick={() => setShadow({ ...shadow, contact: !shadow.contact })}
                  className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <span className="text-muted-foreground">Contact shadow</span>
                  <span
                    className={cn(
                      "relative h-5 w-9 rounded-full transition-colors",
                      shadow.contact ? "bg-primary" : "bg-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 size-4 rounded-full bg-white shadow transition-all",
                        shadow.contact ? "left-[18px]" : "left-0.5",
                      )}
                    />
                  </span>
                </button>
              </div>
            </Card>

            {/* cutout tuning */}
            <Card className={cn("p-5", !sourceRef.current && "opacity-50 pointer-events-none")}>
              <h2 className="mb-3 font-display text-sm font-semibold tracking-wide uppercase">
                Cutout sensitivity
              </h2>
              <SliderRow
                label="Background tolerance"
                value={tolerance}
                min={8}
                max={60}
                onChange={(v) => setTolerance(v)}
                onCommit={(v) => {
                  const src = sourceRef.current;
                  if (src) {
                    setStage("processing");
                    setTimeout(() => runSegment(src.data.data, src.width, src.height, v), 30);
                  }
                }}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Raise it if backdrop bits survive; lower it if the product gets eaten.
              </p>
            </Card>

            {/* style analysis */}
            {stage === "ready" && analysis && (
              <Card className="p-5">
                <div className="mb-3 flex items-center gap-2">
                  <Sparkles className="size-4 text-primary" />
                  <h2 className="font-display text-sm font-semibold tracking-wide uppercase">
                    Style analysis
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  {analysis.palette.map((hex, i) => (
                    <span
                      key={hex + i}
                      title={hex}
                      className="size-7 rounded-lg ring-1 ring-black/10"
                      style={{ background: hex }}
                    />
                  ))}
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Category</dt>
                    <dd className="font-medium">{analysis.category}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Tone</dt>
                    <dd className="font-medium">{Math.round(analysis.tone * 100)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Contrast</dt>
                    <dd className="font-medium">{Math.round(analysis.contrast * 100)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Saturation</dt>
                    <dd className="font-medium">{Math.round(analysis.saturation * 100)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Finish</dt>
                    <dd className="font-medium">
                      {analysis.glossy > 0.3 ? "Glossy" : analysis.glossy > 0.12 ? "Semi-gloss" : "Matte"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Best style</dt>
                    <dd className="font-medium">{getStyle(recommended[0] ?? style).label}</dd>
                  </div>
                  <div className="col-span-2 mt-1 flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">Cutout confidence</dt>
                    <dd className="flex items-center gap-2 font-medium">
                      <span
                        className={cn(
                          "inline-block size-2 rounded-full",
                          confidence !== null && confidence >= 0.6
                            ? "bg-emerald-500"
                            : confidence !== null && confidence >= 0.35
                              ? "bg-amber-500"
                              : "bg-destructive",
                        )}
                      />
                      {confidence !== null ? Math.round(confidence * 100) + "%" : "—"}
                    </dd>
                  </div>
                </dl>
              </Card>
            )}
          </div>

          {/* -------------------------------------------------- preview */}
          <div className="flex flex-col gap-4">
            {stage === "empty" && (
              <EmptyState onBrowse={() => inputRef.current?.click()} onSample={loadSample} />
            )}
            {stage === "processing" && <ProcessingState />}
            {stage === "error" && (
              <Card className="flex flex-col items-center justify-center gap-3 rounded-2xl border-dashed p-16 text-center">
                <AlertTriangle className="size-8 text-destructive/70" />
                <p className="font-medium">We couldn’t isolate a product in that photo</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Try the “Cutout sensitivity” slider, or a photo where the product stands
                  apart from the background.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button variant="outline" size="sm" onClick={retrySegmentation}>
                    <RotateCcw className="size-4" />
                    Retry
                  </Button>
                  <Button size="sm" onClick={() => inputRef.current?.click()}>
                    <ImageUp className="size-4" />
                    Another photo
                  </Button>
                </div>
              </Card>
            )}
            {stage === "ready" && (
              <>
                {(edgeWarning || fitWarning) && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-[#F4B23E]/40 bg-[#F4B23E]/10 px-4 py-3 text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[#B47B16]" />
                    <span className="text-[#7a5a14]">
                      {edgeWarning &&
                        "The product touches the edge of the photo — the cutout may clip. Photos with space around the product work best."}
                      {fitWarning &&
                        "We couldn’t find a clear product — the whole photo was kept. Raise the cutout sensitivity."}
                    </span>
                  </div>
                )}
                <Card className="p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <Badge variant="secondary" className="gap-1.5 rounded-full">
                      <span className="size-1.5 rounded-full bg-primary" />
                      Before / after
                    </Badge>
                    <Button
                      size="sm"
                      onClick={() => canvasRef.current && exportBanner(canvasRef.current, "relight-banner")}
                    >
                      <Download className="size-4" />
                      Download PNG
                    </Button>
                  </div>
                  <div className="mx-auto max-w-[560px]">
                    <BeforeAfterSlider before={beforeUrl} after={afterUrl} />
                  </div>
                  <p className="mt-3 text-center text-xs text-muted-foreground">
                    Drag the handle · the after side re-renders live as you tune the shadow
                  </p>
                </Card>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {[
                    { k: "Cutout", v: "Edge-guided fill" },
                    { k: "Shadow", v: "AO + cast heave" },
                    { k: "Output", v: getRatio(ratio).w + " × " + getRatio(ratio).h },
                    { k: "Privacy", v: "On-device" },
                  ].map((s) => (
                    <div
                      key={s.k}
                      className="rounded-xl border border-border/60 bg-card px-4 py-3"
                    >
                      <div className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                        {s.k}
                      </div>
                      <div className="mt-0.5 text-sm font-medium">{s.v}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function SliderRow({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <span className="text-xs font-medium tabular-nums">
          {value}
          {suffix}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={1}
        onValueChange={(vals) => onChange(vals[0])}
        onValueCommit={onCommit ? (vals) => onCommit(vals[0]) : undefined}
      />
    </div>
  );
}

function EmptyState({ onBrowse, onSample }: { onBrowse: () => void; onSample: () => void }) {
  return (
    <Card className="flex flex-col items-center justify-center rounded-2xl border-dashed p-16 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10">
        <ImageUp className="size-7 text-primary" />
      </div>
      <h2 className="mt-5 font-display text-2xl font-semibold">Start with a messy photo</h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
        A mug on a cluttered desk, a jacket on a bed — anything a human could point at.
        Everything runs on your device; nothing is uploaded.
      </p>
      <div className="mt-6 flex gap-2">
        <Button onClick={onBrowse}>
          <ImageUp className="size-4" />
          Choose a photo
        </Button>
        <Button variant="outline" onClick={onSample}>
          <Sparkles className="size-4 text-primary" />
          Use sample
        </Button>
      </div>
    </Card>
  );
}

function ProcessingState() {
  return (
    <Card className="flex flex-col items-center justify-center rounded-2xl p-20 text-center">
      <div className="relative flex size-16 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-primary/15" />
        <span className="absolute inset-2 rounded-full bg-primary/10" />
        <Wand2 className="size-6 text-primary" />
      </div>
      <p className="mt-5 font-medium">Finding your product…</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Edge map → flood fill → cleanup → feathering
      </p>
    </Card>
  );
}

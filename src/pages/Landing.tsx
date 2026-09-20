import { Logo } from "@/components/Logo";
import { BeforeAfterSlider } from "@/components/BeforeAfterSlider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DEMO_PLACE, getDemoBefore, renderDemoAfter } from "@/lib/pipeline/demo";
import { DEFAULT_SHADOW } from "@/lib/pipeline/shadow";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  ArrowRight,
  ChevronRight,
  Clock,
  Crop,
  Github,
  Layers,
  SunMedium,
  Upload,
  Wand2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

const fadeUp = {
  initial: { opacity: 0, y: 18 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-60px" },
  transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] as const },
};

export default function Landing() {
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [demoState, setDemoState] = useState<"working" | "ready" | "error">("working");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // let the page paint first
        await new Promise((r) => setTimeout(r, 120));
        const b = getDemoBefore();
        if (!alive) return;
        setBefore(b);
        const a = await renderDemoAfter(DEMO_PLACE, {
          backdrop: "studio",
          shadow: DEFAULT_SHADOW,
        });
        if (!alive) return;
        setAfter(a);
        setDemoState("ready");
      } catch (err) {
        console.error("demo pipeline failed", err);
        setDemoState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Nav />
      <main>
        <Hero before={before} after={after} demoState={demoState} />
        <SocialProof />
        <HowItWorks />
        <PipelineDive />
        <Audience />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

// ---------------------------------------------------------------- Nav

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2 rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none">
          <Logo size={30} />
        </Link>
        <nav className="hidden items-center gap-7 text-sm text-muted-foreground md:flex">
          <a href="#how" className="transition-colors hover:text-foreground">How it works</a>
          <a href="#pipeline" className="transition-colors hover:text-foreground">Pipeline</a>
          <a href="#sellers" className="transition-colors hover:text-foreground">For sellers</a>
        </nav>
        <div className="flex items-center gap-2.5">
          <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
            <Link to="/studio">Open studio</Link>
          </Button>
          <Button size="sm" asChild>
            <Link to="/auth">
              Start free
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------- Hero

function Hero({
  before,
  after,
  demoState,
}: {
  before: string | null;
  after: string | null;
  demoState: "working" | "ready" | "error";
}) {
  return (
    <section className="relative overflow-hidden">
      {/* ambient light glows */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-32 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute top-40 right-[-120px] h-72 w-72 rounded-full bg-[#F4B23E]/10 blur-3xl" />
      </div>

      <div className="relative mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pt-16 pb-20 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:pt-24 lg:pb-28">
        <div>
          <motion.div {...fadeUp}>
            <Badge
              variant="outline"
              className="gap-2 rounded-full border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary"
            >
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              Live demo below — runs on your device
            </Badge>
          </motion.div>

          <motion.h1
            {...fadeUp}
            transition={{ ...fadeUp.transition, delay: 0.06 }}
            className="mt-5 font-display text-4xl leading-[1.06] font-bold tracking-tight sm:text-5xl lg:text-[3.6rem]"
          >
            Messy phone photo in.
            <br />
            <span className="text-gradient">Professional banner out.</span>
          </motion.h1>

          <motion.p
            {...fadeUp}
            transition={{ ...fadeUp.transition, delay: 0.12 }}
            className="mt-5 max-w-lg text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8"
          >
            Relight cuts your product out of any cluttered snapshot, drops it on a
            studio backdrop, and paints a{" "}
            <span className="font-medium text-foreground">realistic cast shadow</span>{" "}
            with our own rendering math — in seconds, right in your browser.
          </motion.p>

          <motion.div
            {...fadeUp}
            transition={{ ...fadeUp.transition, delay: 0.18 }}
            className="mt-8 flex flex-wrap items-center gap-3"
          >
            <Button size="lg" asChild className="h-11 px-6 text-[15px] shadow-lg shadow-primary/20">
              <Link to="/auth">
                Clean your first photo
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="h-11 px-6 text-[15px]">
              <Link to="/studio">
                <Upload className="size-4" />
                Try the studio
              </Link>
            </Button>
          </motion.div>

          <motion.div
            {...fadeUp}
            transition={{ ...fadeUp.transition, delay: 0.24 }}
            className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground"
          >
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-primary" />
              No studio, no subscriptions
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-primary" />
              Custom shadow engine
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-primary" />
              Built for Vinted &amp; Depop sellers
            </span>
          </motion.div>
        </div>

        {/* Live demo card */}
        <motion.div
          {...fadeUp}
          transition={{ ...fadeUp.transition, delay: 0.15 }}
          className="relative"
        >
          <div className="absolute -inset-3 rounded-[2rem] bg-gradient-to-br from-primary/12 via-transparent to-[#F4B23E]/12 blur-sm" aria-hidden />
          <div className="relative rounded-2xl border border-border/70 bg-card p-3 shadow-xl shadow-foreground/[0.06]">
            <div className="mb-2.5 flex items-center justify-between px-1.5 pt-1">
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full bg-[#F4B23E]/80" />
                <span className="size-2.5 rounded-full bg-border" />
                <span className="size-2.5 rounded-full bg-border" />
                <span className="ml-2 text-xs font-medium text-muted-foreground">
                  relight.studio — live pipeline
                </span>
              </div>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider",
                  demoState === "ready" && "bg-primary/10 text-primary",
                  demoState === "working" && "bg-muted text-muted-foreground",
                  demoState === "error" && "bg-destructive/10 text-destructive",
                )}
              >
                {demoState === "ready" && "● RENDERED"}
                {demoState === "working" && "◌ RENDERING…"}
                {demoState === "error" && "● PREVIEW UNAVAILABLE"}
              </span>
            </div>
            <div className="relative">
              <BeforeAfterSlider before={before} after={after} className="shadow-inner" />
              {demoState === "working" && (
                <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-card/70 backdrop-blur-[2px]">
                  <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    Cutting, lighting, shadowing…
                  </span>
                </div>
              )}
              {demoState === "error" && (
                <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-muted/60 text-center text-sm text-muted-foreground">
                  Demo preview unavailable on this device.
                </div>
              )}
            </div>
            <p className="mt-2.5 px-1.5 pb-1 text-center text-xs text-muted-foreground">
              Drag the handle — the “after” side was rendered by the exact pipeline you’ll
              use in the studio.
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Social proof

function SocialProof() {
  const stats = [
    { value: "≈2s", label: "photo → listing-ready banner" },
    { value: "0", label: "external AI APIs — all math runs on-device" },
    { value: "4:5", label: "Vinted & Depop native ratio" },
  ];
  return (
    <section className="border-y border-border/60 bg-secondary/40">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 px-4 py-10 sm:grid-cols-3 sm:px-6">
        {stats.map((s) => (
          <motion.div key={s.label} {...fadeUp} className="text-center">
            <div className="font-display text-3xl font-semibold tracking-tight text-foreground">
              {s.value}
            </div>
            <div className="mt-1 text-sm text-muted-foreground">{s.label}</div>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- How it works

function HowItWorks() {
  const steps = [
    {
      icon: Upload,
      title: "Drop a messy photo",
      body: "Mug on a cluttered desk, sneaker on the floor — if a human can find the product, Relight can too.",
    },
    {
      icon: Crop,
      title: "We cut it out",
      body: "Our edge-guided segmentation finds the product silhouette and lifts it free, feathers and all.",
    },
    {
      icon: Layers,
      title: "Pick a backdrop",
      body: "Six studio surfaces from bright loft to charcoal. Your product is framed for 4:5, 1:1 or 16:9.",
    },
    {
      icon: SunMedium,
      title: "We paint the light",
      body: "A custom shadow engine places a contact ring and a directional cast that grounds your product like real light.",
    },
  ];
  return (
    <section id="how" className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
      <motion.div {...fadeUp} className="max-w-xl">
        <span className="text-xs font-semibold tracking-widest text-primary uppercase">
          How it works
        </span>
        <h2 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Two seconds, four steps
        </h2>
        <p className="mt-3 text-muted-foreground">
          No timelines, no layers panel, no Photoshop. Upload, tweak, download.
        </p>
      </motion.div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s, i) => (
          <motion.div
            key={s.title}
            {...fadeUp}
            transition={{ ...fadeUp.transition, delay: i * 0.07 }}
          >
            <Card>
              <div className="flex items-center justify-between">
                <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <s.icon className="size-5" />
                </div>
                <span className="font-display text-sm font-semibold text-muted-foreground/50">
                  0{i + 1}
                </span>
              </div>
              <h3 className="mt-4 font-display text-lg font-semibold">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{s.body}</p>
            </Card>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Pipeline deep dive

function PipelineDive() {
  const items = [
    {
      icon: Crop,
      title: "Edge-guided cutout",
      body: "A Sobel edge map steers an adaptive flood fill from every border, then morphological cleanup + hole filling isolates the product. Feathering comes from a distance transform — soft where it should be.",
    },
    {
      icon: SunMedium,
      title: "Physically-motivated shadows",
      body: "Contact shadows come from silhouette ambient occlusion; cast shadows are the silhouette heaved along the light vector with height jitter and progressive blur. Tuned live with three sliders.",
    },
    {
      icon: Layers,
      title: "Studio compositing",
      body: "Gradient backdrops with top-light falloff, grounding bands and ratio-aware framing. Export at full resolution — 1080×1350 for listings, 1280×720 for shop banners.",
    },
  ];
  return (
    <section id="pipeline" className="border-y border-border/60 bg-secondary/40">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <div className="grid items-start gap-12 lg:grid-cols-[0.9fr_1.1fr]">
          <motion.div {...fadeUp} className="lg:sticky lg:top-28">
            <span className="text-xs font-semibold tracking-widest text-primary uppercase">
              Under the hood
            </span>
            <h2 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Not a wrapped API.
              <br />
              Engine math, on-device.
            </h2>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              Most tools in this space call a cloud model and hope for the best. Relight’s
              segmentation, shadow rendering and compositing are written from scratch in
              TypeScript and run entirely in your browser — your photos never leave your
              device.
            </p>
            <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="size-4 text-primary" />
              Full cutout + shadow render: about two seconds on a laptop.
            </div>
          </motion.div>

          <div className="flex flex-col gap-4">
            {items.map((it, i) => (
              <motion.div
                key={it.title}
                {...fadeUp}
                transition={{ ...fadeUp.transition, delay: i * 0.07 }}
              >
                <Card>
                  <div className="flex gap-4">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <it.icon className="size-5" />
                    </div>
                    <div>
                      <h3 className="font-display text-lg font-semibold">{it.title}</h3>
                      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{it.body}</p>
                    </div>
                  </div>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Audience

function Audience() {
  return (
    <section id="sellers" className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <motion.div {...fadeUp} className="order-2 lg:order-1">
          <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-lg shadow-foreground/[0.04]">
            <div className="rounded-xl bg-gradient-to-b from-[#f6efe4] to-[#e7d7c2] p-6">
              <div className="relative">
                <div className="flex aspect-[4/5] items-center justify-center">
                  <div className="text-center">
                    <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-white/70 shadow-md">
                      <Wand2 className="size-7 text-primary" />
                    </div>
                    <p className="mt-4 max-w-xs text-sm leading-6 text-[#6b5a44]">
                      One mug. One backdrop. One believable shadow.
                      <br />
                      That’s the whole listing photo.
                    </p>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <span className="size-3 rounded-full bg-[#f6efe4] ring-1 ring-black/10" />
                <span className="size-3 rounded-full bg-[#e8f2ee] ring-1 ring-black/10" />
                <span className="size-3 rounded-full bg-[#f7edeb] ring-1 ring-black/10" />
                <span className="size-3 rounded-full bg-[#eaf0f6] ring-1 ring-black/10" />
                <span className="size-3 rounded-full bg-[#33373b] ring-1 ring-black/10" />
              </div>
              <span className="text-xs text-muted-foreground">5 backdrops · 3 ratios</span>
            </div>
          </div>
        </motion.div>

        <motion.div {...fadeUp} className="order-1 lg:order-2">
          <span className="text-xs font-semibold tracking-widest text-primary uppercase">
            Built for resellers
          </span>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Your thrift find deserves a studio
          </h2>
          <p className="mt-4 text-base leading-7 text-muted-foreground">
            Vinted and Depop listings live or die on the first photo. Big-market tools
            pitch enterprises — Relight is built for the seller shooting on a bedroom
            desk at 11pm.
          </p>
          <ul className="mt-6 space-y-3.5">
            {[
              "Listings with clean photos sell faster — and shadow depth is what reads as “real”",
              "Every export is sized for the platform: 4:5 for feeds, 1:1 for squares, 16:9 for shops",
              "Nothing to install, nothing to learn — if you can upload a photo, you’re done",
            ].map((line) => (
              <li key={line} className="flex gap-3 text-sm leading-6">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-primary">
                    <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="text-foreground/90">{line}</span>
              </li>
            ))}
          </ul>
          <Link
            to="/studio"
            className="mt-7 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            See it on your own photo
            <ChevronRight className="size-4" />
          </Link>
        </motion.div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Final CTA

function FinalCta() {
  return (
    <section className="px-4 pb-24 sm:px-6">
      <motion.div {...fadeUp}>
        <div className="grain relative mx-auto max-w-6xl overflow-hidden rounded-3xl bg-[#0F1719] px-6 py-16 text-center text-white sm:px-12 lg:py-20">
          <div
            aria-hidden
            className="absolute -top-24 left-1/2 h-64 w-[560px] -translate-x-1/2 rounded-full bg-primary/25 blur-3xl"
          />
          <h2 className="relative font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Your next listing is one upload away
          </h2>
          <p className="relative mx-auto mt-4 max-w-md text-white/70">
            Free during launch. No card, no install — just a messier photo than the one
            you’ll walk away with.
          </p>
          <div className="relative mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" asChild className="h-11 bg-white px-6 text-[15px] text-[#0F1719] hover:bg-white/90">
              <Link to="/auth">
                Start free
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              asChild
              className="h-11 border-white/25 bg-transparent px-6 text-[15px] text-white hover:bg-white/10 hover:text-white"
            >
              <Link to="/studio">Open the studio</Link>
            </Button>
          </div>
        </div>
      </motion.div>
    </section>
  );
}

// ---------------------------------------------------------------- Footer

function Footer() {
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-4 py-10 text-sm text-muted-foreground sm:flex-row sm:px-6">
        <div className="flex items-center gap-2">
          <Logo size={22} />
          <span className="text-xs">© {new Date().getFullYear()} Relight — hackathon build</span>
        </div>
        <div className="flex items-center gap-5">
          <a href="#how" className="transition-colors hover:text-foreground">How it works</a>
          <a href="#pipeline" className="transition-colors hover:text-foreground">Pipeline</a>
          <span className="inline-flex items-center gap-1.5">
            <Github className="size-3.5" />
            v1.0
          </span>
        </div>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------- Card

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "card-lift rounded-2xl border border-border/70 bg-card p-6 shadow-sm shadow-foreground/[0.03]",
        className,
      )}
    >
      {children}
    </div>
  );
}

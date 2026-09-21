import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  Crop,
  ImageUp,
  Layers,
  LogOut,
  Sparkles,
  SunMedium,
} from "lucide-react";
import { Link } from "react-router";

export default function Dashboard() {
  const steps = [
    {
      icon: Crop,
      title: "Cutout",
      body: "Edge-guided segmentation lifts your product out of any cluttered photo — feathered edges included.",
    },
    {
      icon: Layers,
      title: "Style",
      body: "Five output styles — pure white, white + shadow, premium desk and more — auto-recommended from your photo.",
    },
    {
      icon: SunMedium,
      title: "Shadow",
      body: "Our custom engine paints a contact ring plus a directional cast. Tune it with a few sliders.",
    },
  ];

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <Link to="/" aria-label="Relight home" className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <Logo size={34} withWordmark={false} />
            </Link>
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Your Relight workspace
              </p>
              <h1 className="mt-1 text-3xl font-bold tracking-tight">
                Turn finds into sales
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2 self-start">
            <ThemeToggle />
            <Button asChild className="gap-2">
              <Link to="/studio">
                <ImageUp className="size-4" />
                Open the Studio
              </Link>
            </Button>
          </div>
        </header>

        <Card className="overflow-hidden border-border/70 p-0">
          <div className="relative grain bg-[#0F1719] px-8 py-12 text-white">
            <div
              aria-hidden
              className="absolute -top-20 right-0 h-56 w-96 rounded-full bg-primary/25 blur-3xl"
            />
            <div className="relative max-w-xl">
              <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
                Messy photo in, listing-ready banner out
              </h2>
              <p className="mt-2 text-sm leading-6 text-white/70">
                Upload a snapshot, pick one of five output styles, and Relight hands
                you back a clean banner with a believable shadow — in about two
                seconds, entirely on your device.
              </p>
              <Button
                size="lg"
                asChild
                className="mt-6 h-11 bg-white px-6 text-[15px] text-[#0F1719] hover:bg-white/90"
              >
                <Link to="/studio">
                  <ImageUp className="size-4" />
                  Open the Studio
                </Link>
              </Button>
            </div>
          </div>
        </Card>

        <div className="grid gap-4 sm:grid-cols-3">
          {steps.map((s) => (
            <Card key={s.title} className="card-lift border-border/70">
              <CardHeader>
                <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <s.icon className="size-5" />
                </div>
                <CardTitle className="font-display text-lg">{s.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm leading-6 text-muted-foreground">
                {s.body}
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="border-border/70">
          <div className="flex items-start gap-3">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
            <p className="text-sm leading-6 text-muted-foreground">
              <span className="font-medium text-foreground">Pro tip:</span> shoot your
              product with a little space around it and from a slight angle — the
              shadow engine uses the silhouette’s shape, so cleaner edges mean more
              believable light.
            </p>
          </div>
        </Card>
      </div>
    </main>
  );
}

import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Draggable before/after comparison slider with clip-path reveal. */
export function BeforeAfterSlider({
  before,
  after,
  className,
  initialPercent = 50,
  labels = true,
}: {
  before: string | null;
  after: string | null;
  className?: string;
  initialPercent?: number;
  labels?: boolean;
}) {
  const [pos, setPos] = useState(initialPercent);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const move = useCallback((clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setPos(Math.max(0, Math.min(100, pct)));
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    move(e.clientX);
  };

  return (
    <div
      ref={ref}
      className={cn(
        "relative touch-none overflow-hidden rounded-xl border border-border/70 bg-muted/40 select-none",
        dragging ? "cursor-grabbing" : "cursor-grab",
        className,
      )}
      onPointerDown={(e) => {
        e.preventDefault();
        onPointerDown(e);
      }}
      onPointerMove={(e) => {
        if (dragging) move(e.clientX);
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
    >
      {/* After (full) */}
      {after ? (
        <img
          src={after}
          alt="After — clean banner"
          className="block w-full h-auto"
          draggable={false}
        />
      ) : (
        <div className="aspect-[4/5] w-full" />
      )}

      {/* Before (clipped) */}
      {before && (
        <div
          className="absolute inset-0"
          style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
        >
          <img
            src={before}
            alt="Before — messy photo"
            className="absolute inset-0 h-full w-full object-cover"
            draggable={false}
          />
        </div>
      )}

      {/* Handle */}
      <div
        className="absolute inset-y-0 z-10"
        style={{ left: `calc(${pos}% - 1px)` }}
      >
        <div className="h-full w-0.5 bg-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.25)]" />
        <div
          className="absolute top-1/2 left-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-lg ring-1 ring-black/10"
          aria-hidden="true"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="text-foreground">
            <path d="M8 7 3 12l5 5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M16 7l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>

      {/* Labels */}
      {labels && (
        <>
          <span className="absolute left-3 top-3 z-10 rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium tracking-wide text-white backdrop-blur-sm">
            BEFORE
          </span>
          <span className="absolute right-3 top-3 z-10 rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium tracking-wide text-white backdrop-blur-sm">
            AFTER
          </span>
        </>
      )}
    </div>
  );
}

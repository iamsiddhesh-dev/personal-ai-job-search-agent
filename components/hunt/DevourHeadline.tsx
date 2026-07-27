"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { LEAP } from "./TigerFigure";

interface Glyph {
  char: string;
  line: 0 | 1;
}

const LINE_1 = "Let's start";
const LINE_2 = "hunt";

function toGlyphs(text: string, line: 0 | 1): Glyph[] {
  return [...text].map((char) => ({ char, line }));
}

const GLYPHS: Glyph[] = [...toGlyphs(LINE_1, 0), ...toGlyphs(LINE_2, 1)];

interface DevourHeadlineProps {
  igniting: boolean;
  hovered: boolean;
  impactPoint: { x: number; y: number } | null;
  scale: "sm" | "md" | "lg";
  onClick: () => void;
  onHoverChange: (hovered: boolean) => void;
}

// Type scale per composition. Mobile gets its own size rather than a clamp of
// the desktop value, so the lower-third band is balanced on a narrow portrait
// viewport.
const TYPE = {
  sm: { lead: "text-[clamp(1.15rem,5vw,1.5rem)]", main: "text-[clamp(3.6rem,19vw,5.4rem)]" },
  md: { lead: "text-[clamp(1.3rem,2.6vw,1.8rem)]", main: "text-[clamp(4rem,10vw,6.4rem)]" },
  lg: { lead: "text-[clamp(1.4rem,3vw,2.1rem)]", main: "text-[clamp(4.5rem,11vw,9rem)]" },
} as const;

export default function DevourHeadline({
  igniting,
  hovered,
  impactPoint,
  scale,
  onClick,
  onHoverChange,
}: DevourHeadlineProps) {
  const type = TYPE[scale];
  const glyphRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [targets, setTargets] = useState<Array<{ dx: number; dy: number; delay: number } | null>>(
    () => GLYPHS.map(() => null),
  );

  useLayoutEffect(() => {
    if (!igniting || !impactPoint) return;
    const rects = glyphRefs.current.map((el) => el?.getBoundingClientRect() ?? null);
    // Rightmost glyphs sit closest to the tiger — they get pulled in first.
    const order = rects
      .map((r, i) => ({ i, x: r ? r.left + r.width / 2 : -Infinity }))
      .sort((a, b) => b.x - a.x)
      .map((r) => r.i);
    const delayForIndex = new Map(order.map((i, rank) => [i, rank * 0.018]));

    setTargets(
      rects.map((r, i) => {
        if (!r) return null;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        return {
          dx: impactPoint.x - cx,
          dy: impactPoint.y - cy,
          // Fire on the impact beat, not during flight: the letters must go
          // when the tiger arrives, otherwise the text vanishes before
          // anything has reached it.
          delay: LEAP.impact - 0.04 + (delayForIndex.get(i) ?? 0),
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [igniting]);

  function renderLine(line: 0 | 1, className: string) {
    return (
      <span className={className}>
        {GLYPHS.map((g, i) => {
          if (g.line !== line) return null;
          const t = targets[i];
          return (
            <motion.span
              key={i}
              ref={(el) => {
                glyphRefs.current[i] = el;
              }}
              className="inline-block"
              style={{ whiteSpace: g.char === " " ? "pre" : "normal" }}
              animate={
                igniting && t
                  ? { x: t.dx, y: t.dy, scale: 0, rotate: t.dx > 0 ? 35 : -35, opacity: 0 }
                  : { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1 }
              }
              transition={
                igniting && t
                  ? { delay: t.delay, duration: 0.26, ease: "easeIn" }
                  : { duration: 0 }
              }
            >
              {g.char === " " ? " " : g.char}
            </motion.span>
          );
        })}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      disabled={igniting}
      className="group relative block w-fit text-left focus:outline-none"
      aria-label="Let's start hunt — begin"
    >
      <span className="relative block overflow-visible">
        <span className={`block font-hunt font-medium text-bone ${type.lead}`}>
          {renderLine(0, "")}
        </span>
        <span
          className={`-mt-1 block font-hunt font-extrabold leading-[0.95] tracking-tight text-bone ${type.main}`}
        >
          {renderLine(1, "")}
        </span>

        {/* Claw rake — three curved, tapered scratches dragged across the
            word on hover. Deliberately not straight lines: a ruled stroke
            reads as strikethrough (i.e. "cancelled"), a bowed one reads as
            a claw. */}
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 400 160"
          preserveAspectRatio="none"
          fill="none"
        >
          {[
            { d: "M 96 26 C 170 44, 250 74, 322 118", w: 1.4, o: 0.55 },
            { d: "M 74 44 C 152 62, 236 94, 310 140", w: 2.6, o: 0.9 },
            { d: "M 52 66 C 128 84, 210 114, 284 156", w: 1.1, o: 0.45 },
          ].map((slash, i) => (
            <motion.path
              key={i}
              d={slash.d}
              stroke="var(--color-seal)"
              strokeWidth={slash.w}
              strokeLinecap="round"
              pathLength={1}
              initial={{ pathLength: 0, opacity: 0 }}
              animate={
                igniting
                  ? { pathLength: 0, opacity: 0 }
                  : hovered
                    ? { pathLength: 1, opacity: slash.o }
                    : { pathLength: 0, opacity: 0 }
              }
              transition={{ duration: 0.22, delay: hovered ? i * 0.04 : 0, ease: "easeOut" }}
            />
          ))}
        </svg>
      </span>

      {/* Torn-edge wipe: a jagged panel sweeps in from the right, "biting"
          through whatever text hasn't already been yanked away. */}
      <motion.div
        className="pointer-events-none absolute -inset-x-4 -inset-y-2 bg-ink"
        style={{
          clipPath:
            "polygon(100% 0%, 100% 100%, 8% 100%, 14% 88%, 6% 78%, 16% 66%, 4% 54%, 18% 42%, 5% 30%, 15% 18%, 7% 8%, 0% 0%)",
          transformOrigin: "right center",
        }}
        animate={{ scaleX: igniting ? 1 : 0 }}
        transition={{ delay: LEAP.impact - 0.04, duration: 0.4, ease: "easeIn" }}
      />
    </button>
  );
}

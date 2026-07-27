"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { hash } from "@/lib/anim/hash";
import type { GrassLayerConfig } from "./heroConfig";
import type { Plane } from "./useParallax";

interface HeroGrassProps {
  layer: GrassLayerConfig;
  plane: Plane;
  /** Distinguishes hash streams so layers don't sit on identical blades. */
  seed: number;
}

// One depth layer of the grass band along the bottom of the hero. Rendered
// twice by HeroStage (back layer behind the tiger, front layer above it),
// which is what gives the lower third real depth instead of a flat strip.
export default function HeroGrass({ layer, plane, seed }: HeroGrassProps) {
  const reduced = useReducedMotion();
  const hostRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  // The field is generated in real pixels and the viewBox matches 1:1.
  // A fixed viewBox with preserveAspectRatio="none" squashes x by the
  // container's aspect ratio, which turns tapered blades into hairline sticks
  // on narrow viewports — the exact failure this avoids.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const blades = useMemo(() => {
    if (!box || box.w === 0) return [];
    const { w, h } = box;

    // Scale count with width so a wide desktop isn't sparser than a phone.
    const count = Math.round(layer.count * Math.max(0.65, Math.min(2.2, w / 420)));

    return Array.from({ length: count }, (_, i) => {
      const s = seed * 7919 + i * 13;
      const h1 = hash(s + 1);
      const h2 = hash(s + 2);
      const h3 = hash(s + 3);
      const h4 = hash(s + 4);
      const h5 = hash(s + 5);

      // Jittered rather than evenly spaced — even spacing reads as a comb.
      // Overshoot the edges so blades don't stop short of the corners.
      const x = -20 + ((i + h1 * 0.95) / count) * (w + 40);
      // Squared distribution: many short blades, a few tall ones.
      const height = h * (0.4 + h2 * h2 * 0.95);
      const lean = (h3 - 0.5) * height * 0.5;
      const halfBase = 2.2 + h4 * 4.4;

      const tipX = x + lean;
      const tipY = h - height;
      const cX = x + lean * 0.22;
      const cY = h - height * 0.55;
      const f = (n: number) => n.toFixed(1);

      return {
        id: i,
        d: [
          `M ${f(x - halfBase)} ${h}`,
          `Q ${f(cX - halfBase * 0.55)} ${f(cY)} ${f(tipX)} ${f(tipY)}`,
          `Q ${f(cX + halfBase * 0.55)} ${f(cY)} ${f(x + halfBase)} ${h}`,
          "Z",
        ].join(" "),
        veinD: `M ${f(x)} ${h} Q ${f(cX)} ${f(cY)} ${f(tipX)} ${f(tipY)}`,
        opacity: 0.45 + h5 * 0.55,
        originX: x,
        // Taller blades sway further — the detail that makes wind look like
        // wind rather than a uniform wobble.
        swayDeg: (1.4 + h3 * 2.8) * (0.5 + height / h),
        duration: 3.4 + h2 * 2.8,
        delay: -h1 * 7,
      };
    });
  }, [box, layer.count, seed]);

  return (
    <div
      ref={hostRef}
      className="pointer-events-none absolute inset-x-0 bottom-0"
      style={{ height: `${layer.heightVh}vh` }}
      aria-hidden
    >
      {box && (
        <motion.svg
          className="h-full w-full"
          viewBox={`0 0 ${box.w} ${box.h}`}
          fill="none"
          style={{ x: plane.x, y: plane.y, overflow: "visible", willChange: "transform" }}
        >
          <g
            style={
              !reduced
                ? {
                    animation: "hunt-wind 9s ease-in-out infinite",
                    transformOrigin: `${box.w / 2}px ${box.h}px`,
                  }
                : undefined
            }
          >
            {blades.map((b) => (
              <g
                key={b.id}
                style={
                  !reduced
                    ? ({
                        "--sway-deg": b.swayDeg,
                        animation: `hunt-blade-sway ${b.duration}s ease-in-out ${b.delay}s infinite`,
                        transformOrigin: `${b.originX}px ${box.h}px`,
                      } as React.CSSProperties)
                    : undefined
                }
              >
                <path d={b.d} fill="var(--color-bone)" opacity={b.opacity * layer.opacity} />
                <path
                  d={b.veinD}
                  stroke="var(--color-ink)"
                  strokeWidth={layer.strokeWidth * 0.3}
                  opacity={0.4 * layer.opacity}
                />
              </g>
            ))}
          </g>
        </motion.svg>
      )}
    </div>
  );
}

"use client";

import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { hash } from "@/lib/anim/hash";
import type { PetalConfig } from "./heroConfig";
import type { Plane } from "./useParallax";

// The same notched-tip petal the chat border's blossoms are built from, so
// the drifting petals read as having come off those flowers.
const PETAL_D =
  "M 0 0 C -5.2 -3.6, -7.6 -10.4, -3.6 -14.6 L 0 -12.4 L 3.6 -14.6 C 7.6 -10.4, 5.2 -3.6, 0 0 Z";

interface PetalFieldProps {
  config: PetalConfig;
  plane: Plane;
}

// Continuously drifting blossom petals across the whole hero. Distinct from
// PetalBurst, which is the leap's one-shot impact spray.
//
// Motion is pure CSS keyframes with per-petal custom properties: the page
// already runs a WebGL context on `/`, so a per-frame JS loop for particles
// would be the wrong trade. Deterministic hashing keeps SSR and client render
// identical.
export default function PetalField({ config, plane }: PetalFieldProps) {
  const reduced = useReducedMotion();

  const petals = useMemo(
    () =>
      Array.from({ length: config.count }, (_, i) => {
        const h1 = hash(i * 9 + 1);
        const h2 = hash(i * 9 + 2);
        const h3 = hash(i * 9 + 3);
        const h4 = hash(i * 9 + 4);
        const h5 = hash(i * 9 + 5);
        const h6 = hash(i * 9 + 6);

        const size = config.size[0] + h1 * (config.size[1] - config.size[0]);
        const duration = config.duration[0] + h2 * (config.duration[1] - config.duration[0]);

        return {
          id: i,
          // Percent of the measured container, so spawning always spans the
          // full viewport width whatever the aspect ratio.
          left: h3 * 100,
          size,
          duration,
          // Negative delay: every petal starts mid-flight, so the field is
          // already populated on load rather than raining in from empty.
          delay: -h4 * duration,
          drift: (h5 - 0.5) * 2 * config.drift,
          spin: (h6 - 0.5) * 900,
          opacity: 0.16 + h1 * 0.4,
          sway: 2.5 + h5 * 4,
        };
      }),
    [config],
  );

  if (reduced) return null;

  return (
    <motion.div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ x: plane.x, y: plane.y, willChange: "transform" }}
      aria-hidden
    >
      {petals.map((p) => (
        <div
          key={p.id}
          className="absolute top-0"
          style={
            {
              left: `${p.left}%`,
              "--petal-drift": `${p.drift}px`,
              "--petal-spin": `${p.spin}deg`,
              animation: `hunt-petal-fall ${p.duration}s linear ${p.delay}s infinite`,
              willChange: "transform",
            } as React.CSSProperties
          }
        >
          <svg
            width={p.size}
            height={p.size}
            viewBox="-9 -16 18 18"
            style={{ opacity: p.opacity, display: "block" }}
          >
            <path d={PETAL_D} fill="var(--color-bone)" />
          </svg>
        </div>
      ))}
    </motion.div>
  );
}

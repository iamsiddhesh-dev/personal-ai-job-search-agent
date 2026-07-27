"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { generateRippleField } from "./environment";
import type { Plane } from "./useParallax";

// The SVG is a fixed, generously oversized square centred on the ripple
// origin, so rings can run well past the viewport corners without relying on
// `overflow: visible` on an SVG root (which browsers clip inconsistently).
const FIELD = 3600;
const HALF = FIELD / 2;

interface InkEnvironmentProps {
  /** Ripple origin in viewport px — the tiger's raised paw. */
  origin: { x: number; y: number } | null;
  /** Landing point of the leap; fires the impact pulse. */
  impactPoint: { x: number; y: number } | null;
  igniting: boolean;
  reduced: boolean;
  rippleCount: number;
  /** Deepest parallax plane. */
  plane: Plane;
  mistPlane: Plane;
}

// Page-wide woodcut environment: the water surface the tiger stands in, plus
// the engraved hatch of the printing plate itself. Everything here is texture
// — it never captures pointer events and never affects layout.
export default function InkEnvironment({
  origin,
  impactPoint,
  igniting,
  reduced,
  rippleCount,
  plane,
  mistPlane,
}: InkEnvironmentProps) {
  const rings = useMemo(
    () => generateRippleField(reduced ? Math.min(12, rippleCount) : rippleCount),
    [reduced, rippleCount],
  );

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Mist band: the atmospheric far plane. This is the "sky" layer of the
          parallax stack, reinterpreted in ink rather than drawn as scenery. */}
      <motion.div
        className="absolute inset-x-[-8%] top-[8%] h-[46%]"
        style={{
          x: mistPlane.x,
          y: mistPlane.y,
          background:
            "radial-gradient(ellipse 60% 100% at 50% 50%, rgba(237,234,227,0.055) 0%, rgba(237,234,227,0.02) 45%, rgba(237,234,227,0) 78%)",
          animation: reduced ? undefined : "hunt-mist-drift 26s ease-in-out infinite",
          willChange: "transform",
        }}
      />

      {/* Engraving hatch + plate grain, across the entire page. One <pattern>
          tile rather than thousands of line nodes. */}
      <motion.svg
        className="absolute inset-[-6%] h-[112%] w-[112%]"
        style={{ x: plane.x, y: plane.y, willChange: "transform" }}
      >
        <defs>
          <pattern
            id="hunt-hatch"
            width={7}
            height={7}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(-38)"
          >
            <line
              x1={0}
              y1={0}
              x2={0}
              y2={7}
              stroke="var(--color-bone)"
              strokeWidth={0.6}
            />
          </pattern>
          <filter id="hunt-grain">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.9"
              numOctaves={2}
              stitchTiles="stitch"
            />
          </filter>
        </defs>
        <rect width="100%" height="100%" fill="url(#hunt-hatch)" opacity={0.028} />
        <rect width="100%" height="100%" filter="url(#hunt-grain)" opacity={0.05} />
      </motion.svg>

      {origin && (
        <motion.svg
          className="absolute"
          style={{
            left: origin.x,
            top: origin.y,
            width: FIELD,
            height: FIELD,
            x: plane.x,
            y: plane.y,
            translateX: "-50%",
            translateY: "-50%",
            willChange: "transform",
          }}
          viewBox={`${-HALF} ${-HALF} ${FIELD} ${FIELD}`}
          fill="none"
        >
          {rings.map((r) => (
            <ellipse
              key={r.id}
              cx={0}
              cy={0}
              rx={r.rx}
              ry={r.ry}
              stroke="var(--color-bone)"
              strokeWidth={r.strokeWidth}
              strokeDasharray={r.dashArray}
              strokeDashoffset={r.dashOffset}
              opacity={r.opacity}
              style={
                !reduced
                  ? {
                      animation: `hunt-ripple-breathe ${r.animationDuration}s ease-in-out ${r.animationDelay}s infinite`,
                      transformOrigin: "0px 0px",
                    }
                  : undefined
              }
            />
          ))}
        </motion.svg>
      )}

      {/* Impact pulse: one ring thrown outward from where the tiger lands, so
          the water visibly reacts to the leap instead of ignoring it. */}
      {impactPoint && !reduced && (
        <svg
          className="absolute"
          style={{
            left: impactPoint.x,
            top: impactPoint.y,
            width: FIELD,
            height: FIELD,
            transform: "translate(-50%, -50%)",
          }}
          viewBox={`${-HALF} ${-HALF} ${FIELD} ${FIELD}`}
          fill="none"
        >
          <motion.ellipse
            cx={0}
            cy={0}
            rx={60}
            ry={60 * 0.42}
            stroke="var(--color-bone)"
            strokeWidth={2.4}
            style={{ transformOrigin: "0px 0px" }}
            initial={{ scale: 0, opacity: 0 }}
            animate={igniting ? { scale: [0, 9], opacity: [0, 0.75, 0] } : { scale: 0, opacity: 0 }}
            transition={{ delay: 0.54, duration: 0.85, ease: "easeOut" }}
          />
          <motion.ellipse
            cx={0}
            cy={0}
            rx={60}
            ry={60 * 0.42}
            stroke="var(--color-bone)"
            strokeWidth={1.4}
            style={{ transformOrigin: "0px 0px" }}
            initial={{ scale: 0, opacity: 0 }}
            animate={igniting ? { scale: [0, 6.5], opacity: [0, 0.5, 0] } : { scale: 0, opacity: 0 }}
            transition={{ delay: 0.62, duration: 0.8, ease: "easeOut" }}
          />
        </svg>
      )}
    </div>
  );
}

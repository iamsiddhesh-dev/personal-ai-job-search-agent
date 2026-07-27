"use client";

import { useEffect, useState, type RefObject } from "react";
import { generateGrassField, type GrassField } from "./grass";

const BLEED = 40;
const RADIUS = 28;

interface GrassFrameProps {
  panelRef: RefObject<HTMLElement | null>;
  reduced: boolean;
}

// A living border of hand-drawn grass and plum blossoms, planted along the
// chat panel's own rounded-rect perimeter (the same math the liquid-metal
// blob uses to sweep its border). Motion is pure CSS keyframes, not rAF —
// the blob demo already runs a WebGL context on this origin, so a second
// per-frame animation loop here would be wasteful.
export default function GrassFrame({ panelRef, reduced }: GrassFrameProps) {
  const [field, setField] = useState<GrassField | null>(null);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;

    function measure() {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setField(
        generateGrassField(rect.width / 2, rect.height / 2, RADIUS, BLEED, reduced ? 34 : 90),
      );
    }

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [panelRef, reduced]);

  if (!field) return null;
  const { blades, blossoms, viewBoxSize } = field;
  const cx = viewBoxSize.width / 2;
  const cy = viewBoxSize.height / 2;

  return (
    <svg
      className="pointer-events-none absolute"
      style={{
        left: -BLEED,
        top: -BLEED,
        width: `calc(100% + ${BLEED * 2}px)`,
        height: `calc(100% + ${BLEED * 2}px)`,
      }}
      viewBox={`0 0 ${viewBoxSize.width} ${viewBoxSize.height}`}
      fill="none"
    >
      <g
        style={!reduced ? { animation: "hunt-gust 6s ease-in-out infinite", transformOrigin: `${cx}px ${cy}px` } : undefined}
      >
        <g transform={`translate(${cx} ${cy})`}>
          {blades.map((b) => (
            <path
              key={b.id}
              d={b.d}
              fill="var(--color-bone)"
              opacity={b.opacity}
              style={
                !reduced
                  ? ({
                      "--sway-deg": b.swayDeg,
                      animation: `hunt-blade-sway ${b.animationDuration}s ease-in-out ${b.animationDelay}s infinite`,
                      transformOrigin: `${b.originX}px ${b.originY}px`,
                    } as React.CSSProperties)
                  : undefined
              }
            />
          ))}

          {/* Positioning lives on the outer <g> as an SVG transform attribute;
              the breathe animation lives on an inner <g>. They must not share
              an element — a CSS `transform` keyframe overrides the SVG
              transform attribute outright, which collapses every blossom onto
              the group origin. */}
          {blossoms.map((bl) => (
            <g
              key={bl.id}
              transform={`translate(${bl.cx} ${bl.cy}) rotate(${bl.rotation}) scale(${bl.scale})`}
            >
              <g
                style={
                  !reduced
                    ? {
                        animation: `hunt-blossom-breathe ${bl.animationDuration}s ease-in-out ${bl.animationDelay}s infinite`,
                        transformOrigin: "0px 0px",
                      }
                    : undefined
                }
              >
                <Blossom />
              </g>
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}

// Five-petal outline with radiating hatch strokes — same white-line language
// as the tiger artwork's plum blossoms.
function Blossom() {
  const petals = Array.from({ length: 5 });
  return (
    <g>
      {petals.map((_, i) => {
        const angle = (i / 5) * Math.PI * 2 - Math.PI / 2;
        const x = Math.cos(angle) * 6.4;
        const y = Math.sin(angle) * 6.4;
        const deg = (angle * 180) / Math.PI;
        return (
          <g key={i}>
            <ellipse
              cx={x}
              cy={y}
              rx={5.4}
              ry={3.6}
              transform={`rotate(${deg} ${x} ${y})`}
              fill="var(--color-bone)"
              opacity={0.16}
            />
            <ellipse
              cx={x}
              cy={y}
              rx={5.4}
              ry={3.6}
              transform={`rotate(${deg} ${x} ${y})`}
              stroke="var(--color-bone)"
              strokeWidth={0.75}
              opacity={0.7}
            />
          </g>
        );
      })}
      {/* Stamen hatch — the radiating strokes that make the source
          artwork's blossoms read as engraving rather than clip-art. */}
      {Array.from({ length: 8 }).map((_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return (
          <line
            key={`s${i}`}
            x1={Math.cos(a) * 1.4}
            y1={Math.sin(a) * 1.4}
            x2={Math.cos(a) * 3.4}
            y2={Math.sin(a) * 3.4}
            stroke="var(--color-bone)"
            strokeWidth={0.5}
            strokeLinecap="round"
            opacity={0.6}
          />
        );
      })}
      <circle r={1.5} fill="var(--color-bone)" opacity={0.8} />
    </g>
  );
}

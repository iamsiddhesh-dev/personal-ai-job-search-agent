"use client";

import { useEffect, useState, type RefObject } from "react";
import { generateBorderField, type BorderField, type Placement } from "./blossoms";

const BLEED = 56;
const RADIUS = 28;

interface BlossomBorderProps {
  panelRef: RefObject<HTMLElement | null>;
  reduced: boolean;
}

// Plum blossoms on a twig, in the source artwork's engraving language:
// solid notched petals, a dense stamen fan, veined leaves and tight buds.
// Same perimeter math and same CSS-keyframe motion strategy as GrassFrame —
// what changes is the drawing vocabulary.
export default function BlossomBorder({ panelRef, reduced }: BlossomBorderProps) {
  const [field, setField] = useState<BorderField | null>(null);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;

    function measure() {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setField(
        generateBorderField(rect.width / 2, rect.height / 2, RADIUS, BLEED, reduced ? 0.5 : 1),
      );
    }

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [panelRef, reduced]);

  if (!field) return null;
  const { branchD, barkTicks, blossoms, buds, leaves, blades, viewBox } = field;
  const cx = viewBox.w / 2;
  const cy = viewBox.h / 2;

  // Positioning lives on the outer <g> (SVG transform attribute); animation
  // lives on an inner <g>. They must never share an element — a CSS transform
  // keyframe overrides the SVG transform attribute and collapses everything
  // onto the group origin.
  const animated = (p: Placement, keyframe: string) =>
    !reduced
      ? {
          animation: `${keyframe} ${p.duration}s ease-in-out ${p.delay}s infinite`,
          transformOrigin: "0px 0px",
        }
      : undefined;

  return (
    <svg
      className="pointer-events-none absolute"
      style={{
        left: -BLEED,
        top: -BLEED,
        width: `calc(100% + ${BLEED * 2}px)`,
        height: `calc(100% + ${BLEED * 2}px)`,
      }}
      viewBox={`0 0 ${viewBox.w} ${viewBox.h}`}
      fill="none"
    >
      <g
        style={
          !reduced
            ? { animation: "hunt-gust 7s ease-in-out infinite", transformOrigin: `${cx}px ${cy}px` }
            : undefined
        }
      >
        <g transform={`translate(${cx} ${cy})`}>
          <path d={branchD} stroke="var(--color-bone)" strokeWidth={2.2} opacity={0.28} />
          {barkTicks.map((t) => (
            <line
              key={t.id}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke="var(--color-bone)"
              strokeWidth={0.7}
              opacity={0.22}
            />
          ))}

          {blades.map((b) => (
            <g
              key={`blade-${b.id}`}
              style={
                !reduced
                  ? ({
                      "--sway-deg": b.swayDeg,
                      animation: `hunt-blade-sway ${b.duration}s ease-in-out ${b.delay}s infinite`,
                      transformOrigin: `${b.originX}px ${b.originY}px`,
                    } as React.CSSProperties)
                  : undefined
              }
            >
              <path d={b.d} fill="var(--color-bone)" opacity={b.opacity} />
              <path d={b.veinD} stroke="var(--color-ink)" strokeWidth={0.5} opacity={0.5} />
            </g>
          ))}

          {leaves.map((l) => (
            <g key={`leaf-${l.id}`} transform={`translate(${l.x} ${l.y}) rotate(${l.rot}) scale(${l.scale})`}>
              <g style={animated(l, "hunt-blossom-breathe")}>
                <Leaf />
              </g>
            </g>
          ))}

          {buds.map((b) => (
            <g key={`bud-${b.id}`} transform={`translate(${b.x} ${b.y}) rotate(${b.rot}) scale(${b.scale})`}>
              <g style={animated(b, "hunt-blossom-breathe")}>
                <Bud />
              </g>
            </g>
          ))}

          {blossoms.map((b) => (
            <g key={`bl-${b.id}`} transform={`translate(${b.x} ${b.y}) rotate(${b.rot}) scale(${b.scale})`}>
              <g style={animated(b, "hunt-blossom-breathe")}>
                <Blossom seed={b.id} />
              </g>
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}

// One petal, pointing up from the origin, with the shallow V notch at its tip
// that makes a plum blossom recognisable.
const PETAL_D =
  "M 0 0 C -5.2 -3.6, -7.6 -10.4, -3.6 -14.6 L 0 -12.4 L 3.6 -14.6 C 7.6 -10.4, 5.2 -3.6, 0 0 Z";

function Blossom({ seed }: { seed: number }) {
  const petals = [0, 1, 2, 3, 4];
  const stamens = Array.from({ length: 16 });
  return (
    <g>
      {petals.map((i) => {
        const deg = (i / 5) * 360 + (seed % 5) * 3;
        return (
          <g key={i} transform={`rotate(${deg})`}>
            <path d={PETAL_D} fill="var(--color-bone)" opacity={0.9} />
            <path d={PETAL_D} stroke="var(--color-ink)" strokeWidth={0.6} opacity={0.55} />
            {/* Engraved shading at the petal base */}
            <path
              d="M -2.6 -3.4 C -1.4 -5.6, 1.4 -5.6, 2.6 -3.4"
              stroke="var(--color-ink)"
              strokeWidth={0.5}
              opacity={0.4}
            />
            <path
              d="M -3.4 -6.4 C -1.8 -8.6, 1.8 -8.6, 3.4 -6.4"
              stroke="var(--color-ink)"
              strokeWidth={0.45}
              opacity={0.3}
            />
          </g>
        );
      })}

      {/* The stamen fan — the most recognisable feature of the source's
          blossoms, and what separates an engraving from a flat icon. */}
      {stamens.map((_, i) => {
        const a = (i / 16) * Math.PI * 2;
        const inner = 1.8;
        const outer = 6.2 + (i % 3) * 0.9;
        return (
          <g key={`s${i}`}>
            <line
              x1={Math.cos(a) * inner}
              y1={Math.sin(a) * inner}
              x2={Math.cos(a) * outer}
              y2={Math.sin(a) * outer}
              stroke="var(--color-ink)"
              strokeWidth={0.5}
              opacity={0.75}
            />
            <circle
              cx={Math.cos(a) * outer}
              cy={Math.sin(a) * outer}
              r={0.85}
              fill="var(--color-ink)"
              opacity={0.85}
            />
          </g>
        );
      })}
      <circle r={2} fill="var(--color-ink)" opacity={0.9} />
      <circle r={2} stroke="var(--color-bone)" strokeWidth={0.5} opacity={0.5} />
    </g>
  );
}

function Bud() {
  return (
    <g>
      <line x1={0} y1={0} x2={0} y2={7} stroke="var(--color-bone)" strokeWidth={0.9} opacity={0.45} />
      <ellipse cx={0} cy={-2} rx={3.4} ry={4.4} fill="var(--color-bone)" opacity={0.85} />
      <ellipse cx={0} cy={-2} rx={3.4} ry={4.4} stroke="var(--color-ink)" strokeWidth={0.55} opacity={0.6} />
      {/* Wrap lines that make it read as a closed bud, not a dot */}
      <path d="M -3.2 -3 C -1.2 -1.4, 1.2 -1.4, 3.2 -3" stroke="var(--color-ink)" strokeWidth={0.5} opacity={0.55} />
      <path d="M -2.8 -0.4 C -1 0.8, 1 0.8, 2.8 -0.4" stroke="var(--color-ink)" strokeWidth={0.45} opacity={0.45} />
    </g>
  );
}

function Leaf() {
  return (
    <g>
      <path
        d="M 0 0 C 5.5 -3.5, 8.5 -10, 0 -17 C -8.5 -10, -5.5 -3.5, 0 0 Z"
        fill="var(--color-bone)"
        opacity={0.55}
      />
      <path
        d="M 0 0 C 5.5 -3.5, 8.5 -10, 0 -17 C -8.5 -10, -5.5 -3.5, 0 0 Z"
        stroke="var(--color-ink)"
        strokeWidth={0.55}
        opacity={0.55}
      />
      <line x1={0} y1={-0.5} x2={0} y2={-16} stroke="var(--color-ink)" strokeWidth={0.5} opacity={0.6} />
      {[-3.5, -6.5, -9.5, -12.5].map((y, i) => (
        <g key={i}>
          <line x1={0} y1={y} x2={-3.6} y2={y - 2.4} stroke="var(--color-ink)" strokeWidth={0.4} opacity={0.45} />
          <line x1={0} y1={y} x2={3.6} y2={y - 2.4} stroke="var(--color-ink)" strokeWidth={0.4} opacity={0.45} />
        </g>
      ))}
    </g>
  );
}

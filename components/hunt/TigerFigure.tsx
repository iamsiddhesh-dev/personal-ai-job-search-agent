"use client";

import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import Image from "next/image";
import type { HeroConfig } from "./heroConfig";
import type { Plane } from "./useParallax";

// The leap timeline, in seconds. Exported so HeroStage, DevourHeadline and
// PetalBurst schedule against the same beats instead of re-deriving magic
// numbers.
export const LEAP = {
  crouch: 0.18,
  launch: 0.3,
  apex: 0.41,
  impact: 0.52,
  settle: 0.62,
  end: 0.8,
} as const;

const T = [
  0,
  LEAP.crouch / LEAP.end,
  LEAP.launch / LEAP.end,
  LEAP.apex / LEAP.end,
  LEAP.impact / LEAP.end,
  LEAP.settle / LEAP.end,
  1,
];

// Overall growth (the animal coming toward the viewer) is kept separate from
// squash/stretch (the deformation), then multiplied into scaleX/scaleY. Doing
// it in one blended array is how you end up with a tiger that inflates instead
// of one that compresses and springs.
const GROWTH = [1, 1.0, 1.05, 1.2, 1.35, 1.28, 1.18];
const SQUASH_X = [1, 1.08, 0.92, 0.97, 1.12, 1.02, 1.0];
const SQUASH_Y = [1, 0.9, 1.14, 1.05, 0.88, 1.0, 1.0];

const SCALE_X = GROWTH.map((g, i) => +(g * SQUASH_X[i]).toFixed(3));
const SCALE_Y = GROWTH.map((g, i) => +(g * SQUASH_Y[i]).toFixed(3));

// Scale at the impact beat. The transform origin is bottom-centre, so scaling
// moves the mouth away from where its untransformed anchor sits; HeroStage
// needs these to cancel that drift out of the leap target, or the tiger lands
// consistently short of the headline.
export const IMPACT_SCALE = { x: SCALE_X[4], y: SCALE_Y[4] };

export interface TigerAnchors {
  mouth: { x: number; y: number };
  paw: { x: number; y: number };
  size: { w: number; h: number };
}

export interface TigerFigureProps {
  config: HeroConfig;
  plane: Plane;
  hovered: boolean;
  igniting: boolean;
  leapDelta: { x: number; y: number } | null;
  onAnchors: (anchors: TigerAnchors) => void;
}

export default function TigerFigure({
  config,
  plane,
  hovered,
  igniting,
  leapDelta,
  onAnchors,
}: TigerFigureProps) {
  const imgWrapRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const t = config.tiger;

  useEffect(() => {
    function report() {
      const el = imgWrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      onAnchors({
        mouth: { x: rect.left + rect.width * t.mouth.x, y: rect.top + rect.height * t.mouth.y },
        paw: { x: rect.left + rect.width * t.paw.x, y: rect.top + rect.height * t.paw.y },
        size: { w: rect.width, h: rect.height },
      });
    }
    report();
    // Two frames of settle: fonts and the vh-sized box can shift the anchor
    // after first paint, and a stale anchor sends the leap to the wrong place.
    const r1 = requestAnimationFrame(report);
    const r2 = requestAnimationFrame(() => requestAnimationFrame(report));
    window.addEventListener("resize", report);
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
      window.removeEventListener("resize", report);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.mouth.x, t.mouth.y, t.paw.x, t.paw.y, t.sizeVh, t.anchor]);

  const dx = leapDelta?.x ?? 0;
  const dy = leapDelta?.y ?? 0;

  // A real arc needs x and y on different curves. x carries across almost
  // linearly while y rises to an apex and falls — animating both with one
  // easing is what makes a leap look like a slide.
  //
  // The apex is clamped to be genuinely above the start. When the target sits
  // *below* the tiger (mobile: upper band pouncing down onto the lower-third
  // headline) a naive `dy * 0.5 - rise` is still positive, so the animal just
  // slides downward with no leap in it.
  const rise = Math.min(120, Math.max(55, Math.abs(dy) * 0.32));
  const apexY = Math.min(dy * 0.5, 0) - rise;

  const leapAnimation = {
    x: [0, 8, 0, dx * 0.5, dx, dx * 1.03, dx],
    y: [0, 14, 4, apexY, dy, dy + 10, dy],
    scaleX: SCALE_X,
    scaleY: SCALE_Y,
    rotate: [0, 3, -6, -9, -4, -6, -5],
  };

  const edge = `min(${t.sizeVh}vh, ${t.maxWidthVw}vw)`;

  // Centring is done with a negative margin, never with translateX: the `x`
  // transform channel has to stay free for the leap. Mixing a `-50%` centring
  // offset into `x` means the first leap keyframe snaps the tiger sideways by
  // half its width.
  const positioning =
    t.anchor === "upper-band"
      ? { left: "50%", top: `${t.offsetYVh}vh`, marginLeft: `calc(${edge} / -2)` }
      : { right: `${-t.offsetXVh}vh`, bottom: `${-t.offsetYVh}vh` };

  return (
    // Outermost: the parallax plane. Kept separate from the leap so camera
    // movement and the leap transform never overwrite each other.
    <motion.div
      className="pointer-events-none absolute inset-0"
      style={{ x: plane.x, y: plane.y, zIndex: igniting ? 30 : 0, willChange: "transform" }}
    >
      <motion.div
        className="absolute"
        style={{
          ...positioning,
          // Square, but never wider than the viewport allows — on portrait a
          // vh-only size overflows sideways and crops the tail and paws.
          width: edge,
          height: edge,
          opacity: t.opacity,
          // Bottom-centre origin so squash and stretch deform against the
          // ground the animal is pushing off, not against its middle.
          transformOrigin: "50% 100%",
          willChange: "transform",
        }}
        animate={
          igniting
            ? leapAnimation
            : hovered
              ? { x: 0, y: 0, scaleX: 1.025, scaleY: 1.025, rotate: 0 }
              : { x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0 }
        }
        transition={
          igniting
            ? {
                duration: LEAP.end,
                times: T,
                ease: ["easeIn", "easeOut", "easeOut", "easeIn", "easeOut", "easeOut"],
              }
            : { type: "spring", stiffness: 220, damping: 26 }
        }
      >
        {/* Atmospheric glow behind the body — seats a transparent cutout into
            the scene instead of letting it float on flat black. */}
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: `${t.glow.sizeVh}vh`,
            height: `${t.glow.sizeVh}vh`,
            opacity: t.glow.opacity,
            background:
              "radial-gradient(circle, rgba(237,234,227,0.55) 0%, rgba(237,234,227,0.12) 45%, rgba(237,234,227,0) 72%)",
          }}
        />

        {/* Contact shadow under the paws — the single cheapest cue that the
            animal is standing on something. */}
        <div
          className="absolute left-1/2 -translate-x-1/2 rounded-[50%]"
          style={{
            bottom: `${t.shadow.offsetYVh}vh`,
            width: `${t.shadow.widthVh}vh`,
            height: `${t.shadow.heightVh}vh`,
            opacity: t.shadow.opacity,
            background:
              "radial-gradient(ellipse, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.5) 45%, rgba(0,0,0,0) 75%)",
            filter: "blur(10px)",
          }}
        />

        {/* Idle life on an inner wrapper, so breathing composes with the hover
            spring and the leap keyframes above instead of fighting them. */}
        <motion.div
          className="absolute inset-0"
          animate={
            reduced || igniting
              ? { scale: 1, y: 0 }
              : { scale: [1, 1 + t.breatheAmp, 1], y: [0, -t.floatAmp, 0] }
          }
          transition={
            reduced || igniting
              ? { duration: 0.3 }
              : { duration: 7.5, repeat: Infinity, ease: "easeInOut" }
          }
        >
          <div ref={imgWrapRef} className="relative h-full w-full">
            {/* Motion smear — only during flight, so the leap reads as fast
                rather than as a teleport. */}
            <motion.div
              className="absolute inset-0"
              animate={
                igniting
                  ? { opacity: [0, 0, 0.4, 0.45, 0, 0, 0], x: [0, 0, 18, 30, 8, 0, 0] }
                  : { opacity: 0, x: 0 }
              }
              transition={{ duration: LEAP.end, times: T }}
            >
              <Image
                src={t.src}
                alt=""
                fill
                priority
                sizes="120vh"
                className="object-contain blur-[3px]"
                style={{ mixBlendMode: t.blend }}
              />
            </motion.div>

            <Image
              src={t.src}
              alt="A woodcut-style tiger, crouched and snarling"
              fill
              priority
              sizes="120vh"
              className="object-contain"
              style={{ mixBlendMode: t.blend }}
            />
          </div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

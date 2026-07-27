"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import TigerFigure, { IMPACT_SCALE, LEAP, type TigerAnchors } from "./TigerFigure";
import DevourHeadline from "./DevourHeadline";
import PetalBurst from "./PetalBurst";
import PetalField from "./PetalField";
import HeroGrass from "./HeroGrass";
import InkEnvironment from "./InkEnvironment";
import { useHeroConfig } from "./heroConfig";
import { useParallax } from "./useParallax";

interface HeroStageProps {
  igniting: boolean;
  reduced: boolean;
  onIgnite: () => void;
  onImpactPoint: (point: { x: number; y: number }) => void;
}

export default function HeroStage({
  igniting,
  reduced,
  onIgnite,
  onImpactPoint,
}: HeroStageProps) {
  const { config, ready } = useHeroConfig();
  const { planes } = useParallax(config.camera, config.parallax);

  const [hovered, setHovered] = useState(false);
  const [anchors, setAnchors] = useState<TigerAnchors | null>(null);
  const [headlineCenter, setHeadlineCenter] = useState<{ x: number; y: number } | null>(null);
  const headlineRef = useRef<HTMLDivElement>(null);

  const isMobile = config.breakpoint === "mobile";

  useLayoutEffect(() => {
    function measure() {
      const el = headlineRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setHeadlineCenter({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    }
    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
    };
  }, [config.breakpoint, config.headlineScale]);

  const handleAnchors = useCallback((next: TigerAnchors) => setAnchors(next), []);

  // Where the mouth ends up is the landing point, so the bite, the ink burst
  // and the water pulse all key off the headline's centre.
  const impactPoint = headlineCenter;

  // Travel is measured, never a constant — the tiger has to reach the words in
  // all three compositions, and mobile's delta (upper band → lower third) is
  // nothing like desktop's. The correction term cancels the drift that
  // bottom-centre scaling introduces at the impact beat.
  const leapDelta =
    anchors && headlineCenter
      ? {
          x:
            headlineCenter.x -
            anchors.mouth.x -
            (config.tiger.mouth.x - 0.5) * anchors.size.w * (IMPACT_SCALE.x - 1),
          y:
            headlineCenter.y -
            anchors.mouth.y -
            (config.tiger.mouth.y - 1) * anchors.size.h * (IMPACT_SCALE.y - 1),
        }
      : null;

  useLayoutEffect(() => {
    if (impactPoint) onImpactPoint(impactPoint);
  }, [impactPoint, onImpactPoint]);

  const backGrass = config.grass.filter((l) => !l.front);
  const frontGrass = config.grass.filter((l) => l.front);

  return (
    <motion.div
      className="relative h-dvh w-full overflow-hidden bg-ink"
      animate={igniting && !reduced ? { x: [0, -5, 5, -3, 0] } : { x: 0 }}
      transition={
        igniting && !reduced
          ? { delay: LEAP.impact, duration: 0.24, ease: "linear" }
          : { duration: 0 }
      }
    >
      {/* ---- Plane 1: background. Deepest, least travel. ---- */}
      <InkEnvironment
        origin={anchors?.paw ?? null}
        impactPoint={impactPoint}
        igniting={igniting}
        reduced={reduced}
        rippleCount={config.rippleCount}
        plane={planes.envBg}
        mistPlane={planes.mist}
      />

      {/* ---- Plane 2: grass behind the tiger. ---- */}
      {ready &&
        backGrass.map((layer, i) => (
          <HeroGrass key={`gb-${i}`} layer={layer} plane={planes.grassBack} seed={i + 1} />
        ))}

      {/* ---- Plane 3: the tiger. ---- */}
      <TigerFigure
        config={config}
        plane={planes.tiger}
        hovered={hovered}
        igniting={igniting}
        leapDelta={leapDelta}
        onAnchors={handleAnchors}
      />

      {/* Scrim, per composition: a left wash on desktop so the headline column
          reads over the artwork; a bottom-up wash on mobile so the lower-third
          text has contrast over the grass. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: isMobile
            ? "linear-gradient(to top, var(--color-ink) 12%, rgba(7,7,10,0.93) 34%, rgba(7,7,10,0.55) 52%, rgba(7,7,10,0) 74%)"
            : "linear-gradient(100deg, var(--color-ink) 0%, rgba(7,7,10,0.94) 26%, rgba(7,7,10,0.6) 48%, rgba(7,7,10,0) 72%)",
        }}
      />

      {/* ---- Plane 4: foreground grass, above the tiger. ---- */}
      {ready &&
        frontGrass.map((layer, i) => (
          <div key={`gf-${i}`} className="pointer-events-none absolute inset-0 z-20">
            <HeroGrass layer={layer} plane={planes.grassFront} seed={i + 40} />
          </div>
        ))}

      {/* ---- Plane 5: drifting petals, frontmost. ---- */}
      {ready && (
        <div className="pointer-events-none absolute inset-0 z-20">
          <PetalField config={config.petals} plane={planes.petals} />
        </div>
      )}

      {/* ---- Content. Desktop/tablet: left column, vertically centred.
              Mobile: lower-third band, tiger sits above it. ---- */}
      <div
        className={
          isMobile
            ? "absolute inset-x-0 bottom-0 z-10 flex flex-col gap-4 px-7 pb-[16vh]"
            : "absolute inset-y-0 left-0 z-10 flex w-full flex-col justify-center gap-6 px-[8vw] md:px-[10vw] lg:px-[12vw]"
        }
      >
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-seal" />
          <span className="font-hunt text-sm font-medium uppercase tracking-[0.25em] text-bone/70">
            startHunt
          </span>
        </div>

        <div ref={headlineRef} className="w-fit">
          <DevourHeadline
            igniting={igniting}
            hovered={hovered}
            impactPoint={impactPoint}
            scale={config.headlineScale}
            onClick={onIgnite}
            onHoverChange={setHovered}
          />
        </div>

        <motion.p
          className="max-w-[280px] font-body text-[15px] leading-relaxed text-bone/60 lg:max-w-sm"
          animate={{ opacity: igniting ? 0 : 1 }}
          transition={{ duration: 0.2 }}
        >
          your hiring-consultant agent for early-stage startup roles.
        </motion.p>

        <motion.span
          className="font-body text-xs uppercase tracking-[0.2em] text-bone/40"
          initial={{ opacity: 0 }}
          animate={{ opacity: igniting ? 0 : hovered ? 1 : 0.5 }}
          transition={{ duration: 0.4, delay: 0.6 }}
        >
          {isMobile ? "tap to begin" : "click to begin"}
        </motion.span>
      </div>

      {/* Scene vignette — seats the whole frame. */}
      <div
        className="pointer-events-none absolute inset-0 z-30"
        style={{
          background:
            "radial-gradient(ellipse 90% 80% at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.42) 100%)",
        }}
      />

      <PetalBurst igniting={igniting} impactPoint={impactPoint} />
    </motion.div>
  );
}

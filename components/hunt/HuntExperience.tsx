"use client";

import { useCallback, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import HeroStage from "./HeroStage";
import HuntChatFrame from "./HuntChatFrame";
import InkWipe, { type InkWipePhase } from "./InkWipe";

// Total time from click to the DOM swap happening fully hidden under ink —
// must match the sum of InkWipe's "active" delay+duration in InkWipe.tsx.
const WIPE_COVER_MS = (0.88 + 0.55) * 1000;
const WIPE_REVEAL_MS = (0.1 + 0.32) * 1000;

export default function HuntExperience() {
  const reducedMotion = useReducedMotion();
  const [stage, setStage] = useState<"hero" | "chat">("hero");
  const [igniting, setIgniting] = useState(false);
  const [inkPhase, setInkPhase] = useState<InkWipePhase>("hidden");
  const impactPointRef = useRef<{ x: number; y: number } | null>(null);
  const [impactPoint, setImpactPoint] = useState<{ x: number; y: number } | null>(null);

  const handleImpactPoint = useCallback((point: { x: number; y: number }) => {
    impactPointRef.current = point;
    setImpactPoint(point);
  }, []);

  function ignite() {
    if (igniting || stage === "chat") return;

    if (reducedMotion) {
      setStage("chat");
      return;
    }

    setIgniting(true);
    setInkPhase("active");

    window.setTimeout(() => {
      setStage("chat");
      setInkPhase("revealing");
    }, WIPE_COVER_MS);

    window.setTimeout(() => {
      setInkPhase("hidden");
      setIgniting(false);
    }, WIPE_COVER_MS + WIPE_REVEAL_MS);
  }

  function back() {
    setStage("hero");
    setIgniting(false);
    setInkPhase("hidden");
  }

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-ink">
      <AnimatePresence mode="wait" initial={false}>
        {stage === "hero" ? (
          <motion.div
            key="hero"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0.2 : 0.15 }}
          >
            <HeroStage
              igniting={igniting}
              reduced={!!reducedMotion}
              onIgnite={ignite}
              onImpactPoint={handleImpactPoint}
            />
          </motion.div>
        ) : (
          <motion.div
            key="chat"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0.2 : 0.2, delay: reducedMotion ? 0 : 0.05 }}
          >
            <HuntChatFrame onBack={back} reducedMotion={!!reducedMotion} />
          </motion.div>
        )}
      </AnimatePresence>

      {!reducedMotion && <InkWipe phase={inkPhase} origin={impactPoint} />}
    </div>
  );
}

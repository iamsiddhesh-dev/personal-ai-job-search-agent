"use client";

import { motion } from "framer-motion";

export type InkWipePhase = "hidden" | "active" | "revealing";

interface InkWipeProps {
  phase: InkWipePhase;
  origin: { x: number; y: number } | null;
}

// A black disc anchored at the bite point, scaling up until it swallows the
// viewport — this is what hides the hero→chat swap. Once the swap has
// happened underneath (fully hidden), it fades out to reveal the chat frame,
// so the slide never shows a seam.
export default function InkWipe({ phase, origin }: InkWipeProps) {
  if (!origin) return null;

  return (
    <motion.div
      className="pointer-events-none fixed z-40 rounded-full bg-ink"
      style={{
        left: origin.x,
        top: origin.y,
        width: "10px",
        height: "10px",
        translateX: "-50%",
        translateY: "-50%",
      }}
      initial={{ scale: 0, opacity: 1 }}
      animate={
        phase === "hidden"
          ? { scale: 0, opacity: 1 }
          : phase === "active"
            ? { scale: 400, opacity: 1 }
            : { scale: 400, opacity: 0 }
      }
      transition={
        phase === "active"
          ? { delay: 0.88, duration: 0.55, ease: "easeIn" }
          : phase === "revealing"
            ? { delay: 0.1, duration: 0.32, ease: "easeOut" }
            : { duration: 0 }
      }
    />
  );
}

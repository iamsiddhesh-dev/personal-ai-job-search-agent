"use client";

import { motion } from "framer-motion";
import { hash } from "@/lib/anim/hash";
import { LEAP } from "./TigerFigure";

const DROPLETS = 16;
const SPLATTER = 9;

interface PetalBurstProps {
  igniting: boolean;
  impactPoint: { x: number; y: number } | null;
}

// Thrown from the landing point on the impact beat. Water droplets and ink
// splatter — not petals: with the blossoms gone from the hero, flowers
// bursting off a tiger standing in water made no sense. Petals now live
// exclusively on the chat stage's border.
export default function PetalBurst({ igniting, impactPoint }: PetalBurstProps) {
  if (!impactPoint) return null;

  return (
    <div
      className="pointer-events-none fixed z-40"
      style={{ left: impactPoint.x, top: impactPoint.y }}
    >
      {Array.from({ length: DROPLETS }).map((_, i) => {
        const angle = hash(i * 3 + 1) * Math.PI * 2;
        // Biased upward — a landing throws water up and out, not evenly.
        const distance = 60 + hash(i * 3 + 2) * 150;
        const dx = Math.cos(angle) * distance;
        const dy = Math.sin(angle) * distance * 0.7 - 45;
        const len = 5 + hash(i * 3 + 3) * 11;
        const wide = 1.4 + hash(i * 3 + 4) * 1.6;

        return (
          <motion.div
            key={i}
            className="absolute left-0 top-0"
            style={{
              width: wide,
              height: len,
              borderRadius: "50%",
              background: "var(--color-bone)",
              rotate: `${(angle * 180) / Math.PI + 90}deg`,
            }}
            initial={{ opacity: 0, x: 0, y: 0, scale: 0 }}
            animate={
              igniting
                ? {
                    opacity: [0, 0.95, 0.8, 0],
                    x: [0, dx * 0.55, dx],
                    y: [0, dy * 0.55, dy + 90],
                    scale: [0, 1, 1, 0.7],
                  }
                : { opacity: 0 }
            }
            transition={{
              delay: LEAP.impact,
              duration: 0.8,
              times: [0, 0.25, 0.7, 1],
              ease: "easeOut",
            }}
          />
        );
      })}

      {Array.from({ length: SPLATTER }).map((_, i) => {
        const angle = hash(i * 5 + 11) * Math.PI * 2;
        const distance = 26 + hash(i * 5 + 12) * 62;
        const size = 2.5 + hash(i * 5 + 13) * 5;

        return (
          <motion.div
            key={`splat-${i}`}
            className="absolute left-0 top-0 rounded-full"
            style={{ width: size, height: size, background: "var(--color-seal)" }}
            initial={{ opacity: 0, x: 0, y: 0 }}
            animate={
              igniting
                ? {
                    opacity: [0, 1, 0],
                    x: Math.cos(angle) * distance,
                    y: Math.sin(angle) * distance,
                  }
                : { opacity: 0 }
            }
            transition={{ delay: LEAP.impact, duration: 0.5, ease: "easeOut" }}
          />
        );
      })}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";

export type Breakpoint = "mobile" | "tablet" | "desktop";

// Matches Tailwind's md / lg so CSS and JS never disagree about which
// composition is on screen.
const QUERIES: Array<[Breakpoint, string]> = [
  ["mobile", "(max-width: 767.98px)"],
  ["tablet", "(min-width: 768px) and (max-width: 1023.98px)"],
  ["desktop", "(min-width: 1024px)"],
];

// Returns null until mounted. Callers treat null as "not yet known" and either
// fall back to desktop values or skip rendering decorative layers, so the
// server and first client render always agree.
export function useBreakpoint(): Breakpoint | null {
  const [bp, setBp] = useState<Breakpoint | null>(null);

  useEffect(() => {
    const lists = QUERIES.map(([name, q]) => [name, window.matchMedia(q)] as const);
    const sync = () => {
      const hit = lists.find(([, mql]) => mql.matches);
      setBp(hit ? hit[0] : "desktop");
    };
    sync();
    lists.forEach(([, mql]) => mql.addEventListener("change", sync));
    return () => lists.forEach(([, mql]) => mql.removeEventListener("change", sync));
  }, []);

  return bp;
}

export interface TigerConfig {
  src: string;
  /** `normal` for the alpha asset; `screen` only for the black-backed plate. */
  blend: "normal" | "screen";
  /** Square edge length, in vh. */
  sizeVh: number;
  /** Hard cap in vw, so a portrait viewport never crops the animal. */
  maxWidthVw: number;
  /** Anchoring within the hero box. */
  anchor: "right-bleed" | "upper-band";
  offsetXVh: number;
  offsetYVh: number;
  opacity: number;
  /** Normalized anchors on the artwork — the leap and ripples key off these. */
  mouth: { x: number; y: number };
  paw: { x: number; y: number };
  breatheAmp: number;
  floatAmp: number;
  shadow: { widthVh: number; heightVh: number; opacity: number; offsetYVh: number };
  glow: { sizeVh: number; opacity: number };
}

export interface CameraConfig {
  pointerStrength: number;
  touch: boolean;
  driftAmp: number;
  driftSpeed: number;
  /** Higher = snappier follow. */
  ease: number;
}

export interface ParallaxDepths {
  envBg: number;
  mist: number;
  tiger: number;
  grassBack: number;
  grassFront: number;
  petals: number;
}

export interface PetalConfig {
  count: number;
  size: [number, number];
  duration: [number, number];
  drift: number;
}

export interface GrassLayerConfig {
  count: number;
  heightVh: number;
  opacity: number;
  depth: keyof ParallaxDepths;
  /** Rendered above the tiger when true. */
  front: boolean;
  strokeWidth: number;
}

export interface HeroConfig {
  breakpoint: Breakpoint;
  tiger: TigerConfig;
  camera: CameraConfig;
  parallax: ParallaxDepths;
  petals: PetalConfig;
  grass: GrassLayerConfig[];
  /** Ripple ring count for InkEnvironment. */
  rippleCount: number;
  headlineScale: "sm" | "md" | "lg";
}

const TIGER_SRC = "/tiger-hero.png";
const TIGER_BLEND = "normal" as const;

// Three hand-tuned compositions. Values are authored per breakpoint rather
// than derived from a desktop baseline — that is the whole point of this
// table. Mobile is not desktop times a factor.
export const HERO_CONFIG: Record<Breakpoint, HeroConfig> = {
  desktop: {
    breakpoint: "desktop",
    tiger: {
      src: TIGER_SRC,
      blend: TIGER_BLEND,
      sizeVh: 116,
      maxWidthVw: 62,
      anchor: "right-bleed",
      offsetXVh: 12,
      offsetYVh: 14,
      opacity: 1,
      mouth: { x: 0.4, y: 0.74 },
      paw: { x: 0.3, y: 0.43 },
      breatheAmp: 0.014,
      floatAmp: 9,
      shadow: { widthVh: 62, heightVh: 9, opacity: 0.5, offsetYVh: 2 },
      glow: { sizeVh: 90, opacity: 0.1 },
    },
    camera: { pointerStrength: 1, touch: false, driftAmp: 0.32, driftSpeed: 0.055, ease: 0.045 },
    parallax: { envBg: 14, mist: 22, tiger: 34, grassBack: 44, grassFront: 78, petals: 92 },
    petals: { count: 30, size: [7, 20], duration: [13, 26], drift: 130 },
    grass: [
      { count: 46, heightVh: 15, opacity: 0.3, depth: "grassBack", front: false, strokeWidth: 1.5 },
      { count: 34, heightVh: 24, opacity: 0.62, depth: "grassFront", front: true, strokeWidth: 2.4 },
    ],
    rippleCount: 22,
    headlineScale: "lg",
  },

  tablet: {
    breakpoint: "tablet",
    tiger: {
      src: TIGER_SRC,
      blend: TIGER_BLEND,
      sizeVh: 88,
      maxWidthVw: 72,
      anchor: "right-bleed",
      offsetXVh: 8,
      offsetYVh: 16,
      opacity: 0.95,
      mouth: { x: 0.4, y: 0.74 },
      paw: { x: 0.3, y: 0.43 },
      breatheAmp: 0.011,
      floatAmp: 7,
      shadow: { widthVh: 52, heightVh: 8, opacity: 0.45, offsetYVh: 2 },
      glow: { sizeVh: 76, opacity: 0.09 },
    },
    camera: { pointerStrength: 0.7, touch: true, driftAmp: 0.26, driftSpeed: 0.05, ease: 0.04 },
    parallax: { envBg: 9, mist: 14, tiger: 21, grassBack: 27, grassFront: 48, petals: 56 },
    petals: { count: 20, size: [6, 17], duration: [14, 27], drift: 95 },
    grass: [
      { count: 38, heightVh: 14, opacity: 0.3, depth: "grassBack", front: false, strokeWidth: 1.4 },
      { count: 26, heightVh: 21, opacity: 0.6, depth: "grassFront", front: true, strokeWidth: 2.2 },
    ],
    rippleCount: 17,
    headlineScale: "md",
  },

  mobile: {
    breakpoint: "mobile",
    // Portrait: the tiger is the hero image in the upper band, full width,
    // sitting ABOVE the text rather than behind it.
    tiger: {
      src: TIGER_SRC,
      blend: TIGER_BLEND,
      sizeVh: 62,
      maxWidthVw: 96,
      anchor: "upper-band",
      offsetXVh: 0,
      offsetYVh: 0,
      opacity: 1,
      mouth: { x: 0.4, y: 0.74 },
      paw: { x: 0.3, y: 0.43 },
      breatheAmp: 0.008,
      floatAmp: 4,
      shadow: { widthVh: 40, heightVh: 5, opacity: 0.42, offsetYVh: 1 },
      glow: { sizeVh: 58, opacity: 0.08 },
    },
    camera: { pointerStrength: 0, touch: true, driftAmp: 0.15, driftSpeed: 0.04, ease: 0.035 },
    parallax: { envBg: 4, mist: 6, tiger: 9, grassBack: 12, grassFront: 22, petals: 26 },
    petals: { count: 12, size: [6, 14], duration: [15, 28], drift: 55 },
    grass: [
      { count: 30, heightVh: 12, opacity: 0.32, depth: "grassBack", front: false, strokeWidth: 1.4 },
      { count: 20, heightVh: 18, opacity: 0.6, depth: "grassFront", front: true, strokeWidth: 2.1 },
    ],
    rippleCount: 11,
    headlineScale: "sm",
  },
};

export function useHeroConfig(): { config: HeroConfig; ready: boolean } {
  const bp = useBreakpoint();
  return { config: HERO_CONFIG[bp ?? "desktop"], ready: bp !== null };
}

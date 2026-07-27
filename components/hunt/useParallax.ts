"use client";

import { useEffect, useRef } from "react";
import {
  useAnimationFrame,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "framer-motion";
import type { CameraConfig, ParallaxDepths } from "./heroConfig";

export interface Plane {
  x: MotionValue<number>;
  y: MotionValue<number>;
}

export interface ParallaxRig {
  camX: MotionValue<number>;
  camY: MotionValue<number>;
  /** One entry per depth plane; bind to a layer's style={{ x, y }}. */
  planes: Record<keyof ParallaxDepths, Plane>;
}

// A virtual camera driving every depth plane in the hero.
//
// The whole rig lives in motion values, so pointer movement and the idle drift
// never trigger a React render — layers subscribe directly and only their
// transforms update. This is what keeps a scene this busy smooth.
export function useParallax(camera: CameraConfig, depths: ParallaxDepths): ParallaxRig {
  const reduced = useReducedMotion();

  const camX = useMotionValue(0);
  const camY = useMotionValue(0);

  // Pointer/touch target, in roughly [-1, 1].
  const targetX = useRef(0);
  const targetY = useRef(0);

  useEffect(() => {
    if (reduced) return;

    const wantsPointer = camera.pointerStrength > 0;
    if (!wantsPointer && !camera.touch) return;

    function onPointer(e: PointerEvent) {
      if (e.pointerType === "touch") return;
      targetX.current = (e.clientX / window.innerWidth - 0.5) * 2 * camera.pointerStrength;
      targetY.current = (e.clientY / window.innerHeight - 0.5) * 2 * camera.pointerStrength;
    }

    // Touch drives the camera by drag delta rather than absolute position —
    // absolute would snap the scene to wherever the finger lands.
    let lastX = 0;
    let lastY = 0;
    let tracking = false;

    function onTouchStart(e: TouchEvent) {
      const t = e.touches[0];
      if (!t) return;
      lastX = t.clientX;
      lastY = t.clientY;
      tracking = true;
    }
    function onTouchMove(e: TouchEvent) {
      const t = e.touches[0];
      if (!t || !tracking) return;
      targetX.current = clamp(targetX.current + ((t.clientX - lastX) / window.innerWidth) * 2.2, -1, 1);
      targetY.current = clamp(targetY.current + ((t.clientY - lastY) / window.innerHeight) * 2.2, -1, 1);
      lastX = t.clientX;
      lastY = t.clientY;
    }
    function onTouchEnd() {
      tracking = false;
    }

    if (wantsPointer) window.addEventListener("pointermove", onPointer, { passive: true });
    if (camera.touch) {
      window.addEventListener("touchstart", onTouchStart, { passive: true });
      window.addEventListener("touchmove", onTouchMove, { passive: true });
      window.addEventListener("touchend", onTouchEnd, { passive: true });
    }
    return () => {
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [camera.pointerStrength, camera.touch, reduced]);

  useAnimationFrame((t) => {
    if (reduced) return;
    const s = t / 1000;
    // Two incommensurate frequencies per axis, so the idle path never visibly
    // repeats — the scene keeps moving even when the user does not.
    const driftX = (Math.sin(s * camera.driftSpeed * 2 * Math.PI) * 0.65 +
      Math.sin(s * camera.driftSpeed * 2 * Math.PI * 0.37 + 1.7) * 0.35) * camera.driftAmp;
    const driftY = (Math.cos(s * camera.driftSpeed * 2 * Math.PI * 0.83) * 0.6 +
      Math.cos(s * camera.driftSpeed * 2 * Math.PI * 0.29 + 0.9) * 0.4) * camera.driftAmp;

    // Critically-damped-feeling ease toward pointer + drift. No springs here:
    // a spring on a continuously moving target overshoots and wobbles.
    camX.set(camX.get() + (targetX.current + driftX - camX.get()) * camera.ease);
    camY.set(camY.get() + (targetY.current + driftY - camY.get()) * camera.ease);
  });

  // One transform pair per plane, always created in the same order and count
  // regardless of breakpoint or which layers actually render. Depth factors
  // change with the config; the hook graph does not.
  const envBgX = useTransform(camX, (v) => v * depths.envBg);
  const envBgY = useTransform(camY, (v) => v * depths.envBg);
  const mistX = useTransform(camX, (v) => v * depths.mist);
  const mistY = useTransform(camY, (v) => v * depths.mist);
  const tigerX = useTransform(camX, (v) => v * depths.tiger);
  const tigerY = useTransform(camY, (v) => v * depths.tiger);
  const grassBackX = useTransform(camX, (v) => v * depths.grassBack);
  const grassBackY = useTransform(camY, (v) => v * depths.grassBack);
  // Foreground planes travel against the camera — opposing directions are what
  // read as depth rather than as the whole scene sliding.
  const grassFrontX = useTransform(camX, (v) => v * -depths.grassFront);
  const grassFrontY = useTransform(camY, (v) => v * -depths.grassFront * 0.4);
  const petalsX = useTransform(camX, (v) => v * -depths.petals);
  const petalsY = useTransform(camY, (v) => v * -depths.petals * 0.4);

  const planes: Record<keyof ParallaxDepths, Plane> = {
    envBg: { x: envBgX, y: envBgY },
    mist: { x: mistX, y: mistY },
    tiger: { x: tigerX, y: tigerY },
    grassBack: { x: grassBackX, y: grassBackY },
    grassFront: { x: grassFrontX, y: grassFrontY },
    petals: { x: petalsX, y: petalsY },
  };

  return { camX, camY, planes };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

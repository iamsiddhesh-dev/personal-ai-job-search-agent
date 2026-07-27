"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RoomEnvironment } from "three-stdlib";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { twMerge } from "tailwind-merge";
import ConversationPanel from "@/components/chat/ConversationPanel";
import { hash } from "@/lib/anim/hash";
import { roundedRectPoint } from "@/lib/geometry/roundedRect";

function cn(...classes: Array<string | false | null | undefined>) {
  return twMerge(classes.filter(Boolean).join(" "));
}

// Cross-section resolution (around the tube) and path resolution (around the
// loop / sphere longitude). Both shapes below share this exact (u,v) grid, so
// blending between them is a per-vertex lerp with no topology change — the
// idle ball IS the open border, just two different readings of the same mesh.
const U_SEGS = 18;
const V_SEGS = 110;
const VERT_COUNT = U_SEGS * V_SEGS;

function buildIndices(): Uint32Array {
  const idx: number[] = [];
  for (let vi = 0; vi < V_SEGS; vi++) {
    for (let ui = 0; ui < U_SEGS; ui++) {
      const a = vi * U_SEGS + ui;
      const b = vi * U_SEGS + ((ui + 1) % U_SEGS);
      const c = ((vi + 1) % V_SEGS) * U_SEGS + ui;
      const d = ((vi + 1) % V_SEGS) * U_SEGS + ((ui + 1) % U_SEGS);
      idx.push(a, b, d, a, d, c);
    }
  }
  return new Uint32Array(idx);
}

// One continuous glossy liquid-metal mesh. At rest it's a wobbling sphere
// (UV-sphere parametrization). Open, the SAME vertex grid is re-read as a
// tube swept around the chat panel's rounded-rect perimeter — so it's a
// literal shape morph of one solid surface, not a fade between two objects,
// and it always renders as continuous metal, never as discrete dots.
// Recomputed every frame from the container's LIVE pixel size, so the border
// stays glued to the modal's edges throughout the framer-motion layout morph.
function LiquidMorphMesh({ isOpen, hovered }: { isOpen: boolean; hovered: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.MeshPhysicalMaterial>(null);
  const geometryRef = useRef<THREE.BufferGeometry>(null);
  const morphRef = useRef(0);

  const indices = useMemo(() => buildIndices(), []);
  const positions = useMemo(() => new Float32Array(VERT_COUNT * 3), []);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    const { width, height } = state.size;

    const target = isOpen ? 1 : 0;
    morphRef.current += (target - morphRef.current) * 0.07;
    const morph = morphRef.current;

    // Idle: a wobbling ellipsoid sized to fill the whole pill (not just a
    // small ball floating inside it) — per-axis radii, not a uniform sphere.
    const irx = width * 0.48;
    const iry = height * 0.46;
    const irz = Math.min(width, height) * 0.46;
    const spin = t * 0.22 + (hovered && !isOpen ? t * 0.18 : 0);
    const bob = Math.sin(t * 0.9) * height * 0.015;

    // Open: a tube swept around the panel's rounded-rect edge, inset so it
    // reads as a frame around the whole chat, not just the top.
    const ow = Math.max(width / 2 - 22, 1);
    const oh = Math.max(height / 2 - 22, 1);
    const rad = Math.min(30, ow, oh);
    const tubeR = THREE.MathUtils.clamp(Math.min(width, height) * 0.022, 6, 11);

    const geom = geometryRef.current;
    if (!geom) return;
    const posAttr = geom.getAttribute("position") as THREE.BufferAttribute;

    for (let vi = 0; vi < V_SEGS; vi++) {
      const v = vi / V_SEGS;

      const [px, py] = roundedRectPoint(v, ow, oh, rad);
      const [px2, py2] = roundedRectPoint(v + 0.0025, ow, oh, rad);
      let tx = px2 - px;
      let ty = py2 - py;
      const tlen = Math.hypot(tx, ty) || 1;
      tx /= tlen;
      ty /= tlen;
      const nx = -ty;
      const ny = tx;

      const theta = v * Math.PI * 2 + spin;

      for (let ui = 0; ui < U_SEGS; ui++) {
        const u = ui / U_SEGS;
        const i = vi * U_SEGS + ui;

        // idle: UV-sphere direction, scaled per-axis into an ellipsoid that
        // fills the pill, with a gentle liquid wobble on top.
        const phi = u * Math.PI;
        const dirX = Math.sin(phi) * Math.cos(theta);
        const dirY = Math.cos(phi);
        const dirZ = Math.sin(phi) * Math.sin(theta);
        const idleWob = 1 + Math.sin(t * 1.6 + hash(i) * 20) * 0.045 * (hovered && !isOpen ? 2.4 : 1);
        const ix = dirX * irx * idleWob;
        const iy = dirY * iry * idleWob + bob;
        const iz = dirZ * irz * idleWob;

        // open: tube cross-section around the path point
        const angle = u * Math.PI * 2;
        const wob = 1 + Math.sin(t * 2.1 + hash(i) * 10) * 0.06;
        const ox = px + nx * Math.cos(angle) * tubeR * wob;
        const oy = py + ny * Math.cos(angle) * tubeR * wob;
        const oz = Math.sin(angle) * tubeR * wob;

        posAttr.setXYZ(
          i,
          THREE.MathUtils.lerp(ix, ox, morph),
          THREE.MathUtils.lerp(iy, oy, morph),
          THREE.MathUtils.lerp(iz, oz, morph),
        );
      }
    }
    posAttr.needsUpdate = true;
    geom.computeVertexNormals();
  });

  return (
    <mesh ref={meshRef}>
      <bufferGeometry ref={geometryRef} index={new THREE.BufferAttribute(indices, 1)}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <meshPhysicalMaterial
        ref={materialRef}
        color="#eef0f5"
        metalness={1}
        roughness={0.12}
        iridescence={1}
        iridescenceIOR={1.3}
        iridescenceThicknessRange={[100, 400]}
        clearcoat={1}
        clearcoatRoughness={0.15}
        envMapIntensity={1.4}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// Keeps the orthographic camera's frustum locked to the container's live CSS
// pixel size every frame, so 1 three.js unit = 1 px and the shapes above can
// be authored directly in pixel coordinates without any manual camera math.
function PixelPerfectRig() {
  const { camera, size } = useThree();
  useFrame(() => {
    // Three.js cameras are inherently mutable objects updated imperatively
    // every frame — that's the whole R3F rendering model, not a React state
    // update, so the render-purity lint rule doesn't apply here.
    /* eslint-disable react-hooks/immutability */
    const cam = camera as THREE.OrthographicCamera;
    if (cam.left === -size.width / 2 && cam.right === size.width / 2) return;
    cam.left = -size.width / 2;
    cam.right = size.width / 2;
    cam.top = size.height / 2;
    cam.bottom = -size.height / 2;
    cam.near = 1;
    cam.far = 2000;
    cam.updateProjectionMatrix();
    /* eslint-enable react-hooks/immutability */
  });
  return null;
}

// A metal material needs light reflected from EVERY direction to read as
// solid all the way around a curved surface — a handful of point lights only
// lights the sides facing them, leaving the rest looking "cut off" (patchy
// dark gaps in the loop). Real HDR environment presets need a CDN fetch that
// doesn't reliably happen in every hosting/sandbox context, so this bakes a
// small procedural room (walls + soft lights) into a reflection cubemap
// entirely on-device — same trick used in three.js's own physical-material
// examples, zero network requests.
function LocalEnvironment() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const envTexture = pmrem.fromScene(RoomEnvironment(), 0.04).texture;
    // A Three.js scene's `environment` slot is an imperative render-target
    // assignment (like camera mutation elsewhere in this file), not React
    // state — the purity rule doesn't apply to this escape hatch.
    /* eslint-disable react-hooks/immutability */
    scene.environment = envTexture;
    /* eslint-enable react-hooks/immutability */
    pmrem.dispose();
    return () => {
      envTexture.dispose();
      scene.environment = null;
    };
  }, [gl, scene]);
  return null;
}

function BlobScene({ isOpen, hovered }: { isOpen: boolean; hovered: boolean }) {
  return (
    <Canvas
      orthographic
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      camera={{ position: [0, 0, 500], zoom: 1 }}
    >
      <PixelPerfectRig />
      <LocalEnvironment />
      <ambientLight intensity={0.3} />
      <pointLight position={[250, 300, 400]} intensity={2_000_000} color="#ffffff" />
      <LiquidMorphMesh isOpen={isOpen} hovered={hovered} />
    </Canvas>
  );
}

export default function LiquidChatButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

  return (
    <motion.div
      layout
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      transition={{ type: "spring", stiffness: 260, damping: 28 }}
      className={cn(
        "relative overflow-hidden",
        isOpen ? "h-[560px] w-[400px] rounded-[32px]" : "h-[64px] w-[200px] rounded-full cursor-pointer",
      )}
    >
      {/* The morphing liquid-metal mesh — persists across states, always
          covering the full container so the border hugs the live edges. */}
      <div className="absolute inset-0">
        <BlobScene isOpen={isOpen} hovered={hovered} />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {!isOpen ? (
          <motion.button
            key="idle"
            type="button"
            onClick={() => setIsOpen(true)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 flex items-center justify-center text-[16px] font-medium text-white"
          >
            <span className="font-display drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]">
              Let&apos;s start <em className="italic">HUNT</em>
            </span>
          </motion.button>
        ) : (
          <motion.div
            key="chat"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, delay: 0.15 }}
            className="absolute inset-0"
          >
            {/* Inset content panel — leaves a margin all around so the
                liquid border stays visible on every edge, not just the top. */}
            <div className="absolute inset-[30px] flex flex-col overflow-hidden rounded-[20px] bg-[#0b0b10]">
              <div className="flex justify-end p-2">
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setIsOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col font-body">
                <ConversationPanel />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

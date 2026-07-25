"use client";

import { useCallback, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment } from "@react-three/drei";
import * as THREE from "three";
import type { WebGLProgramParametersWithUniforms } from "three";
import { AnimatePresence, motion } from "framer-motion";
import { Send, Sparkles, X } from "lucide-react";
import { twMerge } from "tailwind-merge";

function cn(...classes: Array<string | false | null | undefined>) {
  return twMerge(classes.filter(Boolean).join(" "));
}

// Ashima/Stefan Gustavson simplex 3D noise — public-domain, self-contained
// (no external noise texture or import). Drives the vertex displacement below.
const SIMPLEX_NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x){return x - floor(x * (1.0/289.0)) * 289.0;}
vec4 mod289(vec4 x){return x - floor(x * (1.0/289.0)) * 289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

// The liquid-metal sphere. Deformation is injected into MeshPhysicalMaterial's
// own vertex shader via onBeforeCompile, so it keeps full PBR lighting
// (metalness/roughness/iridescence/clearcoat) instead of being a bespoke
// unlit shader — the "high-end metallic liquid" look depends on real
// image-based lighting from <Environment>, not a hand-rolled BRDF.
function LiquidBlob({ hovered }: { hovered: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null);
  // A plain mutable escape hatch for the render loop (like meshRef below) —
  // useRef, not useMemo, so the React Compiler's immutability check doesn't
  // flag useFrame mutating it every frame (that's the whole point of R3F's
  // imperative uniform-update pattern).
  const uniformsRef = useRef({ uTime: { value: 0 }, uIntensity: { value: 0.12 } });

  const handleBeforeCompile = useCallback((shader: WebGLProgramParametersWithUniforms) => {
    const uniforms = uniformsRef.current;
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uIntensity = uniforms.uIntensity;
    shader.vertexShader =
      `uniform float uTime;\nuniform float uIntensity;\n${SIMPLEX_NOISE_GLSL}\n` +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        float n = snoise(position * 1.6 + uTime * 0.35);
        transformed += normal * n * uIntensity;`,
      );
  }, []);

  useFrame((state, delta) => {
    const t = state.clock.getElapsedTime();
    const mesh = meshRef.current;
    if (mesh) {
      mesh.rotation.y += delta * 0.25;
      mesh.rotation.x = Math.sin(t * 0.3) * 0.15;
      mesh.position.y = Math.sin(t * 0.9) * 0.12;
    }
    const uniforms = uniformsRef.current;
    uniforms.uTime.value = t;
    const target = hovered ? 0.55 : 0.12;
    uniforms.uIntensity.value += (target - uniforms.uIntensity.value) * 0.08;
  });

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1, 128, 128]} />
      <meshPhysicalMaterial
        onBeforeCompile={handleBeforeCompile}
        color="#eef0f5"
        metalness={1}
        roughness={0.12}
        iridescence={1}
        iridescenceIOR={1.3}
        iridescenceThicknessRange={[100, 400]}
        clearcoat={1}
        clearcoatRoughness={0.15}
        envMapIntensity={1.6}
      />
    </mesh>
  );
}

function BlobScene({ hovered }: { hovered: boolean }) {
  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      camera={{ position: [0, 0, 3], fov: 40 }}
    >
      <ambientLight intensity={0.5} />
      <pointLight position={[3, 3, 4]} intensity={40} />
      <Environment preset="city" />
      <LiquidBlob hovered={hovered} />
    </Canvas>
  );
}

interface ChatMessage {
  id: string;
  role: "agent" | "user";
  text: string;
}

let idCounter = 0;
const nextId = () => `msg${++idCounter}`;

// Self-contained demo conversation — no backend call. Swap `respond()` for a
// real fetch to /api/chat (or wherever the agent lives) to wire this in.
function respond(userText: string): string {
  return `You said: "${userText}". This is a UI proof-of-concept — plug in the real agent response here.`;
}

export default function LiquidChatButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: nextId(), role: "agent", text: "Hey! Ask me anything." },
  ]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    const userMsg: ChatMessage = { id: nextId(), role: "user", text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setTimeout(() => {
      setMessages((prev) => [...prev, { id: nextId(), role: "agent", text: respond(text) }]);
    }, 500);
  }, [input]);

  return (
    <motion.div
      layout
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      transition={{ type: "spring", stiffness: 260, damping: 28 }}
      className={cn(
        "relative overflow-hidden shadow-2xl ring-1 ring-white/10",
        isOpen ? "h-[520px] w-[400px] rounded-[28px]" : "h-[60px] w-[180px] rounded-full cursor-pointer",
      )}
      style={{ background: "#0b0b10" }}
    >
      {/* Blob canvas — persists across states, resized by the parent's layout
          animation from a full-cover pill background to a header strip. */}
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 260, damping: 28 }}
        className={cn("absolute inset-x-0 top-0", isOpen ? "h-[150px]" : "h-full")}
      >
        <BlobScene hovered={hovered} />
      </motion.div>

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
            className="absolute inset-0 flex items-center justify-center gap-2 text-[15px] font-semibold text-white"
          >
            <Sparkles size={16} className="drop-shadow" />
            <span className="drop-shadow">Ask AI</span>
          </motion.button>
        ) : (
          <motion.div
            key="chat"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, delay: 0.1 }}
            className="absolute inset-0 flex flex-col"
          >
            {/* Header sits on top of the blob's header-strip region */}
            <div className="flex h-[150px] items-end justify-between p-4">
              <span className="text-[17px] font-semibold text-white drop-shadow">Ask AI</span>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setIsOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur hover:bg-white/25"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 space-y-2.5 overflow-y-auto bg-[#0b0b10] px-4 py-3">
              {messages.map((m) => (
                <div key={m.id} className={cn("flex", m.role === "agent" ? "justify-start" : "justify-end")}>
                  <div
                    className={cn(
                      "max-w-[80%] rounded-2xl px-3.5 py-2 text-[14px] leading-snug",
                      m.role === "agent" ? "bg-zinc-800 text-zinc-100" : "bg-indigo-500 text-white",
                    )}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2 border-t border-white/10 bg-[#0b0b10] p-3">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder="Message"
                className="flex-1 rounded-full bg-zinc-800 px-4 py-2 text-[14px] text-white placeholder:text-zinc-500 focus:outline-none"
              />
              <button
                type="button"
                aria-label="Send"
                onClick={send}
                disabled={!input.trim()}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-500 text-white disabled:opacity-40"
              >
                <Send size={16} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

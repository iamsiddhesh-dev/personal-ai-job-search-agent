"use client";

import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import ConversationPanel from "@/components/chat/ConversationPanel";
import GrassFrame from "./GrassFrame";
import BlossomBorder from "./BlossomBorder";

interface HuntChatFrameProps {
  onBack: () => void;
  reducedMotion: boolean;
}

export default function HuntChatFrame({ onBack, reducedMotion }: HuntChatFrameProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Temporary A/B: round 1's grass vs the woodcut blossom branch. Delete this
  // state and the header control once one is picked.
  const [borderStyle, setBorderStyle] = useState<"blossom" | "grass">("blossom");

  return (
    // The root must never be translated: it is full-width, so animating `x`
    // on it pushes the document wider than the viewport and the page lands
    // horizontally scrolled. The slide lives on the inner box instead, which
    // is narrower than the viewport and gets clipped cleanly.
    <motion.div
      // `overflow-clip`, not `overflow-hidden`: the border deliberately bleeds
      // past the panel, so this box's scrollWidth exceeds its clientWidth.
      // `hidden` still allows *programmatic* scrolling, and the browser scrolls
      // sideways to reveal the focused composer input — which is what shunted
      // the whole scene left on arrival. `clip` forbids scrolling outright.
      className="flex h-dvh w-full items-center justify-center overflow-clip bg-ink"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
    >
      {/* Padding must be >= the border's BLEED or the frame clips — but it
          also has to fit: panel width + padding stays under 100vw on phones. */}
      <motion.div
        className="relative p-6 sm:p-11"
        initial={{ x: reducedMotion ? 0 : 64 }}
        animate={{ x: 0 }}
        transition={{ type: "spring", stiffness: 220, damping: 28 }}
      >
        {borderStyle === "blossom" ? (
          <BlossomBorder panelRef={panelRef} reduced={reducedMotion} />
        ) : (
          <GrassFrame panelRef={panelRef} reduced={reducedMotion} />
        )}

        <div
          ref={panelRef}
          // Width is derived from the padding so panel + frame always fits the
          // viewport: 2x p-6 on phones, 2x p-11 from sm up.
          className="relative flex h-[min(760px,72dvh)] w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-[28px] border border-bone/10 bg-[#0b0b10] sm:h-[min(760px,76dvh)] sm:w-[min(720px,78vw)]"
          style={
            {
              "--chat-agent-bg": "#16161c",
              "--chat-accent": "var(--color-seal)",
              "--chat-field-bg": "#121218",
            } as React.CSSProperties
          }
        >
          <div className="flex items-center justify-between border-b border-bone/10 px-4 py-3">
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to hero"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-bone/10 text-bone hover:bg-bone/20"
            >
              <ArrowLeft size={16} />
            </button>
            <span className="font-hunt text-sm font-bold uppercase tracking-[0.2em] text-bone/80">
              startHunt
            </span>
            <button
              type="button"
              onClick={() => setBorderStyle((s) => (s === "blossom" ? "grass" : "blossom"))}
              title="Switch border style"
              className="rounded-full border border-bone/15 px-2.5 py-1 font-body text-[10px] uppercase tracking-[0.15em] text-bone/50 hover:text-bone/80"
            >
              {borderStyle}
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col font-body">
            <ConversationPanel />
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

"use client";

import { useCallback, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import ConversationPanel from "@/components/chat/ConversationPanel";
import GrassFrame from "./GrassFrame";
import { AccountMenu } from "./AccountMenu";

interface HuntChatFrameProps {
  onBack: () => void;
  reducedMotion: boolean;
}

export default function HuntChatFrame({ onBack, reducedMotion }: HuntChatFrameProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Which thread the panel should OPEN. Null means "resume the most recent
  // one", which is what every normal mount wants; only "new chat" ever names a
  // specific id. Kept here rather than in the panel because the account menu —
  // a sibling, not a child — is what triggers the switch.
  const [openId, setOpenId] = useState<string | null>(null);

  // Which thread the panel is actually IN, reported back up as it changes: the
  // resumed one on mount, or the one the first turn of an empty thread created.
  // This is what "new chat" archives.
  //
  // A ref, not state, and that is the point: the panel reports this during its
  // own mount effect, so holding it in state would re-render this component,
  // hand the panel a new prop, and make its load effect run a second time.
  const activeIdRef = useRef<string | null>(null);

  const startNewChat = useCallback(async () => {
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Null on a panel nobody has typed in yet — there is simply nothing to
      // retire, and the route treats it as optional for exactly that case.
      body: JSON.stringify({ archiveId: activeIdRef.current }),
    });
    if (!res.ok) throw new Error(`new chat failed: ${res.status}`);
    const { id } = (await res.json()) as { id: string };

    // Set before the remount so the panel's own report cannot race it.
    activeIdRef.current = id;
    setOpenId(id);
  }, []);

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
        {/* The A/B against the woodcut blossom branch is settled: blossom was
            costing frames on phones and users were being told to switch away
            from it, so grass is simply the border now. */}
        <GrassFrame panelRef={panelRef} reduced={reducedMotion} />

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
            {/* The slot the border toggle vacated. AccountMenu keeps the same
                8x8 footprint even while loading, so the title stays optically
                centred against the back button. */}
            <AccountMenu onNewChat={startNewChat} />
          </div>

          <div className="flex min-h-0 flex-1 flex-col font-body">
            <ConversationPanel
              // Remounted per thread on purpose: a key change resets the
              // messages, the composer's seeded opener and the load effect in
              // one move, where clearing each by hand would leave the previous
              // thread's bubbles on screen for a frame.
              key={openId ?? "latest"}
              conversationId={openId}
              onConversationChange={(id) => {
                activeIdRef.current = id;
              }}
            />
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

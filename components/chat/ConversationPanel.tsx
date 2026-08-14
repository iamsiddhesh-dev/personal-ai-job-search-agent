"use client";

// Open-ended conversation. The old fixed 6-step script is gone: the agent
// (lib/chat/agent.ts) decides what to say and when to act, and the thread never
// reaches a terminal state — the composer stays live after results, drafts, or
// anything else, so the user can keep going indefinitely.
//
// The thread lives on the SERVER since Phase B. It used to be a useRef here,
// replayed to a stateless /api/chat every turn, which meant a refresh, a tab
// close or the back button destroyed the whole conversation. Now this component
// loads it on mount and sends only what is new. Resume upload still goes
// through /api/profile (a file can't travel in a chat message), and its outcome
// is narrated back into the thread so the agent can react to it next turn.

import { useEffect, useRef, useState } from "react";
import ChatThread from "./ChatThread";
import Composer from "./Composer";
import FollowupsBanner from "./FollowupsBanner";
import type { AttachKind, ChatMessage, RankedMatch } from "./types";

let idCounter = 0;
const nextId = () => `m${++idCounter}`;

// Pre-filled into the composer when the panel opens — the user confirms by
// hitting Enter/Send, nothing is sent automatically. Every REPLY after this is
// LLM-generated (see lib/chat/agent.ts's system prompt); this is just the seed
// that kicks off the very first turn, since there's no prior message for the
// agent to react to yet.
export const OPENER_DRAFT = "hey — i'm here, help me find startup jobs";

interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  kind: "text" | "jobs" | "meme";
  text: string;
  jobs?: RankedMatch[];
  imageUrl?: string;
  imageAlt?: string;
}

interface ConversationPanelProps {
  /**
   * Which thread to open. Null means "whichever they were last in", which is
   * what a normal mount wants. A specific id is what "new chat" passes, and is
   * why this is a prop at all: the panel used to always resume the most recent
   * thread, which after archiving one would have resumed the thread BEFORE it
   * rather than the empty one just created.
   */
  conversationId?: string | null;
  /** Reports the live thread id up, so the account menu knows what to archive. */
  onConversationChange?: (id: string | null) => void;
}

export default function ConversationPanel({
  conversationId = null,
  onConversationChange,
}: ConversationPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  // Blocks the composer until the stored thread is on screen, so a fast typer
  // cannot start a second conversation in the half-second before their first
  // one loads.
  const [loading, setLoading] = useState(true);

  // The one piece of conversation state the client still holds: which thread
  // this is. Everything in it lives in Postgres. A ref rather than state
  // because runTurn reads it in the same tick it is set — the first turn of a
  // new thread learns the id from the stream itself.
  const conversationIdRef = useRef<string | null>(conversationId);

  // Kept in a ref so the mount effect below can call it without listing it as a
  // dependency and re-running the whole thread load every time the parent
  // hands down a new closure.
  const onChangeRef = useRef(onConversationChange);
  onChangeRef.current = onConversationChange;

  // Every write to conversationIdRef goes through here, so the parent can never
  // be holding an id the panel has already moved on from.
  function setConversationId(id: string | null) {
    conversationIdRef.current = id;
    onChangeRef.current?.(id);
  }

  function pushMessage(msg: Omit<ChatMessage, "id">) {
    setMessages((prev) => [...prev, { id: nextId(), ...msg }]);
  }

  // Load the thread this panel is for: the one named by the prop, or the most
  // recent live one when there is no prop. Runs once, when the panel opens —
  // which is also what makes the back-to-hero-and-re-enter round trip work,
  // since this component unmounts with the chat stage. "New chat" remounts it
  // with a key, so this runs again for the new thread.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        let openId = conversationId;

        if (!openId) {
          const listRes = await fetch("/api/conversations");
          if (!listRes.ok) return;
          const { conversations } = (await listRes.json()) as {
            conversations: { id: string }[];
          };
          // Archived threads are already excluded server-side, so the most
          // recent live one is the one they were last in.
          openId = conversations[0]?.id ?? null;
        }
        if (!openId || cancelled) return;

        const threadRes = await fetch(`/api/conversations/${openId}`);
        if (!threadRes.ok || cancelled) return;
        const thread = (await threadRes.json()) as { messages: ThreadMessage[] };

        setConversationId(openId);
        setMessages(
          thread.messages.map((m) => ({
            id: m.id,
            role: m.role === "assistant" ? ("agent" as const) : ("user" as const),
            kind: m.kind,
            text: m.text || undefined,
            jobs: m.jobs,
            imageUrl: m.imageUrl,
            imageAlt: m.imageAlt,
          })),
        );
      } catch (err) {
        // An empty panel is a survivable failure — they can still type, and the
        // first turn will start a fresh thread. Losing the old one silently is
        // not great, so it goes in the console.
        console.error("[chat] could not load the stored conversation:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // One agent turn: send the new message, stream NDJSON events back and fold
  // them into the thread. The server appends both sides to the conversation, so
  // nothing here needs to keep a model-facing copy.
  async function runTurn(message: string, displayText?: string) {
    setBusy(true);
    setIsTyping(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conversationIdRef.current,
          message,
          ...(displayText ? { displayText } : {}),
        }),
      });
      if (!res.body) throw new Error("no response stream from /api/chat");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as {
            type: "conversation" | "status" | "jobs" | "text" | "error" | "meme";
            message?: string;
            jobs?: RankedMatch[];
            url?: string;
            alt?: string;
            caption?: string;
            memeId?: string;
            conversationId?: string;
          };

          if (event.type === "conversation" && event.conversationId) {
            // Sent once, on the turn that created the thread. Without it the
            // next message would start another one.
            setConversationId(event.conversationId);
          } else if (event.type === "status") {
            // Internal instrumentation (which pipeline stage is running, candidate
            // counts, etc.) — never a UI concern. The typing indicator already
            // communicates "working on it" without exposing implementation detail.
          } else if (event.type === "jobs" && event.jobs) {
            setIsTyping(false);
            pushMessage({ role: "agent", kind: "jobs", jobs: event.jobs });
          } else if (event.type === "meme" && event.url) {
            setIsTyping(false);
            pushMessage({
              role: "agent",
              kind: "meme",
              imageUrl: event.url,
              imageAlt: event.alt,
              text: event.caption,
            });
          } else if (event.type === "text" && event.message) {
            setIsTyping(false);
            pushMessage({ role: "agent", kind: "text", text: event.message });
          } else if (event.type === "error" && event.message) {
            // Already written in the agent's voice by lib/chat/errors.ts, with
            // the real error left in the server log. Render it as-is: prefixing
            // it turns a normal-sounding line back into a crash report.
            setIsTyping(false);
            pushMessage({ role: "agent", kind: "text", text: event.message });
          }
        }
      }
    } catch (err) {
      // Network-level failure, so there is no server-authored line to show —
      // stay in voice here too rather than printing a fetch error.
      console.error("[chat] turn request failed:", err);
      pushMessage({
        role: "agent",
        kind: "text",
        text: "lost you there — connection dropped. try that again?",
      });
    } finally {
      setIsTyping(false);
      setBusy(false);
    }
  }

  async function handleSubmit(value: string) {
    pushMessage({ role: "user", kind: "text", text: value });
    await runTurn(value);
  }

  // Resume upload. Parsed server-side, then the result is narrated into the
  // thread as a user turn so the agent responds to it naturally rather than the
  // UI printing a canned confirmation.
  //
  // The narration and the bubble differ, which is what `displayText` is for:
  // the model is told what was actually parsed out of the file, the user sees
  // "📎 cv.pdf". Storing both is why a reload shows the attachment again
  // instead of the "(system: …)" line the model was given.
  async function handleAttach(file: File, attachKind: AttachKind) {
    const label = attachKind === "linkedin" ? "linkedin pdf" : "resume";
    const bubble = `📎 ${file.name}`;
    pushMessage({ role: "user", kind: "text", text: bubble });
    setBusy(true);
    setIsTyping(true);

    const form = new FormData();
    form.set(attachKind, file);

    try {
      const res = await fetch("/api/profile", { method: "POST", body: form });
      const json = await res.json();
      setIsTyping(false);
      setBusy(false);

      const narration = !res.ok
        ? `(system: my ${label} upload failed — ${json.error ?? "unknown error"}. tell me what to try.)`
        : [
            `(system: i uploaded my ${label} and it parsed. here's what you extracted: ${json.playback ?? "profile built"})`,
            (json.notes ?? []).length ? `(system note: ${(json.notes as string[]).join("; ")})` : "",
            json.canSearch === false
              ? "(system note: there still isn't enough to search on — ask for whatever is missing.)"
              : "",
            // Only on a REPLACEMENT, never a first upload. The distinction is
            // made server-side, where the previous resumePath is actually
            // known; the agent cannot infer it from the parsed text.
            json.replacedResume
              ? "(system note: this REPLACED a resume they already had. offer them a clean chat — don't start one yourself.)"
              : "",
            "react to this naturally, then keep going.",
          ]
            .filter(Boolean)
            .join("\n");

      await runTurn(narration, bubble);
    } catch (err) {
      setIsTyping(false);
      setBusy(false);
      pushMessage({ role: "agent", kind: "text", text: `upload failed: ${(err as Error).message}` });
    }
  }

  return (
    <>
      <FollowupsBanner />
      <ChatThread messages={messages} isTyping={isTyping} />
      <Composer
        // Composer seeds its textarea from initialValue on FIRST render only,
        // so without a remount here the opener would never appear: the first
        // render happens while the stored thread is still loading, when there
        // is nothing to seed yet. Remounting is free — the box is empty and
        // disabled for that whole window.
        key={loading ? "loading" : "ready"}
        disabled={busy || isTyping || loading}
        initialValue={!loading && messages.length === 0 ? OPENER_DRAFT : undefined}
        onSubmit={handleSubmit}
        onAttach={handleAttach}
      />
    </>
  );
}

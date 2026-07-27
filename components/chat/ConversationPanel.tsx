"use client";

// Open-ended conversation. The old fixed 6-step script is gone: the agent
// (lib/chat/agent.ts) decides what to say and when to act, and the thread never
// reaches a terminal state — the composer stays live after results, drafts, or
// anything else, so the user can keep going indefinitely.
//
// The client owns the transcript and replays it each turn; the server is
// stateless. Resume upload still goes through /api/profile (a file can't travel
// in a chat message), and its outcome is narrated back into the thread so the
// agent can react to it on the next turn.

import { useRef, useState } from "react";
import ChatThread from "./ChatThread";
import Composer from "./Composer";
import FollowupsBanner from "./FollowupsBanner";
import type { ChatMessage, RankedMatch } from "./types";

let idCounter = 0;
const nextId = () => `m${++idCounter}`;

// Pre-filled into the composer when the panel opens — the user confirms by
// hitting Enter/Send, nothing is sent automatically. Every REPLY after this is
// LLM-generated (see lib/chat/agent.ts's system prompt); this is just the seed
// that kicks off the very first turn, since there's no prior message for the
// agent to react to yet.
export const OPENER_DRAFT = "hey — i'm here, help me find startup jobs";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

export default function ConversationPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [busy, setBusy] = useState(false);

  // The model-facing transcript, kept separate from the rendered messages:
  // job cards are UI-only, while tool outcomes we want the agent to remember
  // get pushed here as plain text. Status lines (which stage a search is in,
  // candidate counts, etc.) are internal instrumentation — they stay in the
  // server console (see runMatch's log callback) and never reach either the
  // transcript or the UI. What the user sees is only what a human would want
  // to see: the typing indicator while something runs, then the actual reply.
  const historyRef = useRef<Turn[]>([]);

  function pushMessage(msg: Omit<ChatMessage, "id">) {
    setMessages((prev) => [...prev, { id: nextId(), ...msg }]);
  }

  // One agent turn: stream NDJSON events and fold them into the thread.
  async function runTurn() {
    setBusy(true);
    setIsTyping(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: historyRef.current }),
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
            type: "status" | "jobs" | "text" | "error";
            message?: string;
            jobs?: RankedMatch[];
          };

          if (event.type === "status") {
            // Internal instrumentation (which pipeline stage is running, candidate
            // counts, etc.) — never a UI concern. The typing indicator already
            // communicates "working on it" without exposing implementation detail.
          } else if (event.type === "jobs" && event.jobs) {
            setIsTyping(false);
            pushMessage({ role: "agent", kind: "jobs", jobs: event.jobs });
          } else if (event.type === "text" && event.message) {
            setIsTyping(false);
            pushMessage({ role: "agent", kind: "text", text: event.message });
            historyRef.current.push({ role: "assistant", content: event.message });
          } else if (event.type === "error" && event.message) {
            setIsTyping(false);
            pushMessage({ role: "agent", kind: "text", text: `something broke: ${event.message}` });
          }
        }
      }
    } catch (err) {
      pushMessage({ role: "agent", kind: "text", text: `something broke: ${(err as Error).message}` });
    } finally {
      setIsTyping(false);
      setBusy(false);
    }
  }

  async function handleSubmit(value: string) {
    pushMessage({ role: "user", kind: "text", text: value });
    historyRef.current.push({ role: "user", content: value });
    await runTurn();
  }

  // Resume upload. Parsed server-side, then the result is narrated into the
  // transcript as a user turn so the agent responds to it naturally rather than
  // the UI printing a canned confirmation.
  async function handleAttach(file: File) {
    pushMessage({ role: "user", kind: "text", text: `📎 ${file.name}` });
    setBusy(true);
    setIsTyping(true);

    const form = new FormData();
    form.set("resume", file);

    try {
      const res = await fetch("/api/profile", { method: "POST", body: form });
      const json = await res.json();
      setIsTyping(false);
      setBusy(false);

      if (!res.ok) {
        historyRef.current.push({
          role: "user",
          content: `(system: my resume upload failed — ${json.error ?? "unknown error"}. tell me what to try.)`,
        });
      } else {
        const notes = (json.notes ?? []) as string[];
        historyRef.current.push({
          role: "user",
          content: [
            `(system: i uploaded my resume and it parsed. here's what you extracted: ${json.playback ?? "profile built"})`,
            notes.length ? `(system note: ${notes.join("; ")})` : "",
            "react to this naturally, then keep going.",
          ]
            .filter(Boolean)
            .join("\n"),
        });
      }
      await runTurn();
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
        disabled={busy || isTyping}
        initialValue={messages.length === 0 ? OPENER_DRAFT : undefined}
        onSubmit={handleSubmit}
        onAttach={handleAttach}
      />
    </>
  );
}

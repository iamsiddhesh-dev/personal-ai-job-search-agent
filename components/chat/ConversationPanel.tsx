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

import { useEffect, useRef, useState } from "react";
import ChatThread from "./ChatThread";
import Composer from "./Composer";
import FollowupsBanner from "./FollowupsBanner";
import type { ChatMessage, RankedMatch } from "./types";

let idCounter = 0;
const nextId = () => `m${++idCounter}`;

const OPENER =
  "hey — i'm backdoor. i help people land roles at early-stage startups.\n\nwhat's your name?";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

export default function ConversationPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [busy, setBusy] = useState(false);

  // The model-facing transcript, kept separate from the rendered messages:
  // status lines and job cards are UI-only, while tool outcomes we want the
  // agent to remember get pushed here as plain text.
  const historyRef = useRef<Turn[]>([]);
  const startedRef = useRef(false);

  useEffect(() => {
    // Strict Mode double-mounts effects in dev; without this the opener would
    // be pushed twice.
    if (startedRef.current) return;
    startedRef.current = true;
    pushMessage({ role: "agent", kind: "text", text: OPENER });
    historyRef.current.push({ role: "assistant", content: OPENER });
  }, []);

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

          if (event.type === "status" && event.message) {
            pushMessage({ role: "agent", kind: "text", text: event.message });
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
      <Composer disabled={busy || isTyping} onSubmit={handleSubmit} onAttach={handleAttach} />
    </>
  );
}

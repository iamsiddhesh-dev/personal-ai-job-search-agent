"use client";

// The real Phase-4 conversation flow (name → sources → playback → role →
// location → stage → streamed results), extracted so it can drop into any
// bounded flex-column container — the iPhone frame, the liquid-blob modal,
// or anything else — instead of being hard-wired to one shell.

import { useEffect, useRef, useState } from "react";
import ChatThread from "./ChatThread";
import Composer from "./Composer";
import SourcesForm, { type SourcesSubmission } from "./SourcesForm";
import type { ChatMessage, RankedMatch } from "./types";
import {
  locationPrefFromChip,
  roleFocusFromChip,
  teamSizeBucketFromChip,
  type StepId,
  type StepPrompt,
} from "@/lib/chat/flow";

let idCounter = 0;
const nextId = () => `m${++idCounter}`;

export default function ConversationPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState<StepPrompt | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [busy, setBusy] = useState(false);

  const nameRef = useRef("");
  const profileIdRef = useRef<string | null>(null);
  const roleFocusRef = useRef("full-stack");
  const locationPrefRef = useRef<"india" | "remote" | "anywhere">("india");
  const startedRef = useRef(false);

  useEffect(() => {
    // React's Strict Mode intentionally mounts effects twice in dev to
    // surface non-idempotent effects — without this guard the opening
    // question gets asked (and answered by the server) twice.
    if (startedRef.current) return;
    startedRef.current = true;
    advance("name");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pushMessage(msg: Omit<ChatMessage, "id">) {
    setMessages((prev) => [...prev, { id: nextId(), ...msg }]);
  }

  async function advance(step: StepId, ctx: { name?: string; playback?: string } = {}) {
    setIsTyping(true);
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, ctx }),
    });
    const next: StepPrompt = await res.json();
    await sleep(350); // brief pause reads as a real reply, not an instant dump
    setIsTyping(false);
    pushMessage({ role: "agent", kind: "text", text: next.message });
    setPrompt(next);
  }

  async function handleSourcesSubmit(data: SourcesSubmission) {
    setBusy(true);
    const shared: string[] = [];
    if (data.resumeFile) shared.push("resume");
    if (data.githubUsername.trim()) shared.push("GitHub");
    if (data.linkedinUrl.trim()) shared.push("LinkedIn");
    if (data.portfolioUrl.trim()) shared.push("portfolio");
    pushMessage({ role: "user", kind: "text", text: `Shared: ${shared.join(", ")}` });
    setPrompt(null);

    const form = new FormData();
    if (nameRef.current) form.set("name", nameRef.current);
    if (data.resumeFile) form.set("resume", data.resumeFile);
    if (data.githubUsername.trim()) form.set("githubUsername", data.githubUsername.trim());
    if (data.linkedinUrl.trim()) form.set("linkedinUrl", data.linkedinUrl.trim());
    if (data.portfolioUrl.trim()) form.set("portfolioUrl", data.portfolioUrl.trim());

    setIsTyping(true);
    try {
      const res = await fetch("/api/profile", { method: "POST", body: form });
      const json = await res.json();
      setIsTyping(false);
      if (!res.ok) {
        pushMessage({ role: "agent", kind: "text", text: `Something went wrong: ${json.error ?? "unknown error"}` });
        setPrompt({ step: "sources", message: "", inputMode: "sources" });
        return;
      }
      profileIdRef.current = json.profileId;
      for (const note of json.notes ?? []) {
        pushMessage({ role: "agent", kind: "text", text: note });
      }
      setBusy(false);
      await advance("playback", { playback: json.playback });
    } catch (err) {
      setIsTyping(false);
      setBusy(false);
      pushMessage({ role: "agent", kind: "text", text: `Upload failed: ${(err as Error).message}` });
      setPrompt({ step: "sources", message: "", inputMode: "sources" });
    }
  }

  async function handleSubmit(value: string) {
    if (!prompt) return;
    pushMessage({ role: "user", kind: "text", text: value });

    switch (prompt.step) {
      case "name": {
        nameRef.current = value;
        setPrompt(null);
        await advance("sources", { name: value });
        return;
      }
      case "playback": {
        setPrompt(null);
        if (value.startsWith("Let me add more")) {
          await advance("sources", { name: nameRef.current });
        } else {
          await advance("role");
        }
        return;
      }
      case "role": {
        roleFocusRef.current = roleFocusFromChip(value);
        setPrompt(null);
        await advance("location");
        return;
      }
      case "location": {
        locationPrefRef.current = locationPrefFromChip(value);
        setPrompt(null);
        await advance("stage");
        return;
      }
      case "stage": {
        const teamSizeBucket = teamSizeBucketFromChip(value);
        setPrompt(null);
        await runSearch(teamSizeBucket);
        return;
      }
      default:
        return;
    }
  }

  async function runSearch(teamSizeBucket: "lt10" | "10-50" | "50-200" | "any") {
    setBusy(true);
    setIsTyping(true);
    pushMessage({ role: "agent", kind: "text", text: "On it — searching the job database…" });

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: profileIdRef.current,
          roleFocus: roleFocusRef.current,
          locationPref: locationPrefRef.current,
          teamSizeBucket,
        }),
      });

      if (!res.body) throw new Error("No response stream from /api/run");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastStatus = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as
            | { type: "status"; message: string }
            | { type: "result"; jobs: RankedMatch[] }
            | { type: "error"; message: string };

          if (event.type === "status" && event.message !== lastStatus) {
            lastStatus = event.message;
            pushMessage({ role: "agent", kind: "text", text: event.message });
          } else if (event.type === "result") {
            setIsTyping(false);
            pushMessage({
              role: "agent",
              kind: "text",
              text: `Here are ${event.jobs.length} ranked openings:`,
            });
            pushMessage({ role: "agent", kind: "jobs", jobs: event.jobs });
          } else if (event.type === "error") {
            setIsTyping(false);
            pushMessage({ role: "agent", kind: "text", text: `Search failed: ${event.message}` });
          }
        }
      }
    } catch (err) {
      setIsTyping(false);
      pushMessage({ role: "agent", kind: "text", text: `Search failed: ${(err as Error).message}` });
    } finally {
      setIsTyping(false);
      setBusy(false);
      setPrompt({ step: "run", message: "", inputMode: "none" });
    }
  }

  const showSourcesForm = prompt?.inputMode === "sources" && !busy;

  return (
    <>
      <ChatThread messages={messages} isTyping={isTyping} />
      {showSourcesForm && <SourcesForm onSubmit={handleSourcesSubmit} disabled={busy} />}
      <Composer
        mode={prompt?.inputMode ?? "none"}
        chips={prompt?.chips}
        placeholder={prompt?.placeholder}
        disabled={busy || isTyping || !prompt}
        onSubmit={handleSubmit}
      />
    </>
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

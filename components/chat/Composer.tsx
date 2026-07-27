"use client";

import { useRef, useState } from "react";

// Always-on composer for the open-ended conversation. There is no "input mode"
// any more — the thread never reaches a terminal step, so the box is only ever
// disabled while a reply is in flight.
export default function Composer({
  disabled,
  initialValue,
  onSubmit,
  onAttach,
}: {
  disabled: boolean;
  initialValue?: string;
  onSubmit: (value: string) => void;
  onAttach: (file: File) => void;
}) {
  const [value, setValue] = useState(initialValue ?? "");
  const fileRef = useRef<HTMLInputElement>(null);

  const send = (v: string) => {
    const trimmed = v.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue("");
  };

  return (
    <div className="border-t border-white/10 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.txt,application/pdf,text/plain"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onAttach(file);
            // Reset so picking the same file twice still fires onChange.
            e.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--chat-field-bg,#3f3f46)] text-[17px] text-white disabled:opacity-40"
          aria-label="Attach resume"
          title="Attach resume (PDF, DOCX, TXT)"
        >
          +
        </button>
        <input
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(value)}
          placeholder="Message"
          className="flex-1 rounded-full bg-[var(--chat-field-bg,#3f3f46)] px-4 py-2 text-[15px] text-white placeholder:text-zinc-400 focus:outline-none disabled:opacity-40"
        />
        <button
          disabled={disabled || !value.trim()}
          onClick={() => send(value)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--chat-accent,#0b84ff)] text-white disabled:opacity-40"
          aria-label="Send"
        >
          ↑
        </button>
      </div>
    </div>
  );
}

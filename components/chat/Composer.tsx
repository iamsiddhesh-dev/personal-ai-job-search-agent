"use client";

import { useState } from "react";
import type { InputMode } from "./types";

export default function Composer({
  mode,
  chips,
  placeholder,
  disabled,
  onSubmit,
}: {
  mode: InputMode;
  chips?: string[];
  placeholder?: string;
  disabled: boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  if (mode === "none" || mode === "sources") return null;

  const send = (v: string) => {
    const trimmed = v.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue("");
  };

  return (
    <div className="border-t border-white/10 px-3 py-2.5">
      {mode === "chips" && chips && chips.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <button
              key={chip}
              disabled={disabled}
              onClick={() => send(chip)}
              className="rounded-full bg-zinc-700 px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
            >
              {chip}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(value)}
          placeholder={placeholder ?? "Message"}
          className="flex-1 rounded-full bg-zinc-700 px-4 py-2 text-[15px] text-white placeholder:text-zinc-400 focus:outline-none disabled:opacity-40"
        />
        <button
          disabled={disabled || !value.trim()}
          onClick={() => send(value)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0b84ff] text-white disabled:opacity-40"
          aria-label="Send"
        >
          ↑
        </button>
      </div>
    </div>
  );
}

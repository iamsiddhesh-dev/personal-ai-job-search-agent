"use client";

import { useEffect, useRef, useState } from "react";
import type { AttachKind } from "./types";

// Always-on composer for the open-ended conversation. There is no "input mode"
// any more — the thread never reaches a terminal step, so the box is only ever
// disabled while a reply is in flight.
//
// The field is a textarea, not an input: an <input> is a single-line element
// that cannot wrap, so a long message scrolled sideways and hid its own start.
// It auto-grows with the content up to a cap, then scrolls internally.
export default function Composer({
  disabled,
  initialValue,
  onSubmit,
  onAttach,
}: {
  disabled: boolean;
  initialValue?: string;
  onSubmit: (value: string) => void;
  onAttach: (file: File, kind: AttachKind) => void;
}) {
  const [value, setValue] = useState(initialValue ?? "");
  const [menuOpen, setMenuOpen] = useState(false);
  // Which upload the picker is currently collecting. A LinkedIn PDF export and
  // a resume are parsed the same way but stored in different columns, so the
  // choice has to be made before the file dialog opens.
  const [kind, setKind] = useState<AttachKind>("resume");
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Height must be reset before measuring: scrollHeight only ever grows against
  // an explicit height, so without the reset the box can never shrink back.
  const resize = () => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  // Covers the seeded opener and the reset after send, both of which change
  // `value` without a keystroke.
  useEffect(resize, [value]);

  const send = (v: string) => {
    const trimmed = v.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue("");
  };

  return (
    <div className="border-t border-white/10 px-3 py-2.5">
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          accept={kind === "linkedin" ? ".pdf,application/pdf" : ".pdf,.docx,.txt,application/pdf,text/plain"}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onAttach(file, kind);
            // Reset so picking the same file twice still fires onChange.
            e.target.value = "";
          }}
        />
        <div className="relative shrink-0">
          {menuOpen && (
            <>
              {/* Click-away layer, so the menu closes without a document listener. */}
              <button
                type="button"
                aria-label="Close attach menu"
                className="fixed inset-0 z-10 cursor-default"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute bottom-11 left-0 z-20 w-44 overflow-hidden rounded-2xl border border-white/10 bg-[var(--chat-agent-bg,#3f3f46)] text-[14px] text-white shadow-lg">
                <button
                  type="button"
                  className="block w-full px-3.5 py-2.5 text-left hover:bg-white/10"
                  onClick={() => {
                    setKind("resume");
                    setMenuOpen(false);
                    fileRef.current?.click();
                  }}
                >
                  resume
                </button>
                <button
                  type="button"
                  className="block w-full border-t border-white/10 px-3.5 py-2.5 text-left hover:bg-white/10"
                  onClick={() => {
                    setKind("linkedin");
                    setMenuOpen(false);
                    fileRef.current?.click();
                  }}
                >
                  linkedin pdf
                </button>
              </div>
            </>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--chat-field-bg,#3f3f46)] text-[17px] text-white disabled:opacity-40"
            aria-label="Attach a file"
            aria-expanded={menuOpen}
            title="Attach a resume or LinkedIn PDF export"
          >
            +
          </button>
        </div>
        <textarea
          ref={textRef}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(value);
            }
          }}
          placeholder="Message"
          className="scroll-slim flex-1 resize-none overflow-y-auto rounded-3xl bg-[var(--chat-field-bg,#3f3f46)] px-4 py-2 text-[15px] text-white placeholder:text-zinc-400 focus:outline-none disabled:opacity-40 max-h-32"
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

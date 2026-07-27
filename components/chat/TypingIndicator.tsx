export default function TypingIndicator() {
  return (
    <div className="flex justify-start px-3">
      <div className="flex items-center gap-1 rounded-[18px] rounded-bl-[4px] bg-[var(--chat-agent-bg,#3f3f46)] px-4 py-3">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-300"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
    </div>
  );
}

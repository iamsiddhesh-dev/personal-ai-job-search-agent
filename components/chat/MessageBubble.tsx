import type { ChatMessage } from "./types";
import JobCard from "./JobCard";

export default function MessageBubble({ message }: { message: ChatMessage }) {
  const isAgent = message.role === "agent";

  if (message.kind === "jobs" && message.jobs) {
    return (
      <div className="flex flex-col gap-2 px-3">
        {message.jobs.map((job) => (
          <JobCard key={job.jobId} job={job} />
        ))}
      </div>
    );
  }

  // Plain <img>, not next/image: Klipy serves these from a remote host and
  // next.config.ts declares no images.remotePatterns, so the optimizer would
  // reject the URL outright.
  if (message.kind === "meme" && message.imageUrl) {
    return (
      <div className="flex justify-start px-3">
        <div className="max-w-[78%] overflow-hidden rounded-[18px] rounded-bl-[4px] bg-[var(--chat-agent-bg,#3f3f46)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={message.imageUrl}
            alt={message.imageAlt ?? "meme"}
            loading="lazy"
            className="block max-h-64 w-full max-w-[220px] object-cover"
          />
          {message.text && (
            <p className="px-3.5 py-2 text-[15px] leading-snug text-white">{message.text}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex px-3 ${isAgent ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[78%] whitespace-pre-wrap rounded-[18px] px-3.5 py-2 text-[15px] leading-snug ${
          isAgent
            ? "rounded-bl-[4px] bg-[var(--chat-agent-bg,#3f3f46)] text-white"
            : "rounded-br-[4px] bg-[var(--chat-accent,#0b84ff)] text-white"
        }`}
      >
        {message.text}
      </div>
    </div>
  );
}

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

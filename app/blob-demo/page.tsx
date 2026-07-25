import LiquidChatButton from "@/components/LiquidChatButton";

// Standalone proof-of-concept route for the liquid metallic blob chat button.
// Not part of the real conversation flow yet — see components/LiquidChatButton.tsx.
export default function BlobDemoPage() {
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-zinc-950">
      <LiquidChatButton />
    </div>
  );
}

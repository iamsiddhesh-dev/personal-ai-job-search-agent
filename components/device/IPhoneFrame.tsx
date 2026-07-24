"use client";

import { useEffect, useState } from "react";

// Pure CSS/SVG iPhone 15 Pro frame (393x852 logical points), scaled to fit the
// viewport height. No images or external assets — bezel, Dynamic Island, and
// side buttons are all drawn with CSS. Below ~640px the chrome drops away
// entirely and `children` render full-bleed (REVISED-PLAN §8 Phase 4:
// "nobody should see a fake iPhone inside a real iPhone").
//
// IMPORTANT: `children` is mounted exactly ONCE. An earlier version rendered
// two separate JSX copies of `children` (one per breakpoint, toggled with
// `hidden`/`block`) — that silently double-mounts the whole chat tree (two
// independent state instances, two sets of API calls), since React treats two
// JSX usages of the same element as two separate component instances. All
// responsiveness here is CSS-only on a single mounted tree.
export default function IPhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-zinc-100 p-4 dark:bg-zinc-950 max-[639px]:bg-white max-[639px]:p-0 max-[639px]:dark:bg-black">
      <div className="relative shrink-0 rounded-none bg-zinc-900 p-0 shadow-2xl min-[640px]:rounded-[62px] min-[640px]:p-[14px]">
        {/* Side buttons — decorative, hidden below 640px */}
        <div className="absolute -left-[2px] top-[120px] hidden h-[32px] w-[3px] rounded-l-sm bg-zinc-800 min-[640px]:block" />
        <div className="absolute -left-[2px] top-[170px] hidden h-[62px] w-[3px] rounded-l-sm bg-zinc-800 min-[640px]:block" />
        <div className="absolute -left-[2px] top-[242px] hidden h-[62px] w-[3px] rounded-l-sm bg-zinc-800 min-[640px]:block" />
        <div className="absolute -right-[2px] top-[190px] hidden h-[90px] w-[3px] rounded-r-sm bg-zinc-800 min-[640px]:block" />

        <div
          className="relative h-dvh w-screen overflow-hidden rounded-none bg-black
                     min-[640px]:h-[min(852px,calc(100dvh-32px))] min-[640px]:w-[min(393px,calc((100dvh-32px)*0.4613))]
                     min-[640px]:rounded-[48px]"
        >
          <div className="hidden min-[640px]:block">
            <StatusBar />
            <DynamicIsland />
          </div>
          <div className="absolute inset-0 flex flex-col min-[640px]:pt-[54px]">{children}</div>
          <div className="hidden min-[640px]:block">
            <HomeIndicator />
          </div>
        </div>
      </div>
    </div>
  );
}

function DynamicIsland() {
  return (
    <div className="absolute left-1/2 top-[12px] z-20 h-[32px] w-[110px] -translate-x-1/2 rounded-full bg-black ring-1 ring-zinc-800" />
  );
}

function HomeIndicator() {
  return (
    <div className="absolute bottom-[8px] left-1/2 z-20 h-[5px] w-[134px] -translate-x-1/2 rounded-full bg-white/80" />
  );
}

function StatusBar() {
  const [time, setTime] = useState<string | null>(null);

  useEffect(() => {
    const update = () =>
      setTime(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    update();
    const id = setInterval(update, 1000 * 15);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="absolute inset-x-0 top-0 z-20 flex h-[54px] items-end justify-between px-9 pb-[10px] text-[15px] font-semibold text-white">
      <span suppressHydrationWarning>{time ?? ""}</span>
      <div className="flex items-center gap-1.5">
        <SignalIcon />
        <WifiIcon />
        <BatteryIcon />
      </div>
    </div>
  );
}

function SignalIcon() {
  return (
    <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor">
      <rect x="0" y="7" width="3" height="5" rx="0.5" />
      <rect x="5" y="5" width="3" height="7" rx="0.5" />
      <rect x="10" y="3" width="3" height="9" rx="0.5" />
      <rect x="15" y="0" width="3" height="12" rx="0.5" />
    </svg>
  );
}

function WifiIcon() {
  return (
    <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor">
      <path d="M8 10.5a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8Zm-3.2-3.6a4.6 4.6 0 0 1 6.4 0l-1.1 1.1a3 3 0 0 0-4.2 0L4.8 6.9Zm-2.6-2.6a8.4 8.4 0 0 1 11.6 0L12.7 5.4a6.4 6.4 0 0 0-9.4 0L2.2 4.3Z" />
    </svg>
  );
}

function BatteryIcon() {
  return (
    <svg width="25" height="12" viewBox="0 0 25 12" fill="none">
      <rect x="0.5" y="0.5" width="21" height="11" rx="2.5" stroke="currentColor" opacity="0.4" />
      <rect x="2" y="2" width="18" height="8" rx="1.5" fill="currentColor" />
      <rect x="22.5" y="4" width="1.5" height="4" rx="0.75" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

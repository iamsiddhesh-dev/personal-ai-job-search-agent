// Self-hosted (not a runtime CDN fetch) via next/font/local — keeps the
// REVISED-PLAN.md ₹0-cost / no-external-dependency spirit and avoids a
// Fontshare CDN round-trip on every page load. Files downloaded once from
// Fontshare (Indian Type Foundry, free for commercial use) into ../fonts.
import localFont from "next/font/local";

export const cabinetGrotesk = localFont({
  src: [
    { path: "../fonts/CabinetGrotesk-Regular.woff2", weight: "400", style: "normal" },
    { path: "../fonts/CabinetGrotesk-Medium.woff2", weight: "500", style: "normal" },
    { path: "../fonts/CabinetGrotesk-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-cabinet-grotesk",
  display: "swap",
});

export const ranade = localFont({
  src: [
    { path: "../fonts/Ranade-Regular.woff2", weight: "400", style: "normal" },
    { path: "../fonts/Ranade-Medium.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-ranade",
  display: "swap",
});

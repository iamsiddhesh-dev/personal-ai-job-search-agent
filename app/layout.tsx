import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { cabinetGrotesk, ranade, bespokeSlab } from "@/lib/fonts";
import GoogleAuthRetry from "@/components/hunt/GoogleAuthRetry";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "startHunt",
  description: "Your hiring-consultant agent for early-stage startup roles.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${cabinetGrotesk.variable} ${ranade.variable} ${bespokeSlab.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* Must be mounted regardless of which screen is showing — see the
            component's own comment for why this cannot live inside
            AccountMenu. */}
        <GoogleAuthRetry />
        {children}
        {/* Page-view tracking only — collects no PII, sends nothing about a
            user's chat, resume or search. Vercel's own middleware endpoint
            handles the beacon; no env var or project id needed here. */}
        <Analytics />
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "marketingmagic",
  description: "Auto-generated posting plans, hybrid-approval auto-posting, data-driven theme iteration.",
  // PWA-installable on mobile for Phase 2.6 Founder Mode (`/record` is the
  // start_url). Declaring the manifest here makes the install banner
  // available across the whole app, not only the record route — which is
  // intentional, since other Founder Mode surfaces (the transcript editor,
  // the queue review) live elsewhere in the app shell.
  manifest: "/manifest.webmanifest",
};

export const viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}

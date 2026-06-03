import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

// Brand typeface. Friendly, modern, geometric sans — reads as a polished SaaS
// product rather than the default system stack. Self-hosted + swap by next/font.
const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "marketingmagic",
  description: "Auto-generated posting plans, hybrid-approval auto-posting, data-driven theme iteration.",
  // PWA-installable on mobile for Phase 2.6 Founder Mode (`/record` is the
  // start_url). Declaring the manifest here makes the install banner
  // available across the whole app, not only the record route — which is
  // intentional, since other Founder Mode surfaces (the transcript editor,
  // the queue review) live elsewhere in the app shell.
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16.png", type: "image/png", sizes: "16x16" },
      { url: "/icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180" }],
  },
};

export const viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={sans.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}

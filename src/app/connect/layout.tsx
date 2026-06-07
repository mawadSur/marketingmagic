import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "../globals.css";

// The client self-connect surface is a standalone, unauthenticated page — like
// the client portal (/client/[token]) it deliberately does NOT use the (app)
// layout (no nav, no workspace switcher, no auth). It gets its own minimal
// shell so the agency's white-label branding fills the whole frame.
//
// Mirror the root layout's font wiring exactly (--font-sans variable on <html>,
// font-sans on <body>). Without it the server rendered `font-sans` and the
// client didn't, producing a hydration className mismatch on this route.
const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "Connect your accounts",
  robots: { index: false, follow: false },
};

export default function ClientConnectLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={sans.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">{children}</body>
    </html>
  );
}

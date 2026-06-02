import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "../globals.css";

// Authenticated CLIENT portal (migration 037). A standalone shell — it does NOT
// use the agency (app) layout (no nav, no workspace switcher, no agency chrome),
// mirroring the tokenized /client portal. Every page underneath gates on the
// authed session + a client_membership; there is nothing here a non-client can
// reach (the page redirects them out).
const sans = Plus_Jakarta_Sans({ subsets: ["latin"], display: "swap", variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Your report",
  robots: { index: false, follow: false },
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={sans.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">{children}</body>
    </html>
  );
}

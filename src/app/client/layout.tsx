import type { Metadata } from "next";
import "../globals.css";

// The client portal is a standalone, unauthenticated surface — it deliberately
// does NOT use the (app) layout (no nav, no workspace switcher, no auth). It
// gets its own minimal shell so the white-label branding fills the whole frame.
export const metadata: Metadata = {
  title: "Client portal",
  robots: { index: false, follow: false },
};

export default function ClientPortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background antialiased">{children}</body>
    </html>
  );
}

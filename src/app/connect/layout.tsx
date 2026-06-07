import type { Metadata } from "next";
import "../globals.css";

// The client self-connect surface is a standalone, unauthenticated page — like
// the client portal (/client/[token]) it deliberately does NOT use the (app)
// layout (no nav, no workspace switcher, no auth). It gets its own minimal
// shell so the agency's white-label branding fills the whole frame.
export const metadata: Metadata = {
  title: "Connect your accounts",
  robots: { index: false, follow: false },
};

export default function ClientConnectLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background antialiased">{children}</body>
    </html>
  );
}

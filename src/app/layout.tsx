import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "marketingmagic",
  description: "Auto-generated posting plans, hybrid-approval auto-posting, data-driven theme iteration.",
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

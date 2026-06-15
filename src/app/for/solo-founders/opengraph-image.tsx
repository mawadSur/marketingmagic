import { ImageResponse } from "next/og";
import {
  OG_ACCENT_EMERALD,
  OG_ACCENT_MINT,
  OG_BG_GRADIENT,
  OG_TEXT_MUTED,
  OG_TEXT_PRIMARY,
} from "@/lib/design-tokens";

// Static Open Graph card for /for/solo-founders. Next picks this up by
// convention, so a pasted link unfurls as a branded image. No data lookup, so
// this stays on the default (Edge) runtime and is fully static.
export const alt = "Social media on autopilot for solo founders — marketingmagic";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: OG_BG_GRADIENT,
          color: OG_TEXT_PRIMARY,
          padding: "64px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 30, color: OG_ACCENT_MINT }}>
          <div style={{ width: 14, height: 14, borderRadius: 9999, background: OG_ACCENT_EMERALD }} />
          marketingmagic
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 30, color: OG_TEXT_MUTED }}>For solo founders &amp; build-in-public</div>
          <div style={{ fontSize: 72, fontWeight: 700, lineHeight: 1.05 }}>
            You&apos;re building a company, not a content calendar.
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, color: OG_TEXT_MUTED }}>
          <span>Build-in-public posts + AI video, in your voice</span>
          <span>marketingmagic.app/start</span>
        </div>
      </div>
    ),
    { ...size },
  );
}

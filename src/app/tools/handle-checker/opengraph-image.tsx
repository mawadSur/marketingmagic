import { ImageResponse } from "next/og";
import {
  OG_ACCENT_EMERALD,
  OG_ACCENT_MINT,
  OG_BG_GRADIENT,
  OG_TEXT_MUTED,
  OG_TEXT_PRIMARY,
} from "@/lib/design-tokens";

// Static Open Graph card for the free handle-checker tool, so a pasted link
// unfurls as a branded image. Same token palette as /p/<slug>. No data lookup —
// this surface is identical for every visitor, so the card is static.
export const alt = "Free social handle checker — is your brand name available across all 8 platforms?";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PLATFORM_LABELS = [
  "X",
  "Instagram",
  "TikTok",
  "YouTube",
  "Bluesky",
  "Threads",
  "Facebook",
  "LinkedIn",
];

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
        <div
          style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 30, color: OG_ACCENT_MINT }}
        >
          <div style={{ width: 14, height: 14, borderRadius: 9999, background: OG_ACCENT_EMERALD }} />
          marketingmagic
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 30, color: OG_TEXT_MUTED }}>Free social handle checker</div>
          <div style={{ fontSize: 70, fontWeight: 700, lineHeight: 1.05, maxWidth: 980 }}>
            Is your brand name available everywhere?
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8 }}>
            {PLATFORM_LABELS.map((label) => (
              <div
                key={label}
                style={{
                  display: "flex",
                  fontSize: 24,
                  color: OG_TEXT_PRIMARY,
                  border: `2px solid ${OG_ACCENT_EMERALD}`,
                  borderRadius: 9999,
                  padding: "6px 20px",
                }}
              >
                {label}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, color: OG_TEXT_MUTED }}>
          <span>Check all 8 in one search · no signup</span>
          <span>marketingmagic</span>
        </div>
      </div>
    ),
    { ...size },
  );
}

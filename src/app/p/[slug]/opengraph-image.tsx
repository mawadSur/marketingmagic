import { ImageResponse } from "next/og";
import { getPreviewShare } from "@/lib/growth/preview-share";
import { channelLabel } from "@/components/ui/badge";
import {
  OG_ACCENT_EMERALD,
  OG_ACCENT_MINT,
  OG_BG_GRADIENT,
  OG_TEXT_MUTED,
  OG_TEXT_PRIMARY,
  OG_TEXT_SNIPPET,
} from "@/lib/design-tokens";

// Dynamic Open Graph card for a shared preview plan. Next picks this up by
// convention for /p/<slug>, so a pasted link unfurls as a branded image:
// "Here's the content plan marketingmagic made for @brand". Runs on the Node.js
// runtime (not Edge) because the share lookup goes through getPreviewShare,
// which uses the service-role Supabase client + node:crypto — both Node-only.
export const alt = "A content plan made by marketingmagic";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OgImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const share = await getPreviewShare(slug);

  const handle = share ? `@${share.handle}` : "your brand";
  const channel = share ? channelLabel(share.channel) : "social";
  const postCount = share?.plan.posts.length ?? 7;
  // First post text gives the card a real, voice-faithful preview snippet.
  const snippet = share?.plan.posts[0]?.text?.replace(/\s+/g, " ").slice(0, 160) ?? "";

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
          <div style={{ fontSize: 30, color: OG_TEXT_MUTED }}>
            {`A ${postCount}-post ${channel} plan, written in`}
          </div>
          <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05 }}>
            {`${handle}'s voice`}
          </div>
          {snippet ? (
            <div
              style={{
                display: "flex",
                marginTop: 12,
                fontSize: 28,
                lineHeight: 1.4,
                color: OG_TEXT_SNIPPET,
                borderLeft: `4px solid ${OG_ACCENT_EMERALD}`,
                paddingLeft: 24,
              }}
            >
              {snippet}
              {snippet.length >= 160 ? "…" : ""}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, color: OG_TEXT_MUTED }}>
          <span>Made in ~30 seconds · no signup</span>
          <span>marketingmagic.app/start</span>
        </div>
      </div>
    ),
    { ...size },
  );
}

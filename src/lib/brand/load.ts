// Brand-consistent visuals — workspace BrandStyle loader.
//
// I/O wrapper around the pure projectBrandStyle (style.ts). Loads a workspace's
// brand_briefs row + (when the workspace is under an org) the org's white-label
// branding, then projects them to a single BrandStyle that BOTH the image and
// video generators consume.
//
// GRACEFUL BY DESIGN: any missing row, missing org, or query error resolves to
// EMPTY_BRAND_STYLE (no fragment), so a brand lookup can NEVER block or change
// generation behaviour for a workspace with no brand identity set. Brand
// styling is strictly additive — a DB hiccup degrades to today's generic prompt,
// it never throws into the generation path.

import { supabaseService } from "@/lib/supabase/service";
import { projectBrandStyle, type BrandStyle } from "@/lib/brand/style";

// A workspace with no resolvable brand identity. Returned on every miss/error so
// callers can rely on a value (never null) and append nothing to their prompt.
export const EMPTY_BRAND_STYLE: BrandStyle = {
  colors: [],
  visualTone: null,
  voiceHint: null,
  hasLogo: false,
  subjectContext: null,
};

type ServiceClient = ReturnType<typeof supabaseService>;

// Load + project a workspace's BrandStyle. The service-role client defaults to
// the shared cached singleton; callers that already hold one (queue actions)
// pass it in to avoid a second lookup, and tests pass a stub. NEVER throws — a
// failure resolves to EMPTY_BRAND_STYLE so the generation path is unaffected.
export async function loadBrandStyle(
  workspaceId: string,
  svc: ServiceClient = supabaseService(),
): Promise<BrandStyle> {
  try {
    // brand_briefs is 1:1 with workspace (workspace_id unique). maybeSingle so a
    // workspace with no brief resolves to null rather than throwing.
    const { data: brief } = await svc
      .from("brand_briefs")
      .select("voice, voice_profile, product_description, target_audience")
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    // Org branding is optional: only workspaces under an organization have one,
    // and only org owners who set white-label colours/logo populate it.
    const { data: ws } = await svc
      .from("workspaces")
      .select("organization_id")
      .eq("id", workspaceId)
      .maybeSingle();

    let colorPrimary: string | null = null;
    let colorAccent: string | null = null;
    let logoUrl: string | null = null;
    if (ws?.organization_id) {
      const { data: org } = await svc
        .from("organizations")
        .select("color_primary, color_accent, logo_url")
        .eq("id", ws.organization_id)
        .maybeSingle();
      colorPrimary = org?.color_primary ?? null;
      colorAccent = org?.color_accent ?? null;
      logoUrl = org?.logo_url ?? null;
    }

    return projectBrandStyle({
      voice: brief?.voice ?? null,
      voiceProfile: brief?.voice_profile ?? null,
      productDescription: brief?.product_description ?? null,
      targetAudience: brief?.target_audience ?? null,
      colorPrimary,
      colorAccent,
      logoUrl,
    });
  } catch (err) {
    // Brand styling must never break generation — log and fall back to generic.
    console.warn(
      `loadBrandStyle failed for workspace ${workspaceId}; using generic (un-branded) generation:`,
      err instanceof Error ? err.message : err,
    );
    return EMPTY_BRAND_STYLE;
  }
}

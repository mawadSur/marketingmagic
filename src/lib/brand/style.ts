// Brand-consistent visuals — shared BrandStyle projection.
//
// SINGLE SOURCE OF TRUTH for "what does this workspace's brand look like" when
// generating visuals. BOTH the image generator (src/lib/images) and the video
// generators (src/lib/video) consume the SAME projection so an auto-generated
// image and an auto-generated video for the same workspace stay on-brand
// together instead of drifting.
//
// The projection reads ONLY existing fields — no migration:
//   • brand_briefs.voice            → visual tone hint (free-form brand voice).
//   • brand_briefs.voice_profile    → formality / emoji_usage → tone descriptor.
//   • brand_briefs.product_description / target_audience → subject context.
//   • organizations.color_primary   → primary brand colour (white-label, mig 033).
//   • organizations.color_accent    → accent brand colour.
//   • organizations.logo_url        → presence drives a "logo-safe" instruction.
//
// SAFETY / NO-REGRESSION CONTRACT: when a workspace has NO brand identity set
// (the common case for a fresh workspace), projectBrandStyle returns an empty
// style and brandStyleToPromptFragment returns "" — so callers append nothing
// and fall back BYTE-FOR-BYTE to today's generic prompt. Brand styling is
// strictly ADDITIVE.

import type { VoiceProfile } from "@/lib/db/types";

// Hex-colour guard. Generated-image prompts are not an injection surface the way
// an inline style attribute is, but we still only let validated #rgb / #rrggbb
// through so we never feed arbitrary brand-brief text into a model prompt as if
// it were a colour. Mirrors the portal/branding.ts posture.
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function safeHex(value: string | null | undefined): string | null {
  if (value && HEX_RE.test(value.trim())) return value.trim();
  return null;
}

// Trim + collapse whitespace + cap length so a pathological brand-brief field
// can't blow up a model prompt. Returns null for empty/whitespace input.
function cleanText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const t = value.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max).trimEnd() : t;
}

// The brand identity projected for visual generation. Every field is optional:
// an all-empty BrandStyle (isEmptyBrandStyle) means "no brand identity set" and
// yields no prompt fragment.
export interface BrandStyle {
  // Validated hex brand colours (#rgb / #rrggbb), in priority order.
  colors: string[];
  // A short descriptor of the visual/typographic tone (e.g. "polished and
  // professional", "relaxed and approachable"), derived from voice_profile.
  visualTone: string | null;
  // Free-form brand voice text the user wrote, lightly cleaned. Gives the model
  // extra brand flavour beyond the tone descriptor.
  voiceHint: string | null;
  // Whether the workspace has a logo on file. We never embed the logo into the
  // generated frame (the model can't reproduce it faithfully); instead its
  // presence adds a "leave clean space for a logo overlay" instruction so the
  // composited result stays on-brand.
  hasLogo: boolean;
  // Short subject context (product + audience) so generated visuals depict the
  // right kind of scene, not a generic stock image.
  subjectContext: string | null;
}

// The raw inputs projectBrandStyle reads. Kept as a plain shape (not the DB Row
// types) so the projection is pure and trivially unit-testable without a DB.
export interface BrandStyleInputs {
  // brand_briefs fields.
  voice?: string | null;
  voiceProfile?: VoiceProfile | null;
  productDescription?: string | null;
  targetAudience?: string | null;
  // organizations white-label fields (migration 033). Null when the workspace
  // is not under an org or the org has no branding set.
  colorPrimary?: string | null;
  colorAccent?: string | null;
  logoUrl?: string | null;
}

// Map a voice_profile's formality + emoji usage to a visual-tone descriptor.
// Formality drives the core adjective; heavy emoji usage nudges toward
// "playful". Returns null when there's no voice_profile to read.
function toneFromVoiceProfile(vp: VoiceProfile | null | undefined): string | null {
  if (!vp) return null;
  const base =
    vp.formality === "formal"
      ? "polished and professional"
      : vp.formality === "casual"
        ? "relaxed and approachable"
        : "clean and modern";
  if (vp.emoji_usage === "frequent") return `${base}, playful and energetic`;
  return base;
}

// Project raw brand inputs into a BrandStyle. PURE — no I/O. Gracefully yields an
// empty style (isEmptyBrandStyle === true) when nothing brand-y is set, which is
// the fresh-workspace default and produces the current generic behaviour.
export function projectBrandStyle(inputs: BrandStyleInputs): BrandStyle {
  const colors: string[] = [];
  const primary = safeHex(inputs.colorPrimary);
  const accent = safeHex(inputs.colorAccent);
  if (primary) colors.push(primary);
  if (accent && accent !== primary) colors.push(accent);

  const voiceHint = cleanText(inputs.voice, 240);
  const visualTone = toneFromVoiceProfile(inputs.voiceProfile);

  const product = cleanText(inputs.productDescription, 180);
  const audience = cleanText(inputs.targetAudience, 120);
  const subjectContext =
    product && audience
      ? `${product} (for ${audience})`
      : (product ?? (audience ? `audience: ${audience}` : null));

  return {
    colors,
    visualTone,
    voiceHint,
    hasLogo: Boolean(inputs.logoUrl && inputs.logoUrl.trim()),
    subjectContext,
  };
}

// True when a BrandStyle carries no brand signal at all — callers use this to
// short-circuit to today's generic prompt (no fragment appended).
export function isEmptyBrandStyle(style: BrandStyle): boolean {
  return (
    style.colors.length === 0 &&
    !style.visualTone &&
    !style.voiceHint &&
    !style.hasLogo &&
    !style.subjectContext
  );
}

// Project a BrandStyle to a prompt fragment appended to image/video prompts.
// Returns "" for an empty style so the caller's prompt is unchanged (no
// regression). The fragment is phrased as styling guidance, NOT as the subject,
// so it refines rather than replaces the caller's prompt.
//
// Shared by BOTH generators so the same brand reads identically across an
// image and a video.
export function brandStyleToPromptFragment(style: BrandStyle): string {
  if (isEmptyBrandStyle(style)) return "";

  const parts: string[] = [];
  if (style.colors.length > 0) {
    parts.push(`brand colour palette ${style.colors.join(", ")}`);
  }
  if (style.visualTone) {
    parts.push(`${style.visualTone} visual style`);
  }
  if (style.voiceHint) {
    parts.push(`brand voice: ${style.voiceHint}`);
  }
  if (style.subjectContext) {
    parts.push(`subject context: ${style.subjectContext}`);
  }
  if (style.hasLogo) {
    // We don't ask the model to draw the logo (it can't reproduce it); we ask
    // it to leave room so a real logo can be overlaid downstream.
    parts.push("leave clean, uncluttered negative space for a logo overlay");
  }

  return `On-brand styling — ${parts.join("; ")}.`;
}

// Compose a caller's base prompt with the brand fragment. Convenience used by
// both generators so the join (and the empty-fragment passthrough) lives in one
// place. When the style is empty the base prompt is returned untouched.
export function applyBrandStyleToPrompt(basePrompt: string, style: BrandStyle): string {
  const fragment = brandStyleToPromptFragment(style);
  if (!fragment) return basePrompt;
  const base = basePrompt.trim();
  return base ? `${base}\n\n${fragment}` : fragment;
}

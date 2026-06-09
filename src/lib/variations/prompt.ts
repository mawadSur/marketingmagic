import type { VoiceProfile } from "@/lib/db/types";

// ─────────────────────────────────────────────────────────────
// Hook×body variation prompt builder (Hormozi organic-first slice #3)
// ─────────────────────────────────────────────────────────────
//
// Builds the system + user prompts that ask Claude for N distinct HOOKS and
// M distinct BODIES from ONE source post/concept. The cross product (N×M) is
// assembled in code (schema.ts:assembleVariations) — the prompt's job is to
// make each hook and each body genuinely different, and to encode the Hormozi
// ORGANIC mechanic so the output reads native, not as an ad.
//
// The organic mechanic (from docs/designs/hormozi-video-strategy-review.md —
// reframed paid-ads → organic):
//   • HOOK-FIRST: the first ~3s is the whole game. Lead with the payoff/tension.
//   • VARIED VISUAL + SPOKEN hooks: vary BOTH what's said AND what's on screen
//     (the pattern interrupt), not just the words.
//   • TEXT-OVERLAY CTA, never spoken: a spoken "link in bio" reads as an ad; an
//     overlay reads as organic.
//   • ORGANIC-NATIVE feel: talk-to-camera, no stock-footage-over-voiceover (the
//     single most algorithmically-flagged "this is an ad" format).
//
// NOTE: organic-FIRST. No ROAS, no scoring rubric, no synthetic audience — the
// review explicitly defers all three. This module only varies the creative.

export interface VariationSeed {
  // The source post/concept we're spinning into a matrix. `text` is the core
  // message (a clip's script, a winning post's copy, or a concept blurb);
  // `theme` keeps every variation on-message.
  text: string;
  theme: string | null;
  // Optional brand-voice context. When unset, the source text IS the voice
  // anchor (the creator wrote/approved it) — same fallback as experiments.
  voiceProfile?: VoiceProfile | null;
  productDescription?: string | null;
}

function voiceBlock(v: VoiceProfile): string {
  const lines: string[] = [
    "## Voice profile (match this register precisely)",
    v.summary,
    "",
    `- Formality: ${v.formality}`,
    `- Emoji usage: ${v.emoji_usage}`,
  ];
  if (v.opener_patterns.length > 0) {
    lines.push(
      `- Typical openers: ${v.opener_patterns.slice(0, 6).map((s) => `"${s}"`).join(", ")}`,
    );
  }
  if (v.signature_phrases.length > 0) {
    lines.push(
      `- Signature phrases: ${v.signature_phrases.slice(0, 6).map((s) => `"${s}"`).join(", ")}`,
    );
  }
  if (v.do_not_say.length > 0) {
    lines.push(`- Voice anti-patterns (never use): ${v.do_not_say.slice(0, 8).join(", ")}`);
  }
  return lines.join("\n");
}

export function variationSystemPrompt(seed: VariationSeed): string {
  const lines: string[] = [
    "You are the short-form video variation brain of marketingmagic.",
    "A creator hands you ONE source clip/post that already worked. Your job: spin it",
    "into a MATRIX of filmable variations they can shoot this week — same core message,",
    "many fresh ways in.",
    "",
    "You will commit to a set of distinct HOOKS and a set of distinct BODIES. The system",
    "assembles every hook × every body in code, so each hook and each body must stand on",
    "its own and be GENUINELY different from its siblings — not a light reword.",
    "",
    "## The organic mechanic (follow all of these)",
    "- HOOK-FIRST. The first ~3 seconds decide everything. Open on the payoff, the tension,",
    "  or the contrarian claim — never a slow warm-up or a greeting.",
    "- Vary the VISUAL hook and the SPOKEN hook independently. The visual is the on-screen",
    "  pattern interrupt (a gesture, a prop, a hard cut, on-screen text); the spoken is the",
    "  first line said to camera. Two variations can share a spoken angle but must look",
    "  different on screen, and vice versa.",
    "- The CTA is a TEXT OVERLAY, never spoken. A spoken \"link in bio / DM me\" reads as an",
    "  ad and tanks organic reach. Put the ask on screen instead.",
    "- ORGANIC-NATIVE feel. Write talk-to-camera scripts a real person films on a phone.",
    "  No stock-footage-over-voiceover, no announcer cadence, no ad polish — that format is",
    "  the most heavily flagged \"this is an ad\" on every platform.",
    "- Keep the underlying claim and theme fixed. Do NOT invent new facts or a new offer.",
  ];
  if (seed.theme) {
    lines.push("");
    lines.push(`## Theme (every variation stays inside this): ${seed.theme}`);
  }
  if (seed.productDescription) {
    lines.push("");
    lines.push("## Product context");
    lines.push(seed.productDescription);
  }
  if (seed.voiceProfile) {
    lines.push("");
    lines.push(voiceBlock(seed.voiceProfile));
  }
  return lines.join("\n");
}

export function variationUserPrompt(
  seed: VariationSeed,
  hookCount: number,
  bodyCount: number,
): string {
  return [
    "Here is the source clip/post that already worked:",
    "",
    "<<<SOURCE",
    seed.text,
    "SOURCE",
    "",
    `Produce exactly ${hookCount} HOOKS and exactly ${bodyCount} BODIES.`,
    "",
    "Each HOOK is a {spoken, visual} pair:",
    "- spoken: the first line said to camera (≤ ~1 sentence). Hook-first — lead with the payoff.",
    "- visual: what is ON SCREEN in the opening shot — the pattern interrupt. Concrete and filmable.",
    `All ${hookCount} hooks must be meaningfully different from each other in angle AND in shot.`,
    "",
    "Each BODY is a {spoken, cta_overlay} pair:",
    "- spoken: the payload after the hook — the point, the proof, the turn. Same core claim,",
    "  different path through it. Talk-to-camera, no spoken CTA.",
    "- cta_overlay: a SHORT on-screen text CTA (≤ ~8 words). Never a spoken instruction.",
    `All ${bodyCount} bodies must take a different route through the same message.`,
    "",
    "Call submit_variation_matrix exactly once. No prose outside the tool call.",
  ].join("\n");
}

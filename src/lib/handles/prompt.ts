// Handle-finder — prompts for the brandable-handle generator.
//
// Asks Opus for short, memorable, cross-platform-friendly usernames. The hard
// constraint baked into the prompt: produce handles that can EXIST on every
// major platform (so we don't generate a 40-char name that only works on
// LinkedIn). The strictest common shape across our eight platforms is roughly
// "lowercase letters + digits, optionally a single separator, ~15 chars" — X is
// the tightest at 15 chars and no dots/dashes, so we steer toward that.

import type { HandleSeed } from "./schema";

export function handleSystemPrompt(): string {
  return [
    "You are a brand-naming specialist who picks social media handles (usernames).",
    "Your job: propose short, memorable, on-brand handles a new creator/business can use.",
    "",
    "HARD RULES for every handle you propose:",
    "- lowercase only; letters and digits; an OPTIONAL single underscore as a separator.",
    "- NO spaces, NO dots, NO dashes, NO leading/trailing separators, NO emoji.",
    "- 3 to 15 characters (so it fits even the strictest platform, X).",
    "- Must be pronounceable / typeable from memory. Avoid number-soup and l33t-speak.",
    "- Avoid obvious trademarks of unrelated big brands.",
    "",
    "Aim for a SPREAD: some literal (close to the brand name), some inventive/coined,",
    "some niche-descriptive. Each needs a one-line rationale (why it works as a handle).",
    "Call the tool exactly once with all candidates.",
  ].join("\n");
}

export function handleUserPrompt(seed: HandleSeed, count: number): string {
  const lines: string[] = [`Propose exactly ${count} distinct handle candidates.`];

  if (seed.seed?.trim()) {
    lines.push(`Build them around this brand/word: "${seed.seed.trim()}".`);
  }
  if (seed.productDescription?.trim()) {
    lines.push(`What the brand does: ${seed.productDescription.trim()}`);
  }
  if (seed.targetAudience?.trim()) {
    lines.push(`Audience: ${seed.targetAudience.trim()}`);
  }
  if (seed.voice?.trim()) {
    lines.push(`Brand voice/tone: ${seed.voice.trim()}`);
  }
  if (lines.length === 1) {
    // No context at all — let the model pick a versatile, generic-but-brandable set.
    lines.push("No brand details were given — propose versatile, brandable handles.");
  }

  lines.push(
    "Return short handles that obey every hard rule. Spread them across literal, coined, and descriptive styles.",
  );
  return lines.join("\n");
}

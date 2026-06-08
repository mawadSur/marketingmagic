// Auto-tag generation + persistence layer (migration 052).
//
// Given a post's text + channel + the workspace's voice/brand brief, this
// produces a normalized tag set ready to store in posts.tags. It is the
// GENERATION half of the system — distinct from src/lib/hashtags, which is
// the recommendation HISTORY half (014) and never auto-applies.
//
// Design:
//   • Channel policy is the hard gate. We read src/lib/hashtags/rules.ts —
//     the single source of truth for "how many tags belong on this channel."
//     Channels where tags don't belong (Bluesky; X by default) get an EMPTY
//     tag set with NO LLM call. We never exceed recommendedCount[1].
//   • The LLM (Opus 4.8, maxRetries 6 — same wrapper as every other call
//     site, see src/lib/groups/generate.ts) proposes tags from the post body
//     + voice; we re-normalize + re-cap on our side so a misbehaving model
//     can never write an over-cap or malformed tag.
//   • Optional blend: callers may pass the recency-weighted recommender's
//     output (recommendHashtags) so workspace-proven tags get priority over
//     freshly-invented ones, still subject to the channel cap.
//
// The pure helpers (normalizeTags / tagBoundsForChannel / mergeAndCap) carry
// no I/O so they're unit-tested directly; generateTags() is the thin LLM
// orchestration around them.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import type { Database, VoiceProfile } from "@/lib/db/types";
import type { ChannelId } from "@/lib/channels/registry";
import { getChannelHashtagPolicy } from "@/lib/hashtags/rules";

const MODEL = "claude-opus-4-8";

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

type Brief = Database["public"]["Tables"]["brand_briefs"]["Row"];

// Absolute ceiling regardless of channel policy. Matches the posts.tags / DB
// expectations and the setPostHashtagsAction list cap (014). The channel
// policy's max is almost always far lower; this is the hard backstop.
const HARD_MAX_TAGS = 30;
const MAX_TAG_LENGTH = 100; // matches the CHECK in migrations 014 + 052

export interface GenerateTagsInputs {
  // The post body the tags should describe. Inline #hashtags already present
  // in the body are folded into the candidate set (post-normalization).
  text: string;
  channel: ChannelId;
  // Voice/brand context — used to bias tags toward the brand's niche. Either
  // a full brief or just the product description is fine; both optional.
  brief?: Pick<Brief, "product_description" | "voice_profile"> | null;
  // Optional recency-weighted recommendations from the existing recommender
  // (recommendHashtags → suggestion.tag). When provided, these are blended in
  // with priority over LLM-invented tags (workspace history is a stronger
  // signal than a cold guess), still subject to the channel cap.
  recommended?: string[];
}

// ─────────────────────────────────────────────────────────────
// Pure helpers (no I/O — unit-tested directly)
// ─────────────────────────────────────────────────────────────

/**
 * Normalize a raw tag list to the storage contract:
 *   - trim, strip every leading '#'
 *   - lowercase
 *   - ASCII letter/digit/underscore only (anything else drops the tag —
 *     matches src/lib/hashtags/extract.ts so we never store a tag a platform
 *     would silently reject)
 *   - drop empties and anything over MAX_TAG_LENGTH
 *   - dedupe, preserving first-seen order
 */
export function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string") continue;
    const t = r.trim().replace(/^#+/, "").toLowerCase();
    if (t.length === 0 || t.length > MAX_TAG_LENGTH) continue;
    if (!/^[a-z0-9_]+$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export interface TagBounds {
  // Whether this channel takes tags at all. False for Bluesky.
  enabled: boolean;
  // Soft target (the channel policy's recommendedCount[0]). The generator
  // aims for this; the user can add/remove freely afterward.
  target: number;
  // Hard cap (channel policy max, clamped to HARD_MAX_TAGS).
  max: number;
}

/**
 * Resolve the per-channel tag bounds from the hashtag policy. This is the
 * single gate that makes "0 tags for channels where tags don't belong" true:
 *   - Bluesky: showChips=false        → enabled:false, max:0
 *   - X: recommendedCount [0,1]        → target:0, max:1 (default empty)
 *   - everything else: policy as-is.
 */
export function tagBoundsForChannel(channel: ChannelId): TagBounds {
  const policy = getChannelHashtagPolicy(channel);
  const [min, max] = policy.recommendedCount;
  const cappedMax = Math.min(max, HARD_MAX_TAGS);
  if (!policy.showChips || cappedMax === 0) {
    return { enabled: false, target: 0, max: 0 };
  }
  return { enabled: true, target: Math.max(0, Math.min(min, cappedMax)), max: cappedMax };
}

/**
 * Merge candidate sets in priority order, normalize, dedupe, and cap to the
 * channel max. `recommended` (workspace-proven) comes first so it survives
 * the cap ahead of LLM-invented tags. Returns [] when the channel takes no
 * tags.
 */
export function mergeAndCap(
  channel: ChannelId,
  recommended: string[],
  llmTags: string[],
): string[] {
  const bounds = tagBoundsForChannel(channel);
  if (!bounds.enabled) return [];
  const merged = normalizeTags([...recommended, ...llmTags]);
  return merged.slice(0, bounds.max);
}

// ─────────────────────────────────────────────────────────────
// LLM tool + prompt
// ─────────────────────────────────────────────────────────────

const tagsSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(MAX_TAG_LENGTH)).max(HARD_MAX_TAGS),
});

const TAGS_TOOL = {
  name: "submit_tags",
  description:
    "Submit the generated tags for this post. Call exactly once. Each tag is a " +
    "single hashtag word WITHOUT the leading '#', lowercase, letters/digits/" +
    "underscore only (no spaces, no punctuation). Pick tags that genuinely fit " +
    "the post and the brand's niche — fewer, relevant tags beat more, generic ones.",
  input_schema: {
    type: "object",
    required: ["tags"],
    properties: {
      tags: {
        type: "array",
        minItems: 0,
        maxItems: HARD_MAX_TAGS,
        items: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TAG_LENGTH,
          description:
            "A single hashtag word, no leading '#', lowercase, [a-z0-9_] only.",
        },
      },
    },
    additionalProperties: false,
  },
} as const;

function systemPrompt(channel: ChannelId, bounds: TagBounds): string {
  const policy = getChannelHashtagPolicy(channel);
  return [
    "You generate hashtags for social-media posts. Tags must fit the post AND the brand's niche.",
    "",
    "Hard rules:",
    `- Channel: ${channel}. ${policy.notes}`,
    `- Return between ${bounds.target} and ${bounds.max} tags. NEVER exceed ${bounds.max}.`,
    "- Each tag: lowercase, no leading '#', letters/digits/underscore only (no spaces, no punctuation, no emoji).",
    "- Prefer specific, audience-relevant tags over mega-broad ones. Fewer relevant tags beat more generic ones.",
    "- If no tag genuinely fits, return an empty list. Do not pad to hit the range.",
    "- Output only via the submit_tags tool. No prose.",
  ].join("\n");
}

function userPrompt(inputs: GenerateTagsInputs): string {
  const blocks: string[] = [];
  if (inputs.brief?.product_description) {
    blocks.push(`## Brand / product\n${inputs.brief.product_description}`);
  }
  const voice = inputs.brief?.voice_profile as VoiceProfile | null | undefined;
  if (voice?.vocabulary_signature) {
    blocks.push(`## Voice signature\n${voice.vocabulary_signature}`);
  }
  if (inputs.recommended && inputs.recommended.length > 0) {
    blocks.push(
      `## Tags this workspace has used before (favour these when they fit)\n${inputs.recommended
        .map((t) => `#${t}`)
        .join(" ")}`,
    );
  }
  blocks.push(`## Post body\n${inputs.text}`);
  blocks.push("Call submit_tags exactly once with the tags for this post.");
  return blocks.join("\n\n");
}

// ─────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────

/**
 * Generate a normalized, channel-capped tag set for a single post.
 *
 * - Returns [] WITHOUT an LLM call for channels where tags don't belong
 *   (Bluesky; any policy with max 0).
 * - Never exceeds the channel's policy max. We re-normalize + re-cap the
 *   model's output on our side, so a misbehaving model can't break the
 *   storage contract.
 * - Blends `recommended` (workspace history) ahead of LLM-invented tags.
 *
 * Best-effort: on an LLM/transport failure we fall back to the normalized
 * recommended set (still capped), or [] — generation must never throw into
 * the plan-persistence path.
 */
export async function generateTags(inputs: GenerateTagsInputs): Promise<string[]> {
  const bounds = tagBoundsForChannel(inputs.channel);
  if (!bounds.enabled) return [];

  const recommended = normalizeTags(inputs.recommended ?? []);

  // No text to reason about → fall back to capped recommendations only.
  if (!inputs.text || inputs.text.trim().length === 0) {
    return mergeAndCap(inputs.channel, recommended, []);
  }

  let llmTags: string[] = [];
  try {
    const response = await client().messages.create({
      model: MODEL,
      max_tokens: 512,
      system: [
        {
          type: "text",
          text: systemPrompt(inputs.channel, bounds),
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [TAGS_TOOL],
      tool_choice: { type: "tool", name: "submit_tags" },
      messages: [{ role: "user", content: userPrompt({ ...inputs, recommended }) }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (toolUse && toolUse.type === "tool_use" && toolUse.name === "submit_tags") {
      const parsed = tagsSchema.safeParse(toolUse.input);
      if (parsed.success) llmTags = parsed.data.tags;
    }
  } catch (err) {
    // Generation is opportunistic — never sink the caller. Fall through to
    // the recommended-only blend below.
    console.warn("generateTags LLM call failed; falling back to recommendations:", err);
  }

  return mergeAndCap(inputs.channel, recommended, llmTags);
}

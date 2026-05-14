// Phase 6.8 — Thread builder: long-form input → structured X thread.
//
// Mirrors the tool-use forcing pattern in src/lib/plan/generate.ts and
// src/lib/voice/extract.ts: one tool with a JSON schema, tool_choice
// forces the call so we get back parseable JSON instead of prose.
//
// The output is a flat `tweets[]` array; the caller stamps per-row
// thread metadata onto each `posts` row via `ThreadRowMeta`.

import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import type { VoiceProfile } from "@/lib/db/types";
import {
  threadStructureSchema,
  type ThreadStructure,
  HOOK_MAX,
  X_TWEET_MAX,
  THREAD_MIN_TWEETS,
  THREAD_MAX_TWEETS,
} from "./schema";

const MODEL = "claude-sonnet-4-6";

// Source text gets hard-bounded before we send it. 20k chars is enough
// to fit a long-form essay (~3-4k words) without burning context, and
// past that the thread builder loses focus.
const MAX_SOURCE_CHARS = 20_000;

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY });
  return cachedClient;
}

export interface ThreadGenInput {
  // The long-form text we're turning into a thread. Required.
  sourceText: string;
  // Target tweet count. The model is told this is a hint, not a hard
  // requirement — it should pick what serves the content best. We clamp
  // to [THREAD_MIN_TWEETS, THREAD_MAX_TWEETS] on the input side too.
  targetTweetCount?: number;
  // Optional voice profile for voice-aware hook + close.
  voiceProfile?: VoiceProfile | null;
  // Free-form workspace context (product description, audience, etc).
  // Lets the model write a close with a CTA that fits the brand.
  briefContext?: {
    productDescription: string;
    targetAudience: string;
    voice: string;
  };
  // Optional CTA hint — when set, the close tweet should anchor on this.
  // E.g. "subscribe at /newsletter", "DM me 'OPS' for the playbook".
  ctaHint?: string;
}

export interface ThreadGenResult {
  thread: ThreadStructure;
  usage: { input_tokens: number; output_tokens: number };
}

const THREAD_TOOL = {
  name: "submit_thread",
  description:
    "Submit a structured X thread derived from the source text. Call this " +
    "exactly once with the full thread.",
  input_schema: {
    type: "object",
    required: ["tweets"],
    properties: {
      tweets: {
        type: "array",
        minItems: THREAD_MIN_TWEETS,
        maxItems: THREAD_MAX_TWEETS,
        items: {
          type: "object",
          required: ["tweet_number", "text", "role"],
          properties: {
            tweet_number: {
              type: "integer",
              minimum: 1,
              maximum: THREAD_MAX_TWEETS,
              description: "1-indexed position in the thread.",
            },
            text: {
              type: "string",
              minLength: 1,
              maxLength: X_TWEET_MAX,
              description: `Tweet body. Hard ${X_TWEET_MAX}-char cap. Hook (tweet 1) should be ≤${HOOK_MAX} chars.`,
            },
            role: {
              type: "string",
              enum: ["hook", "body", "close"],
              description:
                "First tweet must be 'hook'; last tweet must be 'close'; everything in between is 'body'.",
            },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
} as const;

// Hook regeneration: regenerate ONLY the first tweet. Returns the new
// hook text. The caller is responsible for writing it back to the
// matching `posts` row (tweet_index=1).
const HOOK_TOOL = {
  name: "submit_hook",
  description: "Submit a single replacement hook tweet for an existing thread.",
  input_schema: {
    type: "object",
    required: ["text"],
    properties: {
      text: {
        type: "string",
        minLength: 1,
        maxLength: HOOK_MAX,
        description: `Punchy first-tweet hook. ≤${HOOK_MAX} chars.`,
      },
    },
    additionalProperties: false,
  },
} as const;

function buildSystem(input: ThreadGenInput): string {
  const lines: string[] = [
    "You are the thread-builder brain of marketingmagic.",
    "Turn the user's long-form text into a properly-structured X thread that " +
      "sounds like the brand wrote it, not generic AI.",
    "",
    "## Thread architecture",
    `- Length: ${THREAD_MIN_TWEETS}–${THREAD_MAX_TWEETS} tweets. Pick what the content actually justifies — don't pad.`,
    `- Tweet 1 (hook): ≤${HOOK_MAX} chars. Punchy, specific, makes the reader want tweet 2.`,
    `- Tweets 2..N-1 (body): each ≤${X_TWEET_MAX} chars. One idea per tweet. No throat-clearing ("To start," "Now," etc).`,
    `- Tweet N (close): ≤${X_TWEET_MAX} chars. Always ends with a clear CTA (subscribe, reply, share, DM, link). If a CTA hint is given below, anchor on it.`,
    "- Never start a tweet with '1/', '2/', etc. The platform handles thread numbering.",
    "- Avoid carrying sentences across tweets — each tweet stands alone, even if it builds toward the next.",
    "- No hashtags. The X algorithm penalizes them; threads with tags read as automation.",
    "",
    "## Voice",
    input.briefContext
      ? `Product: ${input.briefContext.productDescription}\nAudience: ${input.briefContext.targetAudience}\nBrand voice: ${input.briefContext.voice}`
      : "(no brand brief supplied — use the voice of the source text itself)",
  ];

  if (input.voiceProfile) {
    const v = input.voiceProfile;
    lines.push("");
    lines.push("### Voice profile (match this register precisely on the hook and close)");
    lines.push(v.summary);
    lines.push(`- Formality: ${v.formality}`);
    lines.push(`- Emoji usage: ${v.emoji_usage}`);
    if (v.opener_patterns.length > 0) {
      lines.push(`- Typical openers: ${v.opener_patterns.slice(0, 6).map((s) => `"${s}"`).join(", ")}`);
    }
    if (v.signature_phrases.length > 0) {
      lines.push(`- Signature phrases (use where natural): ${v.signature_phrases.slice(0, 8).map((s) => `"${s}"`).join(", ")}`);
    }
    if (v.do_not_say.length > 0) {
      lines.push(`- Do NOT say: ${v.do_not_say.slice(0, 10).join(", ")}`);
    }
  }

  if (input.ctaHint) {
    lines.push("");
    lines.push(`## CTA hint for the close tweet\n${input.ctaHint}`);
  }

  lines.push("");
  lines.push("Call the `submit_thread` tool. Do not respond with prose.");
  return lines.join("\n");
}

function clampSource(text: string): string {
  if (text.length <= MAX_SOURCE_CHARS) return text;
  // Take the head — the tail of a long essay is usually fluff/repetition,
  // and the hook + first ideas come from the opening.
  return text.slice(0, MAX_SOURCE_CHARS) + "\n\n[truncated]";
}

export async function generateThread(input: ThreadGenInput): Promise<ThreadGenResult> {
  if (input.sourceText.trim().length === 0) {
    throw new Error("sourceText is required");
  }
  const target = Math.max(
    THREAD_MIN_TWEETS,
    Math.min(THREAD_MAX_TWEETS, input.targetTweetCount ?? 8),
  );

  const system = buildSystem(input);
  const userParts: string[] = [
    `Build an X thread from this source. Target roughly ${target} tweets (you can deviate ±3 if the content needs it).`,
    "",
    "## Source",
    clampSource(input.sourceText),
    "",
    "Call submit_thread with the full thread.",
  ];

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: [THREAD_TOOL],
    tool_choice: { type: "tool", name: "submit_thread" },
    messages: [{ role: "user", content: userParts.join("\n") }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_thread") {
    throw new Error("Claude did not call submit_thread.");
  }

  const input_obj = toolUse.input as { tweets?: unknown };
  const parsed = threadStructureSchema.safeParse(input_obj.tweets);
  if (!parsed.success) {
    throw new Error(
      `Thread validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    thread: parsed.data,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Hook-only regeneration
// ─────────────────────────────────────────────────────────────
//
// /queue exposes a "Regenerate hook" button so users can iterate on the
// opening tweet without re-doing the whole thread. We hand Claude the
// existing thread (so it knows what tweet 2 expects) and ask for a
// fresh hook only.

export interface HookRegenInput {
  // Current thread (all tweets), so Claude knows what tweet 2 needs the
  // hook to lead into.
  currentThread: ThreadStructure;
  voiceProfile?: VoiceProfile | null;
  briefContext?: ThreadGenInput["briefContext"];
}

export async function regenerateHook(input: HookRegenInput): Promise<{ text: string }> {
  if (input.currentThread.length < 2) {
    throw new Error("regenerateHook needs at least a hook + one body tweet for context");
  }

  const system = [
    "You are the thread-builder brain of marketingmagic.",
    `Rewrite ONLY the hook (first tweet) of an existing X thread. ≤${HOOK_MAX} chars.`,
    "Keep the same angle but make the hook sharper, more specific, more punchy.",
    "It must lead naturally into the existing second tweet — do not invent a setup the thread doesn't follow through on.",
    "No emoji unless the brand voice uses them. No '1/', '2/' numbering.",
    input.briefContext
      ? `\nBrand voice: ${input.briefContext.voice}`
      : "",
    input.voiceProfile
      ? `\nVoice profile: ${input.voiceProfile.summary}\nFormality: ${input.voiceProfile.formality}\nEmoji: ${input.voiceProfile.emoji_usage}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const orderedTweets = [...input.currentThread].sort((a, b) => a.tweet_number - b.tweet_number);
  const existingThreadBlock = orderedTweets
    .map((t) => `${t.tweet_number}. [${t.role}] ${t.text}`)
    .join("\n");

  const userMsg = [
    "Existing thread (the current hook is tweet 1 — rewrite it):",
    "",
    existingThreadBlock,
    "",
    "Call submit_hook with ONLY a replacement for tweet 1.",
  ].join("\n");

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: [HOOK_TOOL],
    tool_choice: { type: "tool", name: "submit_hook" },
    messages: [{ role: "user", content: userMsg }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_hook") {
    throw new Error("Claude did not call submit_hook.");
  }
  const obj = toolUse.input as { text?: unknown };
  if (typeof obj.text !== "string") {
    throw new Error("submit_hook returned no text.");
  }
  const text = obj.text.trim();
  if (text.length === 0 || text.length > HOOK_MAX) {
    throw new Error(`hook out of range (got ${text.length} chars, max ${HOOK_MAX})`);
  }
  return { text };
}

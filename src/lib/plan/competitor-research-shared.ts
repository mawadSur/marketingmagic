// Phase 7 — Shared helpers for competitor research.
//
// Types, Zod schemas, the Anthropic tool spec, and the handle normaliser/
// validator are all used by BOTH the summarise and discover branches.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import type { Database } from "@/lib/db/types";
import type { ChannelId } from "@/lib/channels/registry";

export type Brief = Database["public"]["Tables"]["brand_briefs"]["Row"];

export const MODEL = "claude-opus-4-8";

// How many cached winners to feed Claude in the summarise branch.
export const SUMMARISE_SAMPLE_LIMIT = 20;
// Cap web_search tool turns on the discovery branch — enough to find a
// handful of creators and skim a few posts, not enough to burn $10 on one
// research pass.
export const WEB_SEARCH_MAX_USES = 5;

let cachedClient: Anthropic | null = null;
export function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

export interface CompetitorInsight {
  channel: ChannelId;
  topPatterns: string[];
  samplePosts: Array<{ text: string; why_it_worked: string }>;
  recommendedThemes: string[];
  reasoning: string;
  discoveredHandles: Array<{
    handle: string;
    display_name: string | null;
    source: "existing" | "discovered";
    rationale: string | null;
  }>;
}

export const insightShapeSchema = z.object({
  topPatterns: z.array(z.string().min(1).max(200)).max(8).default([]),
  samplePosts: z
    .array(
      z.object({
        text: z.string().min(1).max(800),
        why_it_worked: z.string().min(1).max(280),
      }),
    )
    .max(8)
    .default([]),
  recommendedThemes: z.array(z.string().min(1).max(80)).max(8).default([]),
  reasoning: z.string().min(1).max(1200),
  discoveredHandles: z
    .array(
      z.object({
        handle: z.string().min(1).max(120),
        display_name: z.string().max(160).nullable().optional(),
        rationale: z.string().max(280).nullable().optional(),
      }),
    )
    .max(12)
    .default([]),
});

export type SubmitResult = z.infer<typeof insightShapeSchema>;

// ─────────────────────────────────────────────────────────────
// Anthropic tool specs
// ─────────────────────────────────────────────────────────────

export const SUBMIT_TOOL_NAME = "submit_competitor_insight";

export const SUBMIT_TOOL = {
  name: SUBMIT_TOOL_NAME,
  description:
    "Submit the synthesised competitor research for this channel. Call exactly once " +
    "at the end of your work. Patterns are short structural sentences, sample posts " +
    "are verbatim text excerpts, themes are short kebab-case tags. Reasoning is one " +
    "paragraph describing what the top quartile looks like on this channel right now.",
  input_schema: {
    type: "object",
    required: ["reasoning"],
    properties: {
      topPatterns: {
        type: "array",
        maxItems: 5,
        items: { type: "string", minLength: 1, maxLength: 200 },
        description:
          "Up to 5 short, structural patterns observed across the top performers " +
          "(e.g. 'opens with a personal stat', 'two-line hook + proof'). Describe " +
          "structure, not personalities.",
      },
      samplePosts: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          required: ["text", "why_it_worked"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 500 },
            why_it_worked: { type: "string", minLength: 1, maxLength: 200 },
          },
          additionalProperties: false,
        },
        description:
          "Up to 5 representative posts. text is verbatim; why_it_worked is one " +
          "hedged sentence (start with 'Possibly').",
      },
      recommendedThemes: {
        type: "array",
        maxItems: 5,
        items: { type: "string", minLength: 1, maxLength: 60 },
        description:
          "Up to 5 reusable theme tags (lowercase, hyphen-separated) trending on " +
          "this channel for this niche.",
      },
      reasoning: {
        type: "string",
        minLength: 1,
        maxLength: 600,
        description:
          "One paragraph (≤600 chars) describing what the top quartile looks like " +
          "on this channel right now, for this brand's niche.",
      },
      discoveredHandles: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          required: ["handle"],
          properties: {
            handle: {
              type: "string",
              minLength: 1,
              maxLength: 120,
              description: "Lowercase, no leading @. Just the handle string.",
            },
            display_name: { type: "string", maxLength: 160 },
            rationale: {
              type: "string",
              maxLength: 280,
              description:
                "One-line note on why this handle is relevant to the brand's niche.",
            },
          },
          additionalProperties: false,
        },
        description:
          "Handles you actually looked at. Required on the discovery branch; can " +
          "be empty when the user already has watch_handles for this channel.",
      },
    },
    additionalProperties: false,
  },
} as const;

// ─────────────────────────────────────────────────────────────
// Tool-use parsing
// ─────────────────────────────────────────────────────────────

export function extractAndValidate(
  response: Anthropic.Message,
): SubmitResult | null {
  const toolUse = response.content.find(
    (b) => b.type === "tool_use" && b.name === SUBMIT_TOOL_NAME,
  );
  if (!toolUse || toolUse.type !== "tool_use") {
    console.warn(
      "Competitor research: Claude did not call submit_competitor_insight.",
    );
    return null;
  }
  const parsed = insightShapeSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    console.warn(
      "Competitor research: submit_competitor_insight validation failed:",
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    );
    return null;
  }
  return parsed.data;
}

// ─────────────────────────────────────────────────────────────
// Handle normalisation + per-channel character allowlists
// ─────────────────────────────────────────────────────────────

// Per-channel character allowlists. Anything outside these patterns is dropped
// before reaching watch_handles (where the daily cron would later crash on it)
// and before reaching the planner LLM.
const HANDLE_PATTERNS: Record<ChannelId, RegExp> = {
  x: /^[a-z0-9_]{1,30}$/,
  instagram: /^[a-z0-9._]{1,30}$/,
  threads: /^[a-z0-9._]{1,30}$/,
  linkedin: /^[a-z0-9-]{3,100}$/,
  bluesky: /^[a-z0-9.-]{1,253}$/,
  facebook: /^[a-z0-9.]{1,80}$/,
  // TikTok usernames: letters, digits, underscores and periods, 1–24 chars.
  tiktok: /^[a-z0-9._]{1,24}$/,
  // YouTube @handles: letters, digits, underscores, periods and hyphens,
  // 3–30 chars (the modern @handle format, leading @ already stripped).
  youtube: /^[a-z0-9._-]{3,30}$/,
};

export function normaliseHandle(raw: string): string {
  return raw
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function isValidHandle(handle: string, channel: ChannelId): boolean {
  const pattern = HANDLE_PATTERNS[channel];
  return pattern.test(handle);
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

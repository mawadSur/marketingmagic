// AI-assisted Facebook Group DISCOVERY for Group Assist.
//
// Turns a workspace's brand brief (product/service, audience, voice + the
// extracted voice profile) into a shortlist of relevant Facebook Group
// ARCHETYPES the operator should consider joining to market — each with a
// human group name/topic, WHY it fits this specific product, a rough audience-
// fit estimate, and a ready-to-use Facebook group-SEARCH link the operator
// clicks to find the real group(s) and apply/join BY HAND.
//
// CRITICAL ToS FRAMING: Meta removed the Groups API on 2024-04-22. There is NO
// supported way for an app to search, read, join, or post to a Facebook Group.
// So these are SUGGESTIONS, not API-verified groups: we propose what to look
// for and hand over an outbound search link — the finding + joining happens on
// Facebook, by the human. Nothing here scrapes Facebook or automates joining,
// and (like the rest of Group Assist) it never touches the `posts` auto-publish
// pipeline.
//
// Mirrors lib/groups/generate.ts: Opus 4.8, maxRetries 6, a single forced tool
// call so the API guarantees schema-valid JSON, and zod re-validation on our
// side. The PURE logic (search-URL building + normalize/validate/dedupe) is
// exported separately from the network call so it's unit-testable without the
// model.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import type { Database, VoiceProfile } from "@/lib/db/types";

const MODEL = "claude-opus-4-8";

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

type Brief = Database["public"]["Tables"]["brand_briefs"]["Row"];

// How many archetypes to ask for / accept in one discovery run.
const MIN_SUGGESTIONS = 1;
const MAX_SUGGESTIONS = 8;
const DEFAULT_SUGGESTIONS = 6;

// ─────────────────────────────────────────────────────────────
// Search-URL building (pure) — the ONLY way we link out to Facebook.
// ─────────────────────────────────────────────────────────────

// Facebook's public group search. The operator lands here logged-in and sees
// real groups matching the query, where they can request to join manually.
const FB_GROUP_SEARCH_BASE = "https://www.facebook.com/search/groups/";

/**
 * Build the canonical Facebook group-search URL for a query. Uses URLSearchParams
 * so the query is percent-encoded correctly (spaces, &, #, emoji, …) — never
 * hand-rolled string concatenation. Returns a stable, fully-encoded https URL.
 *
 * Pure + deterministic; the unit tests assert on its exact output.
 */
export function facebookGroupSearchUrl(query: string): string {
  const q = query.trim();
  const params = new URLSearchParams({ q });
  return `${FB_GROUP_SEARCH_BASE}?${params.toString()}`;
}

/**
 * Defense-in-depth: confirm a URL really is a facebook.com group-search link
 * before we store it or render it as an <a href>/window.open target. Parses the
 * URL (protocol + host + path) rather than substring-matching, mirroring
 * isFacebookGroupUrl in queue/groups/actions.ts. Rejects javascript:/data:
 * pseudo-URLs, look-alike hosts (notfacebook.com, facebook.com.evil.com), and
 * any non-search path.
 */
export function isFacebookGroupSearchUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    const isFacebookHost = host === "facebook.com" || host.endsWith(".facebook.com");
    if (!isFacebookHost) return false;
    // Allow trailing slash variants of the search path.
    const path = parsed.pathname.replace(/\/+$/, "");
    return path === "/search/groups";
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Model output schema (the forced tool call) + our normalized shape.
// ─────────────────────────────────────────────────────────────

// What we ask the model to return per archetype. approx_members is optional
// (the model only sets it when it can give an honest rough estimate).
const rawSuggestionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).default(""),
  why_relevant: z.string().trim().max(600).default(""),
  topic: z.string().trim().max(80).default(""),
  // The search query the model wants the operator to run on Facebook.
  search_query: z.string().trim().min(1).max(200),
  approx_members: z
    .union([z.number().int().min(0).max(100_000_000), z.null()])
    .optional()
    .transform((v) => v ?? null),
});

const rawSuggestionsSchema = z.object({
  suggestions: z.array(rawSuggestionSchema).min(1).max(MAX_SUGGESTIONS),
});

// The normalized, validated, deduped suggestion we persist + render. The
// search URL is built by US (never trusted from the model) so it's always a
// canonical facebook.com/search/groups link.
export interface DiscoveredGroupSuggestion {
  name: string;
  description: string;
  why_relevant: string;
  topic: string;
  approx_members: number | null;
  suggested_search_query: string;
  facebook_search_url: string;
}

export interface DiscoverResult {
  suggestions: DiscoveredGroupSuggestion[];
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Normalize the model's raw suggestions into the shape we persist:
 *   - build the search URL ourselves from search_query (never trust a model URL),
 *   - drop any suggestion whose query is empty after trim,
 *   - dedupe on the case-insensitive query (first occurrence wins),
 *   - optionally exclude queries the workspace has already discovered,
 *   - cap at MAX_SUGGESTIONS.
 *
 * Pure + deterministic — this is the unit-tested core.
 */
export function normalizeSuggestions(
  raw: z.infer<typeof rawSuggestionsSchema>["suggestions"],
  existingQueries: string[] = [],
): DiscoveredGroupSuggestion[] {
  const seen = new Set<string>(
    existingQueries.map((q) => q.trim().toLowerCase()).filter((q) => q.length > 0),
  );
  const out: DiscoveredGroupSuggestion[] = [];

  for (const s of raw) {
    const query = s.search_query.trim();
    if (query.length === 0) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      name: s.name.trim(),
      description: s.description.trim(),
      why_relevant: s.why_relevant.trim(),
      topic: s.topic.trim(),
      approx_members: s.approx_members,
      suggested_search_query: query,
      facebook_search_url: facebookGroupSearchUrl(query),
    });

    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Prompting.
// ─────────────────────────────────────────────────────────────

const DISCOVER_TOOL = {
  name: "submit_group_suggestions",
  description:
    "Submit the suggested Facebook Group archetypes the brand should consider joining to " +
    "market their product. Call exactly once with all suggestions. Each is a KIND of group " +
    "to look for (not a guaranteed real group) plus the search query to find it.",
  input_schema: {
    type: "object",
    required: ["suggestions"],
    properties: {
      suggestions: {
        type: "array",
        minItems: 1,
        maxItems: MAX_SUGGESTIONS,
        items: {
          type: "object",
          required: ["name", "why_relevant", "search_query"],
          properties: {
            name: {
              type: "string",
              minLength: 1,
              maxLength: 120,
              description:
                "A human group name/topic to look for, e.g. 'Bootstrapped SaaS Founders' or " +
                "'Austin Small Business Owners'. The KIND of group, not a verified one.",
            },
            description: {
              type: "string",
              maxLength: 400,
              description: "One sentence on what this kind of group is and who's in it.",
            },
            why_relevant: {
              type: "string",
              maxLength: 600,
              description:
                "Why THIS product/audience fits this group — grounded in the brand brief. " +
                "Be specific; this is what tells the operator it's worth their time.",
            },
            topic: {
              type: "string",
              maxLength: 80,
              description: "Short niche bucket, e.g. 'SaaS', 'Local', 'Parenting', 'Fitness'.",
            },
            search_query: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description:
                "The exact text to search on Facebook's group search to find this kind of " +
                "group. Keep it natural and findable (2–6 words), e.g. 'indie hackers'.",
            },
            approx_members: {
              type: ["integer", "null"],
              minimum: 0,
              description:
                "Optional ROUGH estimate of how many members such groups tend to have. Set " +
                "null unless you can give an honest ballpark — we cannot verify real counts.",
            },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
} as const;

function voiceProfileLines(v: VoiceProfile): string {
  const lines = [
    `- Voice summary: ${v.summary}`,
    `- Vocabulary signature: ${v.vocabulary_signature}`,
    `- Formality: ${v.formality}`,
  ];
  if (v.signature_phrases.length > 0) {
    lines.push(`- Signature phrases: ${v.signature_phrases.slice(0, 8).map((s) => `"${s}"`).join(", ")}`);
  }
  return lines.join("\n");
}

function systemPrompt(): string {
  return [
    "You help a brand find Facebook GROUPS where their target audience gathers, so the brand " +
      "can join and participate (and, later, share useful posts).",
    "",
    "Important framing — be honest:",
    "- Facebook has no public API to search or join groups, so you are SUGGESTING what KINDS of " +
      "groups to look for, not naming verified groups. Never claim a specific group definitely exists.",
    "- For each suggestion, give a natural search query the operator can run on Facebook's own " +
      "group search to find matching communities.",
    "",
    "Rules:",
    "- Propose a DIVERSE shortlist across relevant niches/topics — not 6 variations of one idea.",
    "- Favor groups where the audience ACTIVELY gathers and where a helpful brand could add value, " +
      "not generic mega-groups full of spam.",
    "- Ground every 'why relevant' in the brand's actual product + audience.",
    "- Keep search queries short, natural, and findable (the way a person would type them).",
  ].join("\n");
}

function userPrompt(brief: Brief, count: number): string {
  const voiceProfile = brief.voice_profile;
  const blocks: string[] = [
    `## The brand`,
    `Product / what they do: ${brief.product_description}`,
    `Audience: ${brief.target_audience}`,
    `Voice (freeform): ${brief.voice}`,
    brief.do_not_say.length > 0 ? `Never say: ${brief.do_not_say.join(", ")}` : "",
    "",
    voiceProfile ? `## Voice profile\n${voiceProfileLines(voiceProfile)}` : "",
    "",
    `## Task`,
    `Suggest ${count} Facebook Group archetypes this brand should consider joining to reach its ` +
      `audience and grow. Call submit_group_suggestions exactly once with all of them.`,
  ];
  return blocks.filter((b) => b !== "").join("\n");
}

// ─────────────────────────────────────────────────────────────
// The network call.
// ─────────────────────────────────────────────────────────────

/**
 * Ask Claude for relevant group archetypes for this brief, then normalize +
 * dedupe (against existingQueries) into the persisted shape. Throws on a
 * malformed response so the caller can surface a soft error.
 */
export async function discoverGroups(
  brief: Brief,
  opts: { count?: number; existingQueries?: string[] } = {},
): Promise<DiscoverResult> {
  const count = Math.max(
    MIN_SUGGESTIONS,
    Math.min(MAX_SUGGESTIONS, Math.floor(opts.count ?? DEFAULT_SUGGESTIONS)),
  );

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
    tools: [DISCOVER_TOOL],
    tool_choice: { type: "tool", name: "submit_group_suggestions" },
    messages: [{ role: "user", content: userPrompt(brief, count) }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_group_suggestions") {
    throw new Error("Claude did not call submit_group_suggestions.");
  }

  const parsed = rawSuggestionsSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `Group discovery validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    suggestions: normalizeSuggestions(parsed.data.suggestions, opts.existingQueries).slice(0, count),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { getStatsByChannel, getTopAndBottomPosts, getEngagementByDay } from "./analytics";

const MODEL = "claude-sonnet-4-6";
const FRESHNESS_HOURS = 24 * 7;

export interface AiReview {
  summary: string;
  themes_worked: string[];
  themes_struggled: string[];
  timing_suggestions: string[];
  next_actions: string[];
  generated_at: string;
  is_stale: boolean;
}

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY });
  return cachedClient;
}

export async function getOrGenerateAiReview(
  workspaceId: string,
  windowDays = 30,
): Promise<AiReview | null> {
  const svc = supabaseService();
  const nowIso = new Date().toISOString();

  // Cache hit?
  const { data: cached } = await svc
    .from("ai_reviews")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("window_days", windowDays)
    .gt("expires_at", nowIso)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (cached) {
    return {
      summary: cached.summary,
      themes_worked: cached.themes_worked ?? [],
      themes_struggled: cached.themes_struggled ?? [],
      timing_suggestions: cached.timing_suggestions ?? [],
      next_actions: cached.next_actions ?? [],
      generated_at: cached.generated_at,
      is_stale: false,
    };
  }

  // Compose context.
  const [byChannel, byDay, ranked] = await Promise.all([
    getStatsByChannel(workspaceId, windowDays),
    getEngagementByDay(workspaceId, windowDays),
    getTopAndBottomPosts(workspaceId, windowDays, 5),
  ]);

  // Not enough data — bail.
  const totalPosts = byChannel.reduce((s, c) => s + c.posts, 0);
  if (totalPosts < 5) return null;

  const context = JSON.stringify(
    {
      window_days: windowDays,
      by_channel: byChannel,
      by_day: byDay.slice(-14),
      top_posts: ranked.top.map((p) => ({
        text: p.text,
        channel: p.channel,
        theme: p.theme,
        posted_at: p.posted_at,
        engagement_rate: p.engagement_rate,
        impressions: p.impressions,
      })),
      bottom_posts: ranked.bottom.map((p) => ({
        text: p.text,
        channel: p.channel,
        theme: p.theme,
        posted_at: p.posted_at,
        engagement_rate: p.engagement_rate,
        impressions: p.impressions,
      })),
    },
    null,
    2,
  );

  const system = [
    "You review social-media performance data for marketingmagic.",
    "You output a concise weekly review as strict JSON. No prose outside the JSON.",
    "Schema:",
    "{",
    '  "summary": "2-3 sentence plain-language overview",',
    '  "themes_worked": ["theme — why"],',
    '  "themes_struggled": ["theme — why"],',
    '  "timing_suggestions": ["specific advice"],',
    '  "next_actions": ["concrete recommendation"]',
    "}",
    "Be specific. Quote actual post excerpts when calling out top/bottom performers.",
    "If the data is too thin for a confident call, say so in the summary and keep arrays short.",
  ].join("\n");

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 1500,
    system,
    messages: [{ role: "user", content: `Here is the latest ${windowDays}-day data:\n\n${context}` }],
  });
  const textBlock = resp.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AI review returned no text.");
  }
  const json = extractJson(textBlock.text);
  const parsed = json as {
    summary?: string;
    themes_worked?: string[];
    themes_struggled?: string[];
    timing_suggestions?: string[];
    next_actions?: string[];
  };

  const expiresAt = new Date(Date.now() + FRESHNESS_HOURS * 60 * 60 * 1000).toISOString();
  const review: AiReview = {
    summary: parsed.summary ?? "",
    themes_worked: parsed.themes_worked ?? [],
    themes_struggled: parsed.themes_struggled ?? [],
    timing_suggestions: parsed.timing_suggestions ?? [],
    next_actions: parsed.next_actions ?? [],
    generated_at: nowIso,
    is_stale: false,
  };

  await svc.from("ai_reviews").insert({
    workspace_id: workspaceId,
    window_days: windowDays,
    summary: review.summary,
    themes_worked: review.themes_worked,
    themes_struggled: review.themes_struggled,
    timing_suggestions: review.timing_suggestions,
    next_actions: review.next_actions,
    raw: parsed as unknown as import("@/lib/db/types").Json,
    expires_at: expiresAt,
  });

  return review;
}

function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1]! : text.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("Could not parse JSON from review response.");
  }
}

import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import {
  explainerCardSchema,
  type ExplainerCard,
} from "@/lib/explain/schema";
import { isInRecommendedWindow } from "@/lib/channels/best-times";
import type { OutlierPost } from "@/lib/explain/outliers";

const MODEL = "claude-opus-4-8";

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

// Signals we compute deterministically and feed Claude — so its bullets must
// reference *these specific data points* rather than speculate. The prompt
// repeats the closed vocabulary so Claude can't invent a new reason kind.
export interface ExplainerSignals {
  verdict: "winner" | "underperformer";
  theme: string | null;
  // Engagement context.
  engagement_rate: number;
  baseline: number;
  ratio: number;
  // Timing context.
  posted_at: string;
  posted_hour_local: number;
  posted_weekday_local: number; // 1=Mon … 7=Sun (ISO weekday)
  in_recommended_window: boolean;
  // Text shape.
  char_length: number;
  opener_kind: "question" | "number" | "declaration" | "quote" | "hook" | "other";
  opener_preview: string; // first ~80 chars
  has_hashtag: boolean;
  // Theme lift vs workspace median for that theme over the same window.
  theme_lift_ratio: number | null;
  // Workspace winner length p50 — null when we don't have enough winners yet.
  workspace_winner_median_chars: number | null;
}

// Classify the opener — first non-empty line, first 80 chars. Cheap heuristic,
// no LLM call. Keeps Claude focused on the *signal* rather than the text.
export function classifyOpener(text: string): {
  kind: ExplainerSignals["opener_kind"];
  preview: string;
} {
  const head = text.trim().split(/\n/)[0]?.trim() ?? "";
  const preview = head.slice(0, 80);
  if (!preview) return { kind: "other", preview: "" };
  if (preview.includes("?")) return { kind: "question", preview };
  if (/^"|^'|^“|^‘/.test(preview)) return { kind: "quote", preview };
  if (/^\d/.test(preview)) return { kind: "number", preview };
  // "hook" = short punchy declaration < 60 chars ending in . or no terminator.
  // "declaration" = longer factual statement.
  if (preview.length < 60) return { kind: "hook", preview };
  return { kind: "declaration", preview };
}

// The forcing tool. Same pattern as plan/generate.ts: tool_choice forces
// Claude to call this and only this, with input matching the schema. No
// free-form output, no speculation.
const EXPLAINER_TOOL = {
  name: "submit_explainer",
  description:
    "Submit the 'why this post performed' card. Call exactly once. Reasons must each map to one of the signals you were given — do not invent new ones.",
  input_schema: {
    type: "object",
    required: ["verdict", "reasons", "pattern_summary"],
    properties: {
      verdict: { type: "string", enum: ["winner", "underperformer"] },
      reasons: {
        type: "array",
        minItems: 3,
        maxItems: 5,
        items: {
          type: "object",
          required: ["kind", "detail"],
          properties: {
            kind: {
              type: "string",
              enum: ["theme", "timing", "voice", "opener", "length", "other"],
            },
            detail: { type: "string", minLength: 8, maxLength: 280 },
          },
          additionalProperties: false,
        },
      },
      pattern_summary: { type: "string", minLength: 10, maxLength: 160 },
    },
    additionalProperties: false,
  },
} as const;

function systemPrompt(verdict: "winner" | "underperformer"): string {
  const tone =
    verdict === "winner"
      ? [
          "Frame: This post outperformed the workspace baseline. The user wants to",
          "understand what *might* have helped. You DO NOT actually know what caused",
          "the lift — only what data points were unusual. Hedge every reason.",
        ].join(" ")
      : [
          "Frame: This post underperformed the workspace baseline. The user wants",
          "to learn — not be demoralized. Be matter-of-fact, never blaming. Hedge",
          "every reason. Avoid words like 'failed', 'bad', 'poor'. Use 'softer',",
          "'less than the usual lift', 'didn't connect this time'.",
        ].join(" ");
  return [
    "You analyze a single social-media post against deterministic signals and",
    "return 3-5 hedged bullets explaining what *might* have driven the result.",
    "",
    tone,
    "",
    "Rules:",
    "- Every bullet must reference a SPECIFIC signal from the user message.",
    '- Hedge: use "possibly", "may have", "tends to", "your usual …".',
    '- NEVER claim causation. Use "Possible reasons" framing.',
    "- Return between 3 and 5 reasons. Choose the most salient signals.",
    "- `kind` MUST be one of: theme, timing, voice, opener, length, other.",
    "- `pattern_summary` is one short line the user could save to their playbook.",
    "- Call submit_explainer exactly once. No prose outside the tool call.",
  ].join("\n");
}

function userPrompt(signals: ExplainerSignals, text: string): string {
  const lines: string[] = [];
  lines.push(`Verdict: ${signals.verdict}`);
  lines.push(
    `Engagement rate: ${(signals.engagement_rate * 100).toFixed(2)}% — that's ${signals.ratio.toFixed(
      2,
    )}× the workspace baseline of ${(signals.baseline * 100).toFixed(2)}%.`,
  );
  lines.push("");
  lines.push("## Signals");
  lines.push(`- Theme: ${signals.theme ?? "(untagged)"}`);
  if (signals.theme_lift_ratio != null) {
    lines.push(
      `  - Theme lift: this theme runs ${signals.theme_lift_ratio.toFixed(
        2,
      )}× the workspace median engagement on average.`,
    );
  }
  lines.push(
    `- Posted: ${signals.posted_at} (local hour ${signals.posted_hour_local}, ISO weekday ${signals.posted_weekday_local})`,
  );
  lines.push(
    `- Within channel's recommended posting window: ${signals.in_recommended_window ? "yes" : "no"}`,
  );
  lines.push(`- Length: ${signals.char_length} chars`);
  if (signals.workspace_winner_median_chars != null) {
    lines.push(
      `  - Workspace winners typically run ~${signals.workspace_winner_median_chars} chars.`,
    );
  }
  lines.push(`- Opener type: ${signals.opener_kind} — "${signals.opener_preview}"`);
  lines.push(`- Hashtag present: ${signals.has_hashtag ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Post text");
  lines.push(text);
  lines.push("");
  lines.push("Call submit_explainer now. 3-5 hedged reasons, one per salient signal.");
  return lines.join("\n");
}

// Compute the deterministic signals from raw inputs. Separated so callers
// can render the *same* signals into the UI tooltip without re-calling
// Claude. Pure function.
export function buildSignals(args: {
  post: Pick<OutlierPost, "text" | "theme" | "channel" | "engagement_rate" | "baseline" | "ratio" | "posted_at" | "verdict">;
  themeLiftRatio: number | null;
  workspaceWinnerMedianChars: number | null;
}): ExplainerSignals {
  const { post } = args;
  const d = new Date(post.posted_at);
  const isoWeekday = d.getDay() === 0 ? 7 : d.getDay();
  const opener = classifyOpener(post.text);
  return {
    verdict: post.verdict,
    theme: post.theme,
    engagement_rate: post.engagement_rate,
    baseline: post.baseline,
    ratio: post.ratio,
    posted_at: post.posted_at,
    posted_hour_local: d.getHours(),
    posted_weekday_local: isoWeekday,
    in_recommended_window: isInRecommendedWindow(post.channel, post.posted_at),
    char_length: post.text.length,
    opener_kind: opener.kind,
    opener_preview: opener.preview,
    has_hashtag: /(^|\s)#\w+/.test(post.text),
    theme_lift_ratio: args.themeLiftRatio,
    workspace_winner_median_chars: args.workspaceWinnerMedianChars,
  };
}

export interface GenerateExplainerResult {
  card: ExplainerCard;
  signals: ExplainerSignals;
  usage: { input_tokens: number; output_tokens: number };
}

export async function generateExplainer(
  signals: ExplainerSignals,
  postText: string,
): Promise<GenerateExplainerResult> {
  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: "text", text: systemPrompt(signals.verdict) }],
    tools: [EXPLAINER_TOOL],
    tool_choice: { type: "tool", name: "submit_explainer" },
    messages: [{ role: "user", content: userPrompt(signals, postText) }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_explainer") {
    throw new Error("Claude did not call submit_explainer.");
  }
  const parsed = explainerCardSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `Explainer validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return {
    card: parsed.data,
    signals,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

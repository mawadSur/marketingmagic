import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import type { VoiceProfile } from "@/lib/db/types";
import type { ChannelId } from "@/lib/channels/registry";
import {
  proposeStrategyResultSchema,
  type GoalDraft,
  type ProposeStrategyResult,
} from "@/lib/goals/schema";

// Reverse-planner: customer's goal → Claude → structured GoalStrategy.
//
// Mirrors the SDK pattern used in src/lib/sources/extract-claude.ts and
// src/lib/plan/generate.ts exactly:
//   - Lazy singleton client
//   - claude-opus-4-8
//   - tool_choice forcing a single submit_strategy call
//   - zod re-validation downstream
//
// The goal-realism gate is built into the tool schema: Claude returns a
// discriminated union { realistic: true, strategy } or { realistic: false,
// reason, closest_achievable }. The downstream UI surfaces the warning
// when realistic=false — we never silently inflate the plan.

const MODEL = "claude-opus-4-8";

// The org's Anthropic tier caps input tokens/minute (e.g. 10k/min on entry
// tiers). A burst — two goals proposed back-to-back, or this call landing right
// after a plan generation — can momentarily exceed it and return a 429
// rate_limit_error. That's transient: waiting out the 1-minute window clears it.
// So we let the SDK retry 429s (and 5xx / network blips) with exponential
// backoff instead of surfacing the raw error to the user. The SDK honours the
// `retry-after` header the rate-limit response carries, so these retries wait
// exactly as long as Anthropic asks. Raising the ORG limit itself is a console
// action (console.anthropic.com/settings/limits) — not something code can do.
const MAX_RETRIES = 6;

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({
    apiKey: serverEnv().ANTHROPIC_API_KEY,
    // Default is 2; bump so a 429 inside the per-minute window rides out the
    // backoff (honouring retry-after) rather than failing the goal proposal.
    maxRetries: MAX_RETRIES,
  });
  return cachedClient;
}

export interface ProposeStrategyInputs {
  goal: GoalDraft;
  // Channels the workspace has connected. The strategy's posting_cadence
  // should only reference these; Claude will skip / zero out channels we
  // can't actually post to.
  channelMix: Array<{ channel: ChannelId; handle: string }>;
  // Optional: voice profile from brand_briefs. When supplied, Claude
  // factors voice fit into the milestone narrative ("week 2: contrarian
  // takes that suit the brand's plain-spoken register").
  voiceProfile?: VoiceProfile | null;
  // Optional: free-form brand context (product description + audience).
  // Two fields kept separate so the prompt can label them.
  productDescription?: string | null;
  targetAudience?: string | null;
}

export interface ProposeStrategyResultWithUsage {
  result: ProposeStrategyResult;
  usage: { input_tokens: number; output_tokens: number };
}

// Tool schema. We deliberately use a discriminated-union shape so the
// realism gate is unmissable in the API contract — Claude must commit to
// realistic:true OR realistic:false.
const STRATEGY_TOOL = {
  name: "submit_strategy",
  description:
    "Submit the proposed strategy for the user's content goal. " +
    "Call this exactly once. Either return realistic:true with a strategy that " +
    "credibly hits the goal, OR realistic:false with a reason + the closest " +
    "achievable plan you can defend. Never silently inflate — under-promising " +
    "and over-delivering is the explicit product behaviour.",
  input_schema: {
    type: "object",
    required: ["realistic"],
    properties: {
      realistic: {
        type: "boolean",
        description:
          "true if the supplied goal is plausibly achievable in the requested timeframe with " +
          "weekly content; false if it would require paid ads, channel partnerships, viral luck, " +
          "or a content cadence beyond what's sustainable.",
      },
      reason: {
        type: "string",
        maxLength: 800,
        description:
          "When realistic=false, explain *why* in plain language. Reference the gap (e.g. 'you " +
          "asked for 5k followers in 4 weeks; the brand's current trajectory and audience size " +
          "make 1–1.5k the defensible ceiling without paid spend').",
      },
      strategy: STRATEGY_SCHEMA(),
      closest_achievable: STRATEGY_SCHEMA(),
    },
    additionalProperties: false,
  },
} as const;

function STRATEGY_SCHEMA() {
  return {
    type: "object",
    required: [
      "weeks",
      "summary",
      "theme_weights",
      "posting_cadence",
      "milestones",
      "success_criteria",
    ],
    properties: {
      weeks: {
        type: "integer",
        minimum: 1,
        maximum: 12,
        description:
          "Number of weeks the plan should span. Bias toward 4 (one month) for follower / inbound " +
          "goals, 6–8 for credibility, and the actual distance-to-target_date for launch_date goals.",
      },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 1200,
        description:
          "2–4 sentence prose summary of the strategy. Concrete, no marketing-speak. Surfaced at " +
          "the top of the preview screen — this is what the user will read first.",
      },
      theme_weights: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        description:
          "Per-theme bias for the planner. Weights are 0–1 shares; aim to roughly sum to 1.0 across " +
          "themes. Themes are short tags (lowercase, hyphen-separated) — reuse existing workspace " +
          "themes when natural.",
        items: {
          type: "object",
          required: ["theme", "weight", "rationale"],
          properties: {
            theme: { type: "string", minLength: 1, maxLength: 60 },
            weight: { type: "number", minimum: 0, maximum: 1 },
            rationale: { type: "string", minLength: 1, maxLength: 400 },
          },
          additionalProperties: false,
        },
      },
      posting_cadence: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        description:
          "Per-channel posts/week target. Only include channels the workspace has connected. Set " +
          "posts_per_week=0 to explicitly skip a channel (with a rationale).",
        items: {
          type: "object",
          required: ["channel", "posts_per_week", "rationale"],
          properties: {
            channel: {
              type: "string",
              enum: ["x", "linkedin", "threads", "instagram", "bluesky"],
            },
            posts_per_week: { type: "integer", minimum: 0, maximum: 28 },
            rationale: { type: "string", minLength: 1, maxLength: 400 },
          },
          additionalProperties: false,
        },
      },
      milestones: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        description:
          "Week-by-week arc. One entry per content-week — focus is a short label, description is " +
          "1–3 sentences of what that week's posts should accomplish narratively.",
        items: {
          type: "object",
          required: ["week", "focus", "description"],
          properties: {
            week: { type: "integer", minimum: 1, maximum: 12 },
            focus: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: "string", minLength: 1, maxLength: 600 },
          },
          additionalProperties: false,
        },
      },
      success_criteria: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: { type: "string", minLength: 1, maxLength: 280 },
        description:
          "Concrete signals that the goal is on track. Avoid vanity metrics — 'replies from 3+ " +
          "decision-makers' beats 'engagement up 20%.'",
      },
      risks: {
        type: "array",
        maxItems: 6,
        items: { type: "string", minLength: 1, maxLength: 280 },
        description:
          "Caveats Claude wants the user to internalize even when realistic=true. Optional.",
      },
    },
    additionalProperties: false,
  } as const;
}

function buildSystem(inputs: ProposeStrategyInputs): string {
  const lines: string[] = [];
  lines.push(
    "You are the strategist brain of marketingmagic, a marketing-automation tool.",
    "Your job: take a customer's content goal and propose a STRATEGY — theme weights, posting cadence,",
    "a week-by-week milestone narrative, and success criteria — that a downstream content planner",
    "will use to generate 4–12 weeks of posts reverse-engineered to hit the goal.",
    "",
    "Hard rule: the goal-realism gate.",
    "  - If the goal is plausibly achievable with weekly content alone (no paid ads, no viral luck),",
    "    return realistic:true with a strategy.",
    "  - If it isn't, return realistic:false with a reason AND a closest_achievable strategy. Never",
    "    silently inflate. Under-promise, over-deliver.",
    "",
    "What 'plausibly achievable' means in practice:",
    "  - Follower goals: organic content typically grows an audience 3–10% per week on focused niche",
    "    accounts and slower on broad ones. 5k followers in 4 weeks from a 200-follower account",
    "    without paid spend is not realistic; 800–1.2k might be.",
    "  - Inbound goals: 1–3 qualified DMs per week is a strong outcome for niche B2B accounts.",
    "  - Launch goals: cadence should ramp toward the launch_date with the loudest week being the",
    "    week of launch. Distance-to-launch is your weeks count.",
    "  - Credibility / recovery goals: 6–8 week arcs. Recovery especially needs a 'reset week'",
    "    early and a 'rebuild' middle.",
    "",
  );
  if (inputs.productDescription) {
    lines.push("## Product", inputs.productDescription, "");
  }
  if (inputs.targetAudience) {
    lines.push("## Target audience", inputs.targetAudience, "");
  }
  if (inputs.voiceProfile) {
    lines.push(
      "## Voice profile (factor into milestone narrative)",
      `Summary: ${inputs.voiceProfile.summary}`,
      `Formality: ${inputs.voiceProfile.formality}. Emoji: ${inputs.voiceProfile.emoji_usage}.`,
      "",
    );
  }
  lines.push("## Connected channels");
  for (const c of inputs.channelMix) {
    lines.push(`- ${c.channel} (@${c.handle})`);
  }
  lines.push(
    "",
    "Rules:",
    "- Posting cadence MUST only reference connected channels. Set posts_per_week=0 + rationale to skip.",
    "- Theme weights are short tags (lowercase, hyphen-separated). 3–6 themes is the sweet spot.",
    "- Milestones cover EVERY week in `weeks` — week 1 through week N. No gaps.",
    "- Success criteria are concrete. 'Replies from 3 decision-makers' beats 'more engagement.'",
    "- Call submit_strategy exactly once. Do not respond with prose.",
  );
  return lines.join("\n");
}

function buildUser(inputs: ProposeStrategyInputs): string {
  const { goal } = inputs;
  const lines: string[] = [];
  lines.push("Customer goal:");
  lines.push("---");
  lines.push(goal.goal_text);
  lines.push("---");
  lines.push("");
  lines.push(`Goal metric: ${goal.goal_metric}`);
  if (typeof goal.target_value === "number") {
    lines.push(`Target value: ${goal.target_value}`);
  }
  if (goal.target_date) {
    lines.push(`Target date: ${goal.target_date}`);
    const days = Math.max(
      0,
      Math.round(
        (new Date(goal.target_date).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
      ),
    );
    lines.push(`Distance to target: ~${days} day${days === 1 ? "" : "s"}`);
  }
  lines.push("");
  lines.push(
    "Decide: is this goal realistic with weekly content alone? Call submit_strategy with your verdict.",
  );
  return lines.join("\n");
}

export async function proposeStrategy(
  inputs: ProposeStrategyInputs,
): Promise<ProposeStrategyResultWithUsage> {
  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: "text", text: buildSystem(inputs), cache_control: { type: "ephemeral" } }],
    tools: [STRATEGY_TOOL],
    tool_choice: { type: "tool", name: "submit_strategy" },
    messages: [{ role: "user", content: buildUser(inputs) }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_strategy") {
    throw new Error("Claude did not call submit_strategy.");
  }

  // Normalize before validation: the JSON Schema can't express "strategy
  // required when realistic=true, closest_achievable required when false."
  // Validate manually so the error message is human-friendly.
  const raw = toolUse.input as Record<string, unknown>;
  let candidate: unknown;
  if (raw.realistic === true) {
    candidate = { realistic: true, strategy: raw.strategy };
  } else if (raw.realistic === false) {
    candidate = {
      realistic: false,
      reason: raw.reason,
      closest_achievable: raw.closest_achievable,
    };
  } else {
    throw new Error("submit_strategy: missing or invalid `realistic` flag.");
  }

  const parsed = proposeStrategyResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Strategy validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    result: parsed.data,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

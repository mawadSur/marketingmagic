// AI copy generation for Facebook Group Assist.
//
// Drafts group-tailored post copy from the brand brief + extracted voice
// profile + the SPECIFIC group's posting rules. The group's rules are the
// differentiator vs the planner: a "value_only" group gets a story/lesson with
// no hard sell; a "no links" group gets copy that never includes a URL.
//
// Mirrors lib/plan/generate.ts exactly: Opus 4.8, maxRetries 6, a single
// forced tool call so the API guarantees schema-valid JSON (no brittle parsing),
// and zod re-validation on our side.
//
// Nothing here publishes anything — it returns text the operator copies and
// posts by hand. (Meta removed the Groups API on 2024-04-22.)

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import type { Database, VoiceProfile } from "@/lib/db/types";
import type { GroupPostingRules } from "@/lib/groups/posting-rules";

const MODEL = "claude-opus-4-8";

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

type Brief = Database["public"]["Tables"]["brand_briefs"]["Row"];

export interface GroupDraftInputs {
  brief: Brief;
  group: {
    name: string;
    rules: GroupPostingRules;
  };
  // How many distinct drafts to produce (1-5).
  count: number;
  // The reachable verdict headline ("Lead with value — soft promo only", etc.)
  // so the copy is steered to match what the operator will actually be told.
  verdictHeadline: string;
}

const draftsSchema = z.object({
  drafts: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(8000),
        angle: z.string().trim().min(1).max(200),
      }),
    )
    .min(1)
    .max(5),
});

export type GeneratedGroupDrafts = z.infer<typeof draftsSchema>;

export interface GroupDraftGenResult {
  drafts: GeneratedGroupDrafts["drafts"];
  usage: { input_tokens: number; output_tokens: number };
}

const DRAFTS_TOOL = {
  name: "submit_group_drafts",
  description:
    "Submit the generated Facebook Group posts. Call exactly once with all drafts. " +
    "Each draft is a complete, ready-to-paste post written for this specific group — " +
    "respecting its promo policy and rules. Give each a short distinct angle.",
  input_schema: {
    type: "object",
    required: ["drafts"],
    properties: {
      drafts: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          required: ["text", "angle"],
          properties: {
            text: {
              type: "string",
              minLength: 1,
              maxLength: 8000,
              description:
                "The full post body, ready to paste into the Facebook Group. Native to a " +
                "community group — conversational, useful, not an ad. No markdown.",
            },
            angle: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description: "Short label for this draft's angle (e.g. 'lesson-learned', 'ask-the-group').",
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
    `- Emoji usage: ${v.emoji_usage}`,
    `- Average sentence length: ~${v.sentence_length_avg.toFixed(0)} words`,
  ];
  if (v.signature_phrases.length > 0) {
    lines.push(`- Signature phrases (use where natural): ${v.signature_phrases.slice(0, 10).map((s) => `"${s}"`).join(", ")}`);
  }
  if (v.do_not_say.length > 0) {
    lines.push(`- Voice anti-patterns: ${v.do_not_say.slice(0, 10).join(", ")}`);
  }
  return lines.join("\n");
}

function policyGuidance(rules: GroupPostingRules): string {
  const parts: string[] = [];
  switch (rules.promo_policy) {
    case "open":
      parts.push(
        "This group ALLOWS promotional posts. You can mention the product directly, but keep it useful and human — community groups punish anything that reads like an ad.",
      );
      break;
    case "limited":
      parts.push(
        "This group only allows promo on certain days. Write posts that work as promo, but keep them warm and value-forward so they survive moderation.",
      );
      break;
    case "value_only":
      parts.push(
        "This group does NOT allow straight promotion. Lead with genuine value — a story, a lesson, a useful tip, or a question. Mention what you do only in passing, if at all. NEVER make it feel like an ad.",
      );
      break;
  }
  if (!rules.allow_links) {
    parts.push("This group BANS links. Do not include any URL in the post body. If a resource is relevant, say it's available and offer it in the comments.");
  }
  if (rules.rules_notes.trim().length > 0) {
    parts.push(`The group's own rules (respect these literally):\n${rules.rules_notes.trim()}`);
  }
  return parts.join("\n\n");
}

function systemPrompt(): string {
  return [
    "You write posts for Facebook GROUPS on behalf of a brand. These are communities, not the brand's own Page — readers are peers, and overt self-promotion gets posts removed and accounts banned.",
    "",
    "Rules:",
    "- Write complete, ready-to-paste posts. No markdown, no placeholders, no '[link]'.",
    "- Sound like a real person in the community, never like marketing copy.",
    "- Respect the group's promo policy and rules EXACTLY — they override any instinct to sell.",
    "- Match the brand's voice profile when provided.",
    "- Each draft should take a clearly different angle so the operator has real choices.",
  ].join("\n");
}

function userPrompt(inputs: GroupDraftInputs): string {
  const { brief, group } = inputs;
  const voiceProfile = brief.voice_profile;
  const blocks: string[] = [
    `## The brand`,
    `Product / what they do: ${brief.product_description}`,
    `Audience: ${brief.target_audience}`,
    `Voice (freeform): ${brief.voice}`,
    brief.do_not_say.length > 0 ? `Never say: ${brief.do_not_say.join(", ")}` : "",
    "",
    voiceProfile ? `## Voice profile (match this register precisely)\n${voiceProfileLines(voiceProfile)}` : "",
    "",
    `## The group: "${group.name}"`,
    policyGuidance(group.rules),
    "",
    `Heads-up shown to the operator for right now: "${inputs.verdictHeadline}". Write copy consistent with that guidance.`,
    "",
    `## Task`,
    `Write ${inputs.count} distinct post${inputs.count === 1 ? "" : "s"} for this group. Call submit_group_drafts exactly once with all of them.`,
  ];
  return blocks.filter((b) => b !== "").join("\n");
}

export async function generateGroupDrafts(
  inputs: GroupDraftInputs,
): Promise<GroupDraftGenResult> {
  const count = Math.max(1, Math.min(5, Math.floor(inputs.count)));
  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
    tools: [DRAFTS_TOOL],
    tool_choice: { type: "tool", name: "submit_group_drafts" },
    messages: [{ role: "user", content: userPrompt({ ...inputs, count }) }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_group_drafts") {
    throw new Error("Claude did not call submit_group_drafts.");
  }

  const parsed = draftsSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `Group draft validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    drafts: parsed.data.drafts.slice(0, count),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

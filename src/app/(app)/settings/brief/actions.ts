"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { supabaseServer } from "@/lib/supabase/server";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { serverEnv } from "@/lib/env";

export type SaveBriefState = { error: string | null; savedAt: string | null };

export interface BriefSuggestion {
  product_description: string;
  voice: string;
  target_audience: string;
  do_not_say: string[];
  reference_links: string[];
  reference_posts: string[];
}

export type SuggestBriefResult = { data: BriefSuggestion | null; error: string | null };

const schema = z.object({
  product_description: z.string().trim().min(10).max(4000),
  voice: z.string().trim().min(10).max(4000),
  target_audience: z.string().trim().min(5).max(2000),
  do_not_say: z.array(z.string().trim().min(1)).max(50),
  reference_links: z.array(z.string().url()).max(20),
  reference_posts: z.array(z.string().trim().min(1)).max(50),
});

function lines(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") return [];
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function saveBriefAction(
  _prev: SaveBriefState,
  formData: FormData,
): Promise<SaveBriefState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const parsed = schema.safeParse({
    product_description: (formData.get("product_description") as string) ?? "",
    voice: (formData.get("voice") as string) ?? "",
    target_audience: (formData.get("target_audience") as string) ?? "",
    do_not_say: lines(formData.get("do_not_say")),
    reference_links: lines(formData.get("reference_links")),
    reference_posts: lines(formData.get("reference_posts")),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
      savedAt: null,
    };
  }

  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("brand_briefs")
    .upsert(
      { workspace_id: ws.id, ...parsed.data },
      { onConflict: "workspace_id" },
    );
  if (error) return { error: error.message, savedAt: null };

  revalidatePath("/settings/brief");
  return { error: null, savedAt: new Date().toISOString() };
}

// ─── Fill with AI ──────────────────────────────────────────────────────────

const urlSchema = z
  .string()
  .trim()
  .url("Enter a valid URL (https://example.com).")
  .refine((u) => {
    try {
      const parsed = new URL(u);
      if (!["http:", "https:"].includes(parsed.protocol)) return false;
      const host = parsed.hostname.toLowerCase();
      // SSRF guard: refuse loopback / link-local / common private hostnames.
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host.endsWith(".local") ||
        host.startsWith("169.254.") ||
        host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }, "URL must be a public http(s) address.");

const MAX_HTML_BYTES = 200_000;
const FETCH_TIMEOUT_MS = 10_000;
const MODEL = "claude-sonnet-4-6";

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY });
  return cachedClient;
}

function stripHtml(html: string): string {
  // Remove scripts / styles / SVG inline / HTML comments / noscript blocks.
  // Then collapse the rest to plain text. Crude but effective for marketing
  // pages and avoids pulling in a parser dependency.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLinks(html: string, baseUrl: string): string[] {
  const set = new Set<string>();
  const re = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const href = match[1]!;
    try {
      const abs = new URL(href, baseUrl).toString();
      if (abs.startsWith("http")) set.add(abs);
    } catch {
      /* skip */
    }
    if (set.size >= 40) break;
  }
  return Array.from(set);
}

export async function suggestBriefFromUrlAction(url: string): Promise<SuggestBriefResult> {
  // Auth — must be in a workspace.
  await getActiveWorkspaceOrRedirect();

  const parsed = urlSchema.safeParse(url);
  if (!parsed.success) {
    return { data: null, error: parsed.error.issues[0]?.message ?? "Invalid URL." };
  }

  let html: string;
  let foundLinks: string[];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(parsed.data, {
      signal: controller.signal,
      headers: {
        "User-Agent": "marketingmagic-brief-bot/1.0 (+https://marketingmagic.app)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { data: null, error: `Fetch failed (${res.status}).` };
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html") && !ct.includes("xml") && !ct.includes("text")) {
      return { data: null, error: `Unsupported content-type: ${ct.split(";")[0]}` };
    }
    const raw = await res.text();
    html = raw.length > MAX_HTML_BYTES ? raw.slice(0, MAX_HTML_BYTES) : raw;
    foundLinks = extractLinks(html, parsed.data);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "fetch failed";
    return { data: null, error: `Could not fetch URL: ${reason}` };
  }

  const text = stripHtml(html).slice(0, 30_000);
  if (text.length < 100) {
    return { data: null, error: "Page has too little readable content to summarize." };
  }

  const system = [
    "You are filling out a brand brief based on a public web page.",
    "Read the page content and infer the brand's product, voice, and audience.",
    "Be specific. Avoid generic marketing-speak. Quote distinctive phrasing from",
    "the page in the `voice` field when it captures the brand's register.",
    "Call the submit_brief tool with the suggested fields. Do not respond with prose.",
    "Leave any field empty (empty string / empty array) when you have no evidence for it.",
  ].join("\n");

  const user = [
    `Source URL: ${parsed.data}`,
    "",
    `Internal links seen on the page (use these to pick reference_links, not made-up ones):`,
    foundLinks.slice(0, 30).map((l) => `- ${l}`).join("\n") || "(none)",
    "",
    "Page text:",
    text,
  ].join("\n");

  const BRIEF_TOOL = {
    name: "submit_brief",
    description: "Submit the inferred brand brief fields.",
    input_schema: {
      type: "object",
      required: [
        "product_description",
        "voice",
        "target_audience",
        "do_not_say",
        "reference_links",
        "reference_posts",
      ],
      properties: {
        product_description: { type: "string", maxLength: 4000 },
        voice: { type: "string", maxLength: 4000 },
        target_audience: { type: "string", maxLength: 2000 },
        do_not_say: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 12 },
        reference_links: { type: "array", items: { type: "string" }, maxItems: 8 },
        reference_posts: { type: "array", items: { type: "string", maxLength: 280 }, maxItems: 8 },
      },
      additionalProperties: false,
    },
  } as const;

  let toolInput: unknown;
  try {
    const resp = await client().messages.create({
      model: MODEL,
      max_tokens: 1500,
      system,
      tools: [BRIEF_TOOL],
      tool_choice: { type: "tool", name: "submit_brief" },
      messages: [{ role: "user", content: user }],
    });
    const toolUse = resp.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_brief") {
      return { data: null, error: "Claude did not call submit_brief." };
    }
    toolInput = toolUse.input;
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : "Claude request failed.",
    };
  }

  const suggestionSchema = z.object({
    product_description: z.string().default(""),
    voice: z.string().default(""),
    target_audience: z.string().default(""),
    do_not_say: z.array(z.string()).default([]).transform((a) => a.filter(Boolean).slice(0, 12)),
    reference_links: z
      .array(z.string())
      .default([])
      .transform((a) => a.filter((u) => /^https?:\/\//.test(u)).slice(0, 8)),
    reference_posts: z
      .array(z.string())
      .default([])
      .transform((a) => a.filter(Boolean).slice(0, 8)),
  });
  const result = suggestionSchema.safeParse(toolInput);
  if (!result.success) {
    return { data: null, error: "Claude's response didn't match the expected shape." };
  }

  return { data: result.data, error: null };
}

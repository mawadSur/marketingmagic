import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { verifyDiscordSignature } from "@/lib/integrations/verify";
import { verifyCustomId, signLinkClaimToken } from "@/lib/integrations/sign";
import { editInteractionResponse, createInteractionFollowup } from "@/lib/integrations/discord";
import { buildActionedEmbed, type DigestPostSummary } from "@/lib/integrations/embeds";

// Discord Interactions Endpoint.
//
// Discord posts every user interaction here:
//   - Type 1 PING   : endpoint registration handshake (respond PONG)
//   - Type 2 APP_CMD: slash command invocation
//   - Type 3 COMPONENT: button click
//
// Hard constraints from Discord:
//   1. Must verify Ed25519 signature using X-Signature-Ed25519 + X-Signature-Timestamp
//      over the RAW request body. Failed verification MUST return 401.
//   2. Must respond within 3 seconds. For work that takes longer we return
//      DEFERRED_UPDATE_MESSAGE (type 6) and finish via the webhook follow-up.
//
// We do the DB writes synchronously inside the route — Supabase is fast
// enough at our scale to land under the 3s budget for a single post action.
// If we ever miss the window we'll add `waitUntil` + deferred response.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Discord interaction response types (subset).
const INTERACTION_PONG = 1;
const INTERACTION_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const INTERACTION_UPDATE_MESSAGE = 7;
const FLAG_EPHEMERAL = 1 << 6;

interface InteractionUser {
  id: string;
  username?: string;
  global_name?: string;
}

interface InteractionPayload {
  type: number;
  data?: {
    custom_id?: string;
    name?: string;
    options?: Array<{ name: string; value?: string | number | boolean }>;
  };
  member?: { user?: InteractionUser };
  user?: InteractionUser;
  guild_id?: string;
  channel_id?: string;
  token?: string;
}

export async function POST(req: NextRequest) {
  const env = serverEnv();
  if (!env.DISCORD_PUBLIC_KEY) {
    // The endpoint MUST exist (Discord polls it during registration) but
    // without a public key we can't verify anything. Return 401 so Discord's
    // automated probe surfaces the misconfig clearly.
    return new NextResponse("Discord not configured", { status: 401 });
  }

  // Signature verification uses the RAW body. Reading req.text() consumes
  // the stream — we cannot reparse via req.json() afterwards, so we parse
  // ourselves below.
  const rawBody = await req.text();
  const signature = req.headers.get("x-signature-ed25519") ?? "";
  const timestamp = req.headers.get("x-signature-timestamp") ?? "";

  if (
    !verifyDiscordSignature({
      publicKeyHex: env.DISCORD_PUBLIC_KEY,
      signatureHex: signature,
      timestamp,
      body: rawBody,
    })
  ) {
    return new NextResponse("invalid request signature", { status: 401 });
  }

  let payload: InteractionPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("bad json", { status: 400 });
  }

  // PING — Discord's URL-registration handshake.
  if (payload.type === 1) {
    return NextResponse.json({ type: INTERACTION_PONG });
  }

  // Slash command
  if (payload.type === 2) {
    return handleSlashCommand(payload);
  }

  // Component (button / select menu)
  if (payload.type === 3) {
    return handleComponent(payload);
  }

  // Anything else — modal submissions, autocompletes — we don't use yet.
  // Acknowledge ephemerally so the client doesn't show a "didn't respond" error.
  return ephemeral("Unsupported interaction type.");
}

// Discord also probes with GET sometimes; respond cleanly so the dashboard
// shows the endpoint as reachable.
export function GET() {
  return NextResponse.json({ ok: true, name: "marketingmagic-discord" });
}

// ─────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────

async function handleSlashCommand(p: InteractionPayload): Promise<NextResponse> {
  const root = p.data?.name;
  // Our registered structure is /mm <sub>. Discord delivers sub-commands as
  // options[0].name when type 1; we accept either nested or flat shape.
  const sub = p.data?.options?.[0]?.name ?? root;
  if (root !== "mm") {
    return ephemeral("Unknown command.");
  }

  const guildId = p.guild_id;
  if (!guildId) {
    return ephemeral("This command must be run inside a server.");
  }

  // Workspace lookup by guild — any of the workspace's Discord integrations
  // matching this guild qualifies. Stats/queue are workspace-scoped so we
  // pick the first match; multi-workspace-per-guild is rare but we surface
  // a friendly hint when it happens.
  const svc = supabaseService();
  const { data: rows } = await svc
    .from("integrations")
    .select("workspace_id")
    .eq("provider", "discord")
    .eq("target_guild_id", guildId);

  const workspaceIds = Array.from(new Set((rows ?? []).map((r) => r.workspace_id)));
  if (workspaceIds.length === 0) {
    return ephemeral(
      "No workspace is connected to this server. Install the bot from /integrations/discord.",
    );
  }
  if (workspaceIds.length > 1) {
    return ephemeral(
      "Multiple workspaces are connected to this server. Use the web app to disambiguate.",
    );
  }
  const workspaceId = workspaceIds[0]!;

  switch (sub) {
    case "queue":
      return ephemeral(await renderQueueSummary(workspaceId));
    case "stats":
      return ephemeral(await renderStatsSummary(workspaceId));
    case "pause":
      return ephemeral(await togglePause(workspaceId));
    default:
      return ephemeral("Unknown subcommand. Try `/mm queue`, `/mm stats`, `/mm pause`.");
  }
}

async function handleComponent(p: InteractionPayload): Promise<NextResponse> {
  const env = serverEnv();
  if (!env.EMAIL_LINK_SECRET) {
    return ephemeral("Approve-from-Discord isn't configured (EMAIL_LINK_SECRET missing).");
  }

  const customId = p.data?.custom_id ?? "";
  const verified = verifyCustomId(customId, env.EMAIL_LINK_SECRET);
  if (!verified.ok) {
    return ephemeral(`Button is invalid (${verified.reason}). Try the queue link instead.`);
  }

  const actor = p.member?.user ?? p.user;
  const actorLabel = actor?.global_name ?? actor?.username ?? "Discord user";

  const svc = supabaseService();
  const { data: post } = await svc
    .from("posts")
    .select("id, status, workspace_id, channel, theme, text, scheduled_at")
    .eq("id", verified.postId)
    .maybeSingle();

  if (!post) {
    return ephemeral("Post not found — it may have been deleted.");
  }
  if (post.status !== "pending_approval") {
    return ephemeral(`Post is already ${post.status.replace("_", " ")}.`);
  }

  // The "edit" action requires the rich web textarea — handing off to the
  // queue is the right UX rather than trying to drag in a Discord modal.
  if (verified.action === "edit") {
    return ephemeral(`Open the post in the queue to edit: ${siteUrl()}/queue#post-${post.id}`);
  }

  const isApprove = verified.action === "approve";
  const updates = isApprove
    ? { status: "scheduled" as const, approved_at: new Date().toISOString() }
    : { status: "rejected" as const };
  const { error: upErr } = await svc.from("posts").update(updates).eq("id", post.id);
  if (upErr) {
    return ephemeral(`Couldn't update post: ${upErr.message}`);
  }

  // Audit trail. Phase 4.7 multi-member attribution: look up the Discord
  // actor in discord_links; on hit use the linked Supabase user, else fall
  // back to the workspace owner (and prompt the actor to link, below).
  const { data: ws } = await svc
    .from("workspaces")
    .select("name, owner_id")
    .eq("id", post.workspace_id)
    .maybeSingle();

  let linkedUserId: string | null = null;
  if (actor?.id) {
    const { data: link } = await svc
      .from("discord_links")
      .select("member_user_id")
      .eq("workspace_id", post.workspace_id)
      .eq("discord_user_id", actor.id)
      .maybeSingle();
    linkedUserId = link?.member_user_id ?? null;
  }

  if (ws) {
    const attributedUserId = linkedUserId ?? ws.owner_id;
    await svc.from("approvals").insert({
      post_id: post.id,
      user_id: attributedUserId,
      action: isApprove ? "approved" : "rejected",
      // Keep the Discord breadcrumb either way — handy for forensics when
      // the link was claimed mid-session or the user later unlinks.
      diff: `discord:${actor?.id ?? "unknown"}:${actorLabel}`,
    });
  }

  // If the actor wasn't linked, send them a private nudge with a signed
  // link-claim URL. Rate-limited per-discord-id so we don't spam them on
  // every click during a digest review.
  if (
    ws &&
    !linkedUserId &&
    actor?.id &&
    p.token &&
    env.EMAIL_LINK_SECRET &&
    shouldSendLinkPrompt(actor.id)
  ) {
    const token = signLinkClaimToken(
      {
        workspace_id: post.workspace_id,
        discord_user_id: actor.id,
        discord_username: actorLabel,
      },
      env.EMAIL_LINK_SECRET,
    );
    const linkUrl = `${siteUrl()}/integrations/discord/link?token=${encodeURIComponent(token)}`;
    // Fire-and-await — Discord API is fast and we're well inside the 3s
    // budget. Swallow errors so a flaky follow-up never breaks the primary
    // approve/reject UX.
    try {
      await createInteractionFollowup(p.token, {
        content:
          `Link your Discord account so future approvals attribute to you: ${linkUrl}` +
          ` (expires in 7 days).`,
        flags: FLAG_EPHEMERAL,
      });
    } catch (e) {
      console.log("[discord] link-prompt follow-up failed:", (e as Error).message);
    }
  }

  // Respond to Discord with UPDATE_MESSAGE so the original embed gets
  // re-rendered with buttons cleared and a "Approved by X" footer. Doing
  // it inline (instead of via deferred + follow-up) keeps the UX snappy.
  const summary: DigestPostSummary = {
    id: post.id,
    channel: post.channel,
    theme: post.theme,
    text: post.text,
    scheduledAt: post.scheduled_at,
  };
  const newMessage = buildActionedEmbed({
    original: summary,
    workspaceName: ws?.name ?? "workspace",
    verb: isApprove ? "Approved" : "Rejected",
    actor: actorLabel,
  });

  return NextResponse.json({
    type: INTERACTION_UPDATE_MESSAGE,
    data: newMessage,
  });
}

// ─────────────────────────────────────────────────────────────
// Slash-command bodies
// ─────────────────────────────────────────────────────────────

async function renderQueueSummary(workspaceId: string): Promise<string> {
  const svc = supabaseService();
  const { count, error } = await svc
    .from("posts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "pending_approval");
  if (error) return `Couldn't fetch queue: ${error.message}`;
  const n = count ?? 0;
  if (n === 0) return "Nothing pending. Inbox zero ✓";
  return `${n} post${n === 1 ? "" : "s"} pending. ${siteUrl()}/queue`;
}

async function renderStatsSummary(workspaceId: string): Promise<string> {
  const svc = supabaseService();
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const sinceIso = since.toISOString();

  // Three quick counts — pending, scheduled today, posted today.
  const [pending, scheduledToday, postedToday] = await Promise.all([
    svc
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "pending_approval"),
    svc
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "scheduled")
      .gte("scheduled_at", sinceIso),
    svc
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "posted")
      .gte("posted_at", sinceIso),
  ]);

  return [
    `**Today**`,
    `· Pending: ${pending.count ?? 0}`,
    `· Scheduled (today): ${scheduledToday.count ?? 0}`,
    `· Posted (today): ${postedToday.count ?? 0}`,
    siteUrl(),
  ].join("\n");
}

async function togglePause(workspaceId: string): Promise<string> {
  const svc = supabaseService();
  // Pause = turn off trust_mode on every connected channel. Snapshot the
  // current state so the message tells the operator what flipped.
  const { data: accounts, error } = await svc
    .from("social_accounts")
    .select("id, channel, trust_mode")
    .eq("workspace_id", workspaceId);
  if (error) return `Couldn't load channels: ${error.message}`;
  if (!accounts || accounts.length === 0) return "No channels connected yet.";

  const anyTrustOn = accounts.some((a) => a.trust_mode);
  const next = !anyTrustOn;
  const { error: upErr } = await svc
    .from("social_accounts")
    .update({ trust_mode: next })
    .eq("workspace_id", workspaceId);
  if (upErr) return `Couldn't update channels: ${upErr.message}`;
  return next
    ? `Trust-mode auto-posting **resumed** on ${accounts.length} channel${accounts.length === 1 ? "" : "s"}.`
    : `Trust-mode auto-posting **paused** on ${accounts.length} channel${accounts.length === 1 ? "" : "s"}.`;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function ephemeral(content: string): NextResponse {
  return NextResponse.json({
    type: INTERACTION_CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: content.slice(0, 1900),
      flags: FLAG_EPHEMERAL,
    },
  });
}

// Lint-quiet: the editInteractionResponse import is reserved for the
// deferred-response code path which we don't take today but want to keep
// available without re-importing later. Touch it here so the lint pass
// doesn't whine. (Removing the helper from the import list would be a
// regression the moment we ever defer.)
void editInteractionResponse;

// ─────────────────────────────────────────────────────────────
// Link-prompt rate limiter
// ─────────────────────────────────────────────────────────────
// Process-local map of `discord_user_id → last-prompt timestamp`. Keeps a
// user from getting nudged on every button click while they're working
// through a digest. Map is intentionally in-memory: on Vercel each
// instance gets its own, and the worst case is one extra prompt per cold
// start — which is better than the engineering cost of a per-user
// throttle row in the DB for a UX-only concern.
const LINK_PROMPT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const linkPromptLastSent = new Map<string, number>();

function shouldSendLinkPrompt(discordUserId: string): boolean {
  const now = Date.now();
  const last = linkPromptLastSent.get(discordUserId);
  if (last && now - last < LINK_PROMPT_WINDOW_MS) {
    return false;
  }
  linkPromptLastSent.set(discordUserId, now);
  // Hard cap the map size — prevents unbounded growth across many actors.
  // 500 is way over normal traffic; LRU-style purge by deleting the oldest
  // is fine since the timestamps are monotonic in insertion order.
  if (linkPromptLastSent.size > 500) {
    const firstKey = linkPromptLastSent.keys().next().value;
    if (firstKey !== undefined) linkPromptLastSent.delete(firstKey);
  }
  return true;
}

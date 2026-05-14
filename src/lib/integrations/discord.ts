// Discord REST helpers. Thin fetch wrappers over the channels.messages and
// applications.commands endpoints we actually use — we deliberately do NOT
// pull in `discord.js`, because (a) it carries a websocket-gateway runtime
// we don't need, (b) it's >1MB cold, and (c) the surface area we touch is
// tiny. Documented base URL is v10.
//
// All functions throw DiscordApiError on non-2xx so callers can either
// surface the message or swallow it (digest dispatcher only logs, never
// fails the cron run for a single bad channel).
//
// NEVER log the bot token. The Authorization header is constructed at call
// time from env; if you must add tracing here, redact the header before
// logging the request shape.

import { serverEnv } from "@/lib/env";

const API_BASE = "https://discord.com/api/v10";

export class DiscordApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public bodyExcerpt?: string,
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
}

function botToken(): string {
  const env = serverEnv();
  if (!env.DISCORD_BOT_TOKEN) {
    throw new DiscordApiError("DISCORD_BOT_TOKEN not configured", 0);
  }
  return env.DISCORD_BOT_TOKEN;
}

function appId(): string {
  const env = serverEnv();
  if (!env.DISCORD_CLIENT_ID) {
    throw new DiscordApiError("DISCORD_CLIENT_ID not configured", 0);
  }
  return env.DISCORD_CLIENT_ID;
}

interface FetchOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  json?: unknown;
  // Bot auth is the default; only the OAuth2 token-exchange call uses
  // Basic auth. Pass `auth: "none"` for routes that take the response auth
  // (e.g. follow-up via webhook token).
  auth?: "bot" | "none";
  // Optional alternative auth header value (Basic <base64> or Bearer <token>).
  authOverride?: string;
}

async function call(path: string, opts: FetchOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = {
    "User-Agent": "marketingmagic (https://marketingmagic.app, 1.0)",
  };
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (opts.authOverride) {
    headers["Authorization"] = opts.authOverride;
  } else if ((opts.auth ?? "bot") === "bot") {
    headers["Authorization"] = `Bot ${botToken()}`;
  }

  const resp = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? (opts.json ? "POST" : "GET"),
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
    cache: "no-store",
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new DiscordApiError(
      `Discord ${opts.method ?? "GET"} ${path} → ${resp.status}`,
      resp.status,
      text.slice(0, 300),
    );
  }

  // 204 No Content (common on DELETE) → return null instead of fighting JSON.
  if (resp.status === 204) return null;
  const ct = resp.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return null;
  return resp.json();
}

// ─────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  // Footer/timestamp are nice-to-haves but kept optional so the digest builder
  // can omit them when the data is missing rather than emitting empty fields.
  footer?: { text: string };
  timestamp?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export interface DiscordButton {
  type: 2;             // Component type 2 = Button
  style: 1 | 2 | 3 | 4 | 5; // primary/secondary/success/danger/link
  label: string;
  custom_id?: string;  // required for non-link buttons
  url?: string;        // required for style=5 (link)
  emoji?: { name: string };
  disabled?: boolean;
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordButton[];
}

export interface DiscordMessagePayload {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: DiscordActionRow[];
  // 1<<6 = EPHEMERAL — only visible to the user who triggered the interaction.
  flags?: number;
}

export interface DiscordMessageRef {
  id: string;
  channel_id: string;
}

export async function sendMessage(
  channelId: string,
  payload: DiscordMessagePayload,
): Promise<DiscordMessageRef> {
  const result = (await call(`/channels/${channelId}/messages`, { json: payload })) as
    | DiscordMessageRef
    | null;
  if (!result || typeof result.id !== "string") {
    throw new DiscordApiError("Discord sendMessage: unexpected response shape", 500);
  }
  return result;
}

export async function editMessage(
  channelId: string,
  messageId: string,
  payload: DiscordMessagePayload,
): Promise<void> {
  await call(`/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    json: payload,
  });
}

// Threads: start a thread anchored to a parent message. The digest builder
// uses this for "view all pending" drill-in so the channel stays quiet.
export async function startThread(
  channelId: string,
  parentMessageId: string,
  name: string,
): Promise<{ id: string }> {
  const result = (await call(
    `/channels/${channelId}/messages/${parentMessageId}/threads`,
    {
      json: {
        name: name.slice(0, 100), // Discord caps thread names at 100 chars
        auto_archive_duration: 1440, // 24h
      },
    },
  )) as { id?: string } | null;
  if (!result?.id) throw new DiscordApiError("startThread: missing id", 500);
  return { id: result.id };
}

// ─────────────────────────────────────────────────────────────
// Interaction follow-ups (used after a deferred response)
// ─────────────────────────────────────────────────────────────

// `original_response` PATCH edits the original interaction reply. Auth is
// the interaction's webhook token (NOT the bot token) — no Authorization
// header needed at all on this endpoint; auth is encoded in the URL path.
export async function editInteractionResponse(
  interactionToken: string,
  payload: DiscordMessagePayload,
): Promise<void> {
  await call(`/webhooks/${appId()}/${interactionToken}/messages/@original`, {
    method: "PATCH",
    json: payload,
    auth: "none",
  });
}

// ─────────────────────────────────────────────────────────────
// Slash command registration
// ─────────────────────────────────────────────────────────────

// Discord application-command structure (subset we use). The PUT endpoint
// overwrites all global commands in one shot — that's the idempotent
// shape we want so /api/integrations/discord/commands is safe to re-call.
export interface SlashCommand {
  name: string;
  description: string;
  options?: Array<{
    name: string;
    description: string;
    type: number; // 1 = sub-command, 3 = string, etc.
    required?: boolean;
  }>;
}

export async function registerGlobalCommands(commands: SlashCommand[]): Promise<void> {
  await call(`/applications/${appId()}/commands`, {
    method: "PUT",
    json: commands,
  });
}

// ─────────────────────────────────────────────────────────────
// OAuth2 token exchange
// ─────────────────────────────────────────────────────────────

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  // Present when scope includes `bot` — the guild the bot was installed to.
  guild?: { id: string; name: string };
}

export async function exchangeOAuthCode(args: {
  code: string;
  redirectUri: string;
}): Promise<OAuthTokenResponse> {
  const env = serverEnv();
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    throw new DiscordApiError("Discord OAuth not configured", 0);
  }

  const body = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
  });

  // Token endpoint doesn't follow the JSON-body convention of the rest of
  // the API — must be form-urlencoded with Basic auth optional. We use the
  // body-credentials form (client_id + client_secret in body) which is
  // explicitly supported and simpler.
  const resp = await fetch(`${API_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "marketingmagic (https://marketingmagic.app, 1.0)",
    },
    body: body.toString(),
    cache: "no-store",
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new DiscordApiError(
      `Discord OAuth token exchange failed: ${resp.status}`,
      resp.status,
      text.slice(0, 300),
    );
  }

  return (await resp.json()) as OAuthTokenResponse;
}

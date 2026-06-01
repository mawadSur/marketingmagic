import { z } from "zod";

const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  CRON_SECRET: z.string().min(16),
  WEBHOOK_DEV_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().min(8).optional()),
  // Optional explicit site URL. When unset we fall back to VERCEL_URL (auto-
  // injected on Vercel) or localhost. Read through siteUrl() everywhere —
  // never touch this field directly so the fallback chain is honoured.
  NEXT_PUBLIC_SITE_URL: z.preprocess(v => (v === "" ? undefined : v), z.string().url().optional()),
  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),
  // Image generation (fal.ai). Optional so the app boots without it; image
  // features short-circuit with a clear error when the key is missing.
  FAL_API_KEY: z.preprocess(v => (v === "" ? undefined : v), z.string().min(8).optional()),
  FAL_DEFAULT_MODEL: z.string().min(1).default("fal-ai/flux/schnell"),
  // LinkedIn OAuth (Sign In with LinkedIn + w_member_social).
  LINKEDIN_CLIENT_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  LINKEDIN_CLIENT_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  // Meta's "Use cases" model in 2025 issues separate App ID/Secret pairs per
  // product. We keep them split so each channel uses its own credentials —
  // the alternative (one umbrella app) hits App Review snags because Meta
  // reviews each product's surface independently.
  //
  // - META_APP_ID/SECRET — the main "umbrella" app credentials from
  //   App Settings → Basic. Used to verify signed_request payloads on the
  //   data-deletion callback when the user removed the umbrella app itself,
  //   and reserved for any future Facebook Page channel.
  // - INSTAGRAM_APP_ID/SECRET — credentials from the Instagram product
  //   ("Instagram API with Instagram Login"). Used by the IG OAuth flow.
  // - THREADS_APP_ID/SECRET — credentials from the Threads API product.
  //   Used by the Threads OAuth flow.
  META_APP_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  META_APP_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  // Facebook Login for Business "Configuration ID" — created under the FLB
  // product in the Meta App Dashboard. FLB binds permissions/assets to the
  // configuration rather than to the OAuth URL, so we send `config_id` in
  // place of `scope=`. Without this set, /dialog/oauth crashes with the
  // generic "Something Went Wrong" Comet error because the app has FLB
  // (not classic Facebook Login) configured.
  META_FB_LOGIN_CONFIG_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  INSTAGRAM_APP_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  INSTAGRAM_APP_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  THREADS_APP_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  THREADS_APP_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  // TikTok Content Posting API (OAuth 2.0 PKCE + chunked video publish).
  // ⚠️ TikTok deviates from every other provider: the public client identifier
  // is the "client KEY" (sent as `client_key`), NOT a `client_id`. Do not
  // rename these to *_CLIENT_ID — the OAuth endpoints reject `client_id`.
  // Both optional with the same graceful-degrade pattern as the other
  // providers: when unset, the TikTok connect UI is hidden and the OAuth
  // routes redirect with a "tiktok_not_configured" error instead of throwing.
  TIKTOK_CLIENT_KEY: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  TIKTOK_CLIENT_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  // Resend transactional email — used by the daily approval digest cron.
  // Optional: when unset the digest route logs and skips instead of throwing,
  // so the rest of the app keeps booting without an email provider configured.
  RESEND_API_KEY: z.preprocess(v => (v === "" ? undefined : v), z.string().min(8).optional()),
  // Secret used to HMAC-sign approve/reject magic links in digest emails.
  // Min 32 chars so the signing key has enough entropy. Optional with the
  // same graceful-degrade pattern as RESEND_API_KEY.
  EMAIL_LINK_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().min(32).optional()),
  // From-address for the digest. Defaults to a noreply on our brand domain;
  // override per environment if you want a different sender.
  EMAIL_FROM: z
    .preprocess(v => (v === "" ? undefined : v), z.string().optional())
    .default("marketingmagic <noreply@marketingmagic.app>"),
  // Stripe billing. All optional so the app still boots when billing is
  // not configured (Hobby tier is the default in DB, so unpaid features
  // just keep working without these). When STRIPE_SECRET_KEY is missing,
  // stripeClient() throws a clear error at the call site.
  STRIPE_SECRET_KEY: z.preprocess(v => (v === "" ? undefined : v), z.string().min(8).optional()),
  STRIPE_WEBHOOK_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().min(8).optional()),
  STRIPE_PRICE_PRO: z.preprocess(v => (v === "" ? undefined : v), z.string().min(4).optional()),
  STRIPE_PRICE_AGENCY: z.preprocess(v => (v === "" ? undefined : v), z.string().min(4).optional()),
  // Phase 2.6 Founder tier. Optional like the others — when missing, the
  // pricing page hides the upgrade affordance for Founder and existing
  // subscribers degrade gracefully (planForPriceId returns null).
  STRIPE_PRICE_FOUNDER: z.preprocess(v => (v === "" ? undefined : v), z.string().min(4).optional()),
  // Discord bot integration (Phase 4.7). All optional so the app boots without
  // Discord configured — `/integrations/discord` renders a "configure to enable"
  // empty state and the digest cron silently skips Discord transport.
  // - CLIENT_ID + CLIENT_SECRET drive the bot install OAuth2 flow.
  // - PUBLIC_KEY verifies Ed25519 signatures on inbound interaction webhooks.
  // - BOT_TOKEN authenticates outbound REST calls (channels.messages.create,
  //   etc.). Never logged anywhere — treat as a high-blast-radius secret.
  DISCORD_CLIENT_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().min(4).optional()),
  DISCORD_CLIENT_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().min(8).optional()),
  DISCORD_PUBLIC_KEY: z.preprocess(v => (v === "" ? undefined : v), z.string().min(32).optional()),
  DISCORD_BOT_TOKEN: z.preprocess(v => (v === "" ? undefined : v), z.string().min(16).optional()),
  // Groq — hosted Whisper transcription for Phase 2.5 source ingestion
  // (YouTube / podcast / MP3 → text). Optional; when unset the audio/video
  // ingestion paths gracefully short-circuit with "transcription unavailable"
  // and HTML / PDF / paste-transcript paths still work. Get a free key at
  // https://console.groq.com/keys.
  GROQ_API_KEY: z.preprocess(v => (v === "" ? undefined : v), z.string().min(8).optional()),
  // Phase 2 (Video) — MoneyPrinterTurbo (MPT) BYO render worker. MPT can't
  // run in Vercel (ffmpeg, 5-15min renders) so it lives in an external
  // container and MM orchestrates it over HTTP. All optional: when
  // MPT_BASE_URL is unset, video features cleanly short-circuit
  // (mptConfigured() === false) instead of crashing — the same
  // graceful-degrade shape as FAL_API_KEY / RESEND_API_KEY.
  // - MPT_BASE_URL — base URL of the MPT FastAPI service, no trailing slash.
  // - MPT_API_TOKEN — sent as the `x-api-key` header on every MPT call.
  MPT_BASE_URL: z.preprocess(v => (v === "" ? undefined : v), z.string().url().optional()),
  MPT_API_TOKEN: z.preprocess(v => (v === "" ? undefined : v), z.string().min(8).optional()),
  // 32-byte key for AES-256-GCM encryption of workspace BYO credentials
  // (LLM + Pexels keys) before they hit workspace_byo_keys.ciphertext.
  // Accepts 64 hex chars or 44 base64 chars (both decode to 32 bytes);
  // validated for length at decode time in src/lib/video/byo-keys.ts.
  // Optional so the app boots without it — setWorkspaceKeys/getWorkspaceKeys
  // throw a clear error when it's missing rather than corrupting data.
  BYO_ENCRYPTION_KEY: z.preprocess(v => (v === "" ? undefined : v), z.string().min(32).optional()),
  // Phase 3 (Video publishing) — allowlist of channels permitted to publish
  // video in this deployment. Comma-separated channel ids (e.g.
  // "bluesky,facebook,threads"). Video publish code ships for every channel,
  // but only channels listed here actually post; the rest throw a clear
  // "video publishing not yet enabled" error in dispatch's video branch.
  // This lets us merge all adapters while keeping app-review-gated channels
  // (IG Reels, X media.write re-auth, LinkedIn org video) dark until their
  // permission is live. Read through videoPublishEnabled() — never touch this
  // field directly so the default allowlist is honoured. Default (when unset)
  // is the three channels that need no new app-review grant.
  VIDEO_PUBLISH_CHANNELS: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  // SPIKE — Reference-image video (bet ④). Master kill-switch for the NEW
  // image-conditioned / talking-avatar generation path (distinct from the MPT
  // Pexels-stitch pipeline). Off by default: when unset/false the provider stub
  // throws and the upload UI renders a "not yet enabled" state, so nothing
  // ships live. Accepts "1"/"true" (case-insensitive). Read through
  // referenceVideoEnabled() — never touch this field directly.
  REFERENCE_VIDEO_ENABLED: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  // Reference-image video (bet ④) — the fal.ai image-to-video model id the
  // adapter submits to. Overridable so the model isn't hardcoded; defaults to a
  // Kling image-to-video STANDARD tier (cheapest, good enough for "animate my
  // photo" B-roll). Read through referenceVideoFalModel(). Only meaningful when
  // REFERENCE_VIDEO_ENABLED is on.
  REFERENCE_VIDEO_FAL_MODEL: z
    .string()
    .min(1)
    .default("fal-ai/kling-video/v1.6/standard/image-to-video"),
});

const publicSchema = serverSchema.pick({
  NEXT_PUBLIC_SUPABASE_URL: true,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: true,
  NEXT_PUBLIC_SITE_URL: true,
});

type ServerEnv = z.infer<typeof serverSchema>;
type PublicEnv = z.infer<typeof publicSchema>;

let cachedServer: ServerEnv | null = null;
let cachedPublic: PublicEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cachedServer) return cachedServer;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid server env: ${parsed.error.message}`);
  }
  cachedServer = parsed.data;
  return cachedServer;
}

export function publicEnv(): PublicEnv {
  if (cachedPublic) return cachedPublic;
  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  });
  if (!parsed.success) {
    throw new Error(`Invalid public env: ${parsed.error.message}`);
  }
  cachedPublic = parsed.data;
  return cachedPublic;
}

// Resolve the effective public site URL. Preferred sources in order:
//   1. NEXT_PUBLIC_SITE_URL — operator-set; needed for custom domains and
//      OAuth redirect URIs / auth email links that must match a registered value.
//   2. VERCEL_PROJECT_PRODUCTION_URL — the STABLE production domain, auto-injected
//      on every Vercel deployment (incl. previews). Unlike VERCEL_URL it does not
//      change per deploy, so auth-email redirect_to values stay allowlistable —
//      using the ephemeral VERCEL_URL here is what makes Supabase reject the
//      redirect and fall back to its (often localhost) Site URL.
//   3. VERCEL_URL — ephemeral per-deployment URL; last Vercel resort.
//   4. localhost — final fallback so dev/builds without any URL still work.
// Always returns a value with a protocol and no trailing slash.
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (prod) return `https://${prod.replace(/\/$/, "")}`;
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;
  return "http://localhost:3000";
}

// True when the MPT render worker is wired up. Video features (orchestrator,
// poll cron, future P4 UI) gate on this so the app degrades cleanly instead
// of throwing when the optional MPT env is absent. Both the base URL and the
// token are required for any MPT call to succeed, so we check both.
export function mptConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.MPT_BASE_URL && env.MPT_API_TOKEN);
}

// True when BYO credential storage is usable. setWorkspaceKeys/getWorkspaceKeys
// need BYO_ENCRYPTION_KEY to AES-encrypt/decrypt; without it the video-keys
// settings UI (P4) can't store anything, so the page renders a "not available"
// state instead of letting a user submit keys that would throw at write time.
export function byoKeysConfigured(): boolean {
  return Boolean(serverEnv().BYO_ENCRYPTION_KEY);
}

// True when the end-to-end video feature is usable on this deployment: the MPT
// render worker is wired up AND we can encrypt the BYO keys it needs. Both the
// video-keys settings page and the generator gate on this so the feature
// degrades cleanly to a "video not available" notice when either half is
// missing, mirroring the FAL_API_KEY / Stripe graceful-degrade pattern.
export function videoFeatureConfigured(): boolean {
  return mptConfigured() && byoKeysConfigured();
}

// Channels permitted to publish video, parsed once from VIDEO_PUBLISH_CHANNELS.
// Defaults to the three channels that need no new app-review grant:
//   - bluesky  — app-password auth, no review gate at all
//   - facebook — pages_manage_posts already covers feed video
//   - threads  — threads_content_publish (the scope we already request)
// Channels gated on a pending grant (instagram, x, linkedin org video) are
// intentionally OFF by default and only flip on once the operator adds them to
// the env after the corresponding permission is live.
const DEFAULT_VIDEO_CHANNELS = "bluesky,facebook,threads";

// True when `channel` is allowed to publish video on this deployment. Backed by
// the VIDEO_PUBLISH_CHANNELS env allowlist (comma-separated). dispatch's video
// branch calls this before invoking any per-channel video uploader, so the code
// can ship for every channel while only greenlit channels actually post.
export function videoPublishEnabled(channel: string): boolean {
  const raw = serverEnv().VIDEO_PUBLISH_CHANNELS ?? DEFAULT_VIDEO_CHANNELS;
  const allow = new Set(
    raw
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean),
  );
  return allow.has(channel.trim().toLowerCase());
}

// SPIKE — True when the reference-image video path (bet ④) is enabled on this
// deployment. Off by default. The provider stub and the upload UI both gate on
// this so the feature stays dark until an operator flips REFERENCE_VIDEO_ENABLED
// AND a real provider adapter is wired (see
// docs/designs/reference-image-video-spike.md). Mirrors the graceful-degrade
// shape of mptConfigured() / videoPublishEnabled().
export function referenceVideoEnabled(): boolean {
  const raw = serverEnv().REFERENCE_VIDEO_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

// Reference-image video (bet ④) — the fal.ai image-to-video model id the adapter
// submits to. Overridable via REFERENCE_VIDEO_FAL_MODEL so it's not hardcoded;
// defaults to a Kling image-to-video standard tier. Used by the fal video
// adapter to build the queue endpoint URL.
export function referenceVideoFalModel(): string {
  return serverEnv().REFERENCE_VIDEO_FAL_MODEL;
}

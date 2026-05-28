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
//      OAuth redirect URIs that must match a registered value.
//   2. VERCEL_URL — auto-injected on every Vercel deployment, no scheme.
//   3. localhost — final fallback so dev/builds without any URL still work.
// Always returns a value with a protocol and no trailing slash.
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;
  return "http://localhost:3000";
}

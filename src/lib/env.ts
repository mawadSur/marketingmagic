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
  // Meta (Threads + Instagram share these).
  META_APP_ID: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
  META_APP_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().optional()),
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

import { z } from "zod";

const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  CRON_SECRET: z.string().min(16),
  WEBHOOK_DEV_SECRET: z.preprocess(v => (v === "" ? undefined : v), z.string().min(8).optional()),
  NEXT_PUBLIC_SITE_URL: z.string().url(),
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

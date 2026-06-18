"use server";

import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/env";

export type ForgotPasswordState = { error: string | null; info: string | null };

const schema = z.object({ email: z.string().email() });

export async function forgotPasswordAction(
  _prev: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const parsed = schema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { error: "Enter a valid email address.", info: null };
  }

  // Neutral, always-the-same response — never reveal whether an email has an
  // account (account-enumeration guard). The send is best-effort: even if
  // Supabase rate-limits or the address is unknown, we report the same line.
  const neutral = "If that email has an account, a reset link is on its way. Check your inbox.";

  const supabase = await supabaseServer();
  // The recovery link routes through /auth/callback (server-side code exchange,
  // which mints the recovery session), then on to /reset-password where the user
  // chooses a new password.
  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent("/reset-password")}`,
  });

  return { error: null, info: neutral };
}

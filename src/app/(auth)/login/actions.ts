"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";

export type LoginActionState = { error: string | null };

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  next: z.string().startsWith("/").optional(),
});

export async function loginAction(_prev: LoginActionState, formData: FormData): Promise<LoginActionState> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? "/dashboard",
  });
  if (!parsed.success) {
    return { error: "Enter a valid email and password." };
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) {
    return { error: error.message };
  }
  redirect(parsed.data.next ?? "/dashboard");
}

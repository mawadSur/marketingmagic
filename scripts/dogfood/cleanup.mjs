// Deletes the throwaway dogfood user + its workspace (posts + social_accounts
// cascade) from the live DB. Reads /tmp/mm-dogfood/user.json.
// Usage: node scripts/dogfood/cleanup.mjs
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { id, email, workspaceSlug } = JSON.parse(
  readFileSync("/tmp/mm-dogfood/user.json", "utf8"),
);

// workspaces.owner_id is ON DELETE RESTRICT; drop the user's workspaces first
// (posts + social_accounts cascade from the workspace), then the auth user.
const { error: wErr } = await admin.from("workspaces").delete().eq("owner_id", id);
const { error: uErr } = await admin.auth.admin.deleteUser(id);

console.log(
  JSON.stringify(
    { deletedUser: email, workspaceSlug, wErr: wErr?.message ?? null, uErr: uErr?.message ?? null },
    null,
    2,
  ),
);

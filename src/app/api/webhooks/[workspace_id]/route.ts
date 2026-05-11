import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { supabaseService } from "@/lib/supabase/service";
import { render } from "@/lib/events/template";
import type { Channel, Json, PostStatus } from "@/lib/db/types";

// Event ingestion endpoint.
//
// External system POSTs JSON with header `x-mm-signature: sha256=<hex>`, where the
// signature is HMAC-SHA256 of the raw body using workspaces.webhook_secret.
//
// On valid signature:
//   1. Insert events row with the raw payload.
//   2. Lookup enabled event_rules matching event_type.
//   3. For each rule, render the template, insert a post per channel as pending_approval
//      (or scheduled if the account's trust_mode is on; see V1-14).
//   4. Mark events.processed_at.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface BodyShape {
  event_type: string;
  payload: Record<string, unknown>;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspace_id: string }> },
) {
  const { workspace_id } = await params;
  const rawBody = await req.text();
  const signature = req.headers.get("x-mm-signature") ?? "";

  const svc = supabaseService();
  const { data: ws } = await svc
    .from("workspaces")
    .select("id, webhook_secret")
    .eq("id", workspace_id)
    .maybeSingle();
  if (!ws || !ws.webhook_secret) {
    return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  }
  if (!verifySignature(rawBody, signature, ws.webhook_secret)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let body: BodyShape;
  try {
    body = JSON.parse(rawBody) as BodyShape;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.event_type || typeof body.event_type !== "string") {
    return NextResponse.json({ error: "missing event_type" }, { status: 400 });
  }

  const { data: eventRow, error: insertErr } = await svc
    .from("events")
    .insert({
      workspace_id: ws.id,
      event_type: body.event_type,
      payload: body.payload as unknown as Json,
      source: req.headers.get("x-mm-source") ?? null,
    })
    .select("id")
    .single();
  if (insertErr || !eventRow) {
    return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
  }

  const { data: rules } = await svc
    .from("event_rules")
    .select("id, channels, template, theme, enabled")
    .eq("workspace_id", ws.id)
    .eq("event_type", body.event_type)
    .eq("enabled", true);

  const createdPosts: string[] = [];
  for (const rule of rules ?? []) {
    const text = render(rule.template, body.payload).trim();
    if (!text) continue;

    for (const channel of rule.channels) {
      const ch = channel as Channel;
      const { data: account } = await svc
        .from("social_accounts")
        .select("id, trust_mode")
        .eq("workspace_id", ws.id)
        .eq("channel", ch)
        .eq("status", "connected")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!account) continue;

      const trusted = account.trust_mode === true;
      const status: PostStatus = trusted ? "scheduled" : "pending_approval";
      const scheduled_at = trusted
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24h preview window
        : new Date(Date.now() + 60 * 60 * 1000).toISOString();

      const { data: inserted } = await svc
        .from("posts")
        .insert({
          workspace_id: ws.id,
          social_account_id: account.id,
          channel: ch,
          text: text.slice(0, ch === "x" ? 280 : 2000),
          theme: rule.theme,
          status,
          scheduled_at,
          source_event_id: eventRow.id,
          generation_metadata: { event_type: body.event_type, rule_id: rule.id },
        })
        .select("id")
        .single();
      if (inserted) createdPosts.push(inserted.id);
    }
  }

  await svc.from("events").update({ processed_at: new Date().toISOString() }).eq("id", eventRow.id);

  return NextResponse.json({ ok: true, event_id: eventRow.id, posts: createdPosts });
}

function verifySignature(body: string, header: string, secret: string): boolean {
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  // Reject early if shapes don't match — timingSafeEqual requires equal length.
  if (header.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

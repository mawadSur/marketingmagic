import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { dispatchPost, type PostMediaItem } from "@/lib/social/dispatch";
import { readThreadMeta } from "@/lib/threads/schema";
import { postThread } from "@/lib/threads/post";
import type { XCredentials } from "@/lib/social/x";

// Vercel Cron — POST to this every 5 minutes. Auth via Bearer CRON_SECRET.
// Picks scheduled posts whose time has arrived, ships them via the per-channel
// dispatcher, writes idempotency ledger.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BATCH = 25;

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const svc = supabaseService();
  const nowIso = new Date().toISOString();

  const { data: posts, error: pickErr } = await svc
    .from("posts")
    .select(
      "id, workspace_id, social_account_id, channel, text, scheduled_at, media, generation_metadata, idea_id",
    )
    .eq("status", "scheduled")
    .lte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(BATCH);

  if (pickErr) {
    return NextResponse.json({ error: pickErr.message }, { status: 500 });
  }

  const results: Array<{
    id: string;
    status: "posted" | "skipped" | "failed" | "partial";
    reason?: string;
  }> = [];

  // Phase 6.8 — bucket X-thread rows so we post the whole thread at once
  // (not one tweet per cron tick). A row qualifies as a thread member
  // when channel='x' AND generation_metadata.thread.is_thread=true. We
  // dispatch the thread on the *first* row we encounter for each idea_id
  // in the batch, then short-circuit subsequent rows in the same idea
  // since `postThread` already handled them.
  const handledThreads = new Set<string>();

  for (const post of posts ?? []) {
    // Detect thread membership before doing anything else.
    const threadMeta = readThreadMeta(post.generation_metadata);
    const isThreadMember = post.channel === "x" && threadMeta !== null && post.idea_id;

    if (isThreadMember) {
      const ideaId = post.idea_id as string;
      if (handledThreads.has(ideaId)) {
        // Another row in this thread was already processed in this tick;
        // postThread updated all rows in one shot.
        results.push({ id: post.id, status: "skipped", reason: "thread already handled this tick" });
        continue;
      }
      handledThreads.add(ideaId);

      const { data: account, error: acctErr } = await svc
        .from("social_accounts")
        .select("credentials, successful_post_count")
        .eq("id", post.social_account_id)
        .maybeSingle();
      if (acctErr || !account) {
        await markFailed(post.id, acctErr?.message ?? "account missing");
        results.push({ id: post.id, status: "failed", reason: "account missing" });
        continue;
      }

      try {
        const outcome = await postThread(
          svc,
          ideaId,
          account.credentials as unknown as XCredentials,
        );
        if (outcome.failureAtIndex === null) {
          results.push({
            id: post.id,
            status: "posted",
            reason: `thread ${outcome.posted + outcome.alreadyPosted}/${outcome.totalTweets} posted`,
          });
          // Best-effort bump on the account's success counter (count the
          // newly-posted tweets — keeps the stat honest on partial-retry runs).
          if (outcome.posted > 0) {
            await svc
              .from("social_accounts")
              .update({
                successful_post_count: (account.successful_post_count ?? 0) + outcome.posted,
              })
              .eq("id", post.social_account_id);
          }
        } else {
          results.push({
            id: post.id,
            status: "partial",
            reason:
              outcome.failureReason ??
              `thread interrupted at tweet ${outcome.failureAtIndex}/${outcome.totalTweets}`,
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : "thread post failed";
        // Don't blanket-fail every row — load the thread rows again and mark
        // only the unposted ones so the user can retry.
        try {
          const { data: rows } = await svc
            .from("posts")
            .select("id, external_id")
            .eq("idea_id", ideaId);
          for (const r of rows ?? []) {
            if (!r.external_id) {
              await svc
                .from("posts")
                .update({ status: "failed", failure_reason: reason.slice(0, 1000) })
                .eq("id", r.id);
            }
          }
        } catch {
          // Best-effort fallback to the per-row mark.
          await markFailed(post.id, reason);
        }
        results.push({ id: post.id, status: "failed", reason });
      }
      continue;
    }

    // ─── Standard (non-thread) single-post path ───
    // Idempotency check.
    const { data: existing } = await svc
      .from("social_posts_ledger")
      .select("external_id")
      .eq("workspace_id", post.workspace_id)
      .eq("channel", post.channel)
      .eq("event_key", `post:${post.id}`)
      .maybeSingle();
    if (existing) {
      await svc
        .from("posts")
        .update({ status: "posted", external_id: existing.external_id, posted_at: nowIso })
        .eq("id", post.id);
      results.push({ id: post.id, status: "skipped", reason: "already posted (ledger hit)" });
      continue;
    }

    const { data: account, error: acctErr } = await svc
      .from("social_accounts")
      .select("credentials, successful_post_count")
      .eq("id", post.social_account_id)
      .maybeSingle();
    if (acctErr || !account) {
      await markFailed(post.id, acctErr?.message ?? "account missing");
      results.push({ id: post.id, status: "failed", reason: "account missing" });
      continue;
    }

    try {
      const media = (post.media ?? []) as unknown as PostMediaItem[];
      const sent = await dispatchPost(
        svc,
        post.channel,
        account.credentials,
        post.text,
        media,
      );

      const { error: ledgerErr } = await svc.from("social_posts_ledger").insert({
        workspace_id: post.workspace_id,
        channel: post.channel,
        event_key: `post:${post.id}`,
        external_id: sent.externalId,
        payload: { text: post.text },
      });
      if (ledgerErr && !ledgerErr.message.includes("duplicate")) {
        throw new Error(`ledger write failed: ${ledgerErr.message}`);
      }

      await svc
        .from("posts")
        .update({ status: "posted", external_id: sent.externalId, posted_at: new Date().toISOString() })
        .eq("id", post.id);

      await svc
        .from("social_accounts")
        .update({ successful_post_count: (account.successful_post_count ?? 0) + 1 })
        .eq("id", post.social_account_id);

      results.push({ id: post.id, status: "posted" });
    } catch (err) {
      await markFailed(post.id, err instanceof Error ? err.message : "unknown error");
      results.push({
        id: post.id,
        status: "failed",
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  return NextResponse.json({ checked: posts?.length ?? 0, results, at: nowIso });

  async function markFailed(postId: string, reason: string) {
    await svc
      .from("posts")
      .update({ status: "failed", failure_reason: reason.slice(0, 1000) })
      .eq("id", postId);
  }
}

function authorized(req: NextRequest): boolean {
  const env = serverEnv();
  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${env.CRON_SECRET}`) return true;
  const qs = req.nextUrl.searchParams.get("secret");
  return qs === env.CRON_SECRET;
}

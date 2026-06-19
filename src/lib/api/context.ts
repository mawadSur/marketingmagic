import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Channel, PostStatus } from "@/lib/db/types";
import type { ChannelId } from "@/lib/channels/registry";
import { supabaseService } from "@/lib/supabase/service";
import { overLimitAccountIds } from "@/lib/billing/limits";
import { notFound, channelNotConnected, channelOverLimit } from "@/lib/api/errors";
import { dedupePosts, dedupMetaFromResult } from "@/lib/dedup/gate";
import { hashContent } from "@/lib/dedup/similarity";

// ─── ApiContext — the workspace-scoped data facade ──────────────────────────
//
// THE LOAD-BEARING INVARIANT of the public API: the request path authenticates
// by API key and uses the SERVICE-ROLE client, which BYPASSES Postgres RLS. So
// the database no longer isolates tenants — THIS CLASS DOES. Every read and
// write here applies `.eq("workspace_id", this.workspaceId)`. Route handlers
// are given an ApiContext and must NEVER reach for supabaseService() directly;
// that is the one rule that keeps workspace A out of workspace B's data.
//
// If you add a method, it MUST scope by this.workspaceId. There is no exception.

export interface ApiContext {
  readonly workspaceId: string;
  readonly scopes: readonly string[];
  readonly svc: SupabaseClient<Database>;
}

export interface NewPostInput {
  channel: string;
  text: string;
  socialAccountId?: string;
  scheduledAt?: string | null;
  media?: Database["public"]["Tables"]["posts"]["Row"]["media"];
  theme?: string | null;
}

export class WorkspaceApi implements ApiContext {
  readonly workspaceId: string;
  readonly scopes: readonly string[];
  readonly svc: SupabaseClient<Database>;

  constructor(workspaceId: string, scopes: readonly string[], svc?: SupabaseClient<Database>) {
    this.workspaceId = workspaceId;
    this.scopes = scopes;
    this.svc = svc ?? supabaseService();
  }

  // ── Channels ──────────────────────────────────────────────────────────────
  /** Connected channels for this workspace, credentials redacted (safe view). */
  async listChannels() {
    const { data, error } = await this.svc
      .from("social_accounts_safe")
      .select("id, channel, handle, status, trust_mode, successful_post_count, created_at")
      .eq("workspace_id", this.workspaceId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
  }

  /**
   * Resolve the social_account row for a channel within THIS workspace. When
   * `socialAccountId` is given it must belong to this workspace (else not_found,
   * never a cross-tenant leak). When absent, picks the first connected account
   * for the channel. Throws channel_not_connected when none exists.
   */
  async resolveAccountForChannel(channel: string, socialAccountId?: string) {
    let q = this.svc
      .from("social_accounts")
      .select("id, channel, status")
      .eq("workspace_id", this.workspaceId)
      .eq("channel", channel as Channel);
    if (socialAccountId) q = q.eq("id", socialAccountId);
    const { data, error } = await q.limit(1).maybeSingle();
    if (error) throw error;
    if (!data) {
      // If an id was supplied and didn't resolve, it's either wrong or belongs
      // to another workspace — surface not_found, not channel_not_connected, so
      // we never confirm an id exists elsewhere.
      throw socialAccountId ? notFound("Channel account") : channelNotConnected(channel);
    }
    return data;
  }

  // ── Posts ──────────────────────────────────────────────────────────────────
  async listPosts(opts?: { status?: string; limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const offset = Math.max(opts?.offset ?? 0, 0);
    let q = this.svc
      .from("posts")
      .select("id, channel, text, status, scheduled_at, posted_at, external_id, theme, created_at")
      .eq("workspace_id", this.workspaceId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (opts?.status) q = q.eq("status", opts.status as PostStatus);
    const { data, error } = await q;
    if (error) throw error;
    return data ?? [];
  }

  async getPost(id: string) {
    const { data, error } = await this.svc
      .from("posts")
      .select(
        "id, channel, text, status, scheduled_at, posted_at, external_id, failure_reason, theme, media, created_at",
      )
      .eq("workspace_id", this.workspaceId)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw notFound("Post");
    return data;
  }

  /**
   * Create a scheduled post. Deliberately does NOT publish inline — it writes a
   * row with status 'scheduled' and lets the existing post-scheduled cron (5-min
   * cadence, with its idempotency ledger + retry) ship it. The API reuses the
   * whole battle-tested publish path for free.
   *
   * Dedup parity with the in-app + webhook insert-paths: an exact/near repeat of
   * the workspace's recent or queued content is forced to 'pending_approval'
   * (never silently auto-published via the API) and tagged with the match. The
   * gate runs fail-SAFE — a corpus read blip flags the post for review rather
   * than letting a possible duplicate through — and we always stamp content_hash
   * so this row is dedup-able by every future insert-path.
   */
  async createPost(input: NewPostInput) {
    const account = await this.resolveAccountForChannel(input.channel, input.socialAccountId);

    // Enforce the plan's connected-channel cap, mirroring the cron's behaviour
    // (don't let the API be a side-door around billing limits).
    const overLimit = await overLimitAccountIds(this.workspaceId, this.svc);
    if (overLimit.has(account.id)) throw channelOverLimit();

    // A past or absent scheduled_at means "as soon as possible" — schedule for
    // now and the next cron tick ships it (sub-5-min latency, fine for v1).
    const scheduledAt =
      input.scheduledAt && new Date(input.scheduledAt).getTime() > Date.now()
        ? new Date(input.scheduledAt).toISOString()
        : new Date().toISOString();

    const [verdict] = await dedupePosts(
      this.workspaceId,
      [{ text: input.text, channel: input.channel as ChannelId }],
      { failSafe: true },
    );
    const isDup = verdict !== undefined && verdict.verdict !== "ok";
    const dedupMeta = dedupMetaFromResult(verdict);

    const { data, error } = await this.svc
      .from("posts")
      .insert({
        workspace_id: this.workspaceId,
        social_account_id: account.id,
        channel: input.channel as Database["public"]["Tables"]["posts"]["Insert"]["channel"],
        text: input.text,
        media: input.media ?? [],
        theme: input.theme ?? null,
        scheduled_at: scheduledAt,
        status: isDup ? "pending_approval" : "scheduled",
        content_hash: hashContent(input.text),
        generation_metadata: { source: "public_api", ...(dedupMeta ? { dedup: dedupMeta } : {}) },
      })
      .select("id, channel, text, status, scheduled_at, created_at")
      .single();
    if (error) throw error;
    return data;
  }

  /** Cancel a scheduled post (workspace-scoped). Returns false when not cancellable. */
  async cancelPost(id: string): Promise<boolean> {
    // Ensure it exists in THIS workspace first (throws not_found otherwise).
    const post = await this.getPost(id);
    if (!["draft", "pending_approval", "approved", "scheduled"].includes(post.status)) {
      return false; // already posted / failed / archived — nothing to cancel
    }
    const { error } = await this.svc
      .from("posts")
      .update({ status: "archived" })
      .eq("workspace_id", this.workspaceId)
      .eq("id", id);
    if (error) throw error;
    return true;
  }
}

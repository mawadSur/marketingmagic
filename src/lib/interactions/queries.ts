// Phase 4.5 — server-side queries for /inbox and the dashboard widget.

import { supabaseServer } from "@/lib/supabase/server";
import type { Database } from "@/lib/db/types";
import {
  type InteractionChannel,
  type InteractionPriority,
  type InteractionStatus,
  type InteractionAgeFilter,
  PRIORITY_HIGH_MIN,
  PRIORITY_MEDIUM_MIN,
} from "./schema";

type InteractionRow = Database["public"]["Tables"]["interactions"]["Row"];

export interface InboxQueryOptions {
  workspaceId: string;
  channel?: InteractionChannel | null;
  priority?: InteractionPriority | null;
  age?: InteractionAgeFilter | null;
  status?: InteractionStatus | null;
  limit?: number;
}

const DEFAULT_LIMIT = 50;

export async function getInboxInteractions(opts: InboxQueryOptions): Promise<InteractionRow[]> {
  const supabase = await supabaseServer();
  let query = supabase
    .from("interactions")
    .select("*")
    .eq("workspace_id", opts.workspaceId);

  // Default to non-dismissed when no explicit status filter is set.
  // Snoozed rows are hidden unless we explicitly look at them.
  if (opts.status) {
    query = query.eq("status", opts.status);
  } else {
    query = query.in("status", ["unread", "read", "replied"]);
  }

  if (opts.channel) {
    query = query.eq("channel", opts.channel);
  }

  if (opts.priority === "high") {
    query = query.gte("priority_score", PRIORITY_HIGH_MIN);
  } else if (opts.priority === "medium") {
    query = query
      .gte("priority_score", PRIORITY_MEDIUM_MIN)
      .lt("priority_score", PRIORITY_HIGH_MIN);
  } else if (opts.priority === "low") {
    // Null priority lands here too — `.lt` on null is false, so we
    // OR-combine. Supabase JS uses .or() with PostgREST tree-form.
    query = query.or(
      `priority_score.lt.${PRIORITY_MEDIUM_MIN},priority_score.is.null`,
    );
  }

  if (opts.age === "24h") {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    query = query.gte("received_at", cutoff);
  } else if (opts.age === "7d") {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte("received_at", cutoff);
  }

  // Sort: priority desc (nulls last), then received_at desc.
  query = query
    .order("priority_score", { ascending: false, nullsFirst: false })
    .order("received_at", { ascending: false })
    .limit(opts.limit ?? DEFAULT_LIMIT);

  const { data } = await query;
  return (data ?? []) as InteractionRow[];
}

export async function getInteractionById(
  workspaceId: string,
  interactionId: string,
): Promise<InteractionRow | null> {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("interactions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", interactionId)
    .maybeSingle();
  return (data as InteractionRow | null) ?? null;
}

// Dashboard engagement-debt widget query. Returns counts of unanswered
// (unread) interactions in two buckets: total and >24h old.
export interface EngagementDebt {
  unanswered: number;
  over24h: number;
}

export async function getEngagementDebt(workspaceId: string): Promise<EngagementDebt> {
  const supabase = await supabaseServer();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [{ count: unansweredCount }, { count: over24hCount }] = await Promise.all([
    supabase
      .from("interactions")
      .select("id", { head: true, count: "exact" })
      .eq("workspace_id", workspaceId)
      .eq("status", "unread"),
    supabase
      .from("interactions")
      .select("id", { head: true, count: "exact" })
      .eq("workspace_id", workspaceId)
      .eq("status", "unread")
      .lte("received_at", cutoff),
  ]);
  return {
    unanswered: unansweredCount ?? 0,
    over24h: over24hCount ?? 0,
  };
}

export type Json = string | number | boolean | null | { [k: string]: Json | undefined } | Json[];

export type Channel = "x" | "instagram" | "facebook" | "threads" | "bluesky" | "linkedin";
export type PostStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "scheduled"
  | "posted"
  | "failed"
  | "rejected"
  | "archived";
export type ApprovalAction = "approved" | "rejected" | "edited" | "unapproved";
export type PlanStatus = "draft" | "active" | "archived";
export type AccountStatus = "connected" | "expired" | "revoked";
// Phase 2: cross-channel idea grouping. One "idea" maps to N posts (one per
// channel variant). Stored as text so the generator could later use stable
// labels; today the plans/new action mints a UUID per idea.
export type IdeaId = string;

// Phase 2.5 (Source-to-Posts): kinds of artifact we can ingest. Mirrors
// the CHECK constraint in migration 009 and the discriminated union in
// src/lib/sources/schema.ts. Adding a kind = update both places + the
// fetch/extract routing in src/lib/sources/fetch.ts.
export type SourceKind = "html" | "youtube" | "podcast" | "pdf" | "transcript";

// Phase 2.1 (Reverse-Plan from a Content Goal): the metric a goal is
// measured against. Mirrors the CHECK constraint in migration 018 and the
// Zod enum in src/lib/goals/schema.ts. `custom` is the catch-all so the
// questionnaire never forces the wrong bucket.
export type GoalMetric =
  | "followers"
  | "inbound"
  | "launch_date"
  | "credibility"
  | "recovery"
  | "custom";

// Phase 2.1: lifecycle of a content_goals row. `draft` = strategy proposed
// but user hasn't approved yet; `active` = strategy approved AND posts
// generated; `paused` = cron-skip but posts stay scheduled; `achieved` /
// `abandoned` are terminal.
export type GoalStatus =
  | "draft"
  | "active"
  | "paused"
  | "achieved"
  | "abandoned";

// Structured extraction result. Stored verbatim on sources.extracted_*
// columns. The shape is the source of truth — zod schema in
// src/lib/sources/schema.ts mirrors it.
export interface ExtractedQuote {
  text: string;
  speaker?: string;
}
export interface ExtractedFact {
  text: string;
  // Optional inline citation (e.g. paragraph index, timestamp).
  context?: string;
}

// Phase 1 (Voice Wedge): structured rejection reason captured in /queue.
// Mirrored by the radio options in queue-row.tsx and by the CHECK constraint
// in migration 006. `other` is the catch-all; `reason_note` carries the prose.
export type RejectionReason = "off_voice" | "wrong_theme" | "factually_wrong" | "other";

// Phase 1 (Voice Wedge): extracted from brand_briefs.reference_posts via a
// Claude tool-use call. Shape is the source of truth — zod schema in
// src/lib/voice/schema.ts mirrors this exactly. Stored as jsonb on
// brand_briefs.voice_profile.
export interface VoiceProfile {
  vocabulary_signature: string;
  opener_patterns: string[];
  sentence_length_avg: number;
  formality: "casual" | "neutral" | "formal";
  emoji_usage: "none" | "sparse" | "frequent";
  punctuation_quirks: string[];
  do_not_say: string[];
  signature_phrases: string[];
  summary: string;
  extracted_at: string;
  source_count: number;
}

// A diff proposal stored on brand_briefs.pending_voice_diff. The weekly
// voice-evolution cron writes this; the user accepts (merge into
// voice_profile) or dismisses (null it out) from /settings/brief.
export interface VoiceProfileDiff {
  rationale: string;
  add_do_not_say?: string[];
  remove_do_not_say?: string[];
  formality?: VoiceProfile["formality"];
  emoji_usage?: VoiceProfile["emoji_usage"];
  add_signature_phrases?: string[];
  remove_signature_phrases?: string[];
  summary_patch?: string;
  // Counts of rejections that produced this diff. Helpful for the UI to
  // explain "we noticed N off-voice rejections this week."
  source_rejection_count: number;
  proposed_at: string;
}

// Phase 4.7 (Discord integration): per-event filter toggles stored as a jsonb
// blob on integrations.event_filters. Kept narrow and boolean-only on purpose
// — anything more shaped should be its own column to remain queryable.
export interface DiscordEventFilters {
  digest: boolean;       // daily approval-digest embed
  realtime: boolean;     // post-by-post embed on pending_approval creation
  alerts_only: boolean;  // reserved: high-priority alerts only (errors, billing)
}

// Phase 6.9 (Theme-aware calendar gaps): per-theme preferences stored on
// brand_briefs.theme_snooze as a jsonb array. Each entry is either a snooze
// (theme + snoozed_until ISO timestamp) or an archive (theme + archived:true).
// Both forms filter the theme out of gap-detection. Snoozes auto-expire when
// snoozed_until elapses; archives are permanent until the user unarchives.
export type ThemeSnoozeEntry =
  | { theme: string; snoozed_until: string; archived?: false }
  | { theme: string; archived: true; snoozed_until?: null };

export interface Database {
  public: {
    Tables: {
      workspaces: {
        Row: {
          id: string;
          slug: string;
          name: string;
          owner_id: string;
          webhook_secret: string | null;
          plan: "hobby" | "pro" | "agency" | "founder";
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          subscription_status: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          slug: string;
          name: string;
          owner_id: string;
          webhook_secret?: string | null;
          plan?: "hobby" | "pro" | "agency" | "founder";
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          subscription_status?: string | null;
        };
        Update: Partial<{
          slug: string;
          name: string;
          webhook_secret: string | null;
          plan: "hobby" | "pro" | "agency" | "founder";
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          subscription_status: string | null;
        }>;
        Relationships: [];
      };
      usage_counters: {
        Row: {
          workspace_id: string;
          month: string;
          posts_generated: number;
          images_generated: number;
          updated_at: string;
        };
        Insert: {
          workspace_id: string;
          month: string;
          posts_generated?: number;
          images_generated?: number;
        };
        Update: Partial<{
          posts_generated: number;
          images_generated: number;
        }>;
        Relationships: [];
      };
      memberships: {
        Row: {
          workspace_id: string;
          user_id: string;
          role: "owner" | "editor" | "viewer";
          created_at: string;
        };
        Insert: { workspace_id: string; user_id: string; role: "owner" | "editor" | "viewer" };
        Update: Partial<{ role: "owner" | "editor" | "viewer" }>;
        Relationships: [];
      };
      brand_briefs: {
        Row: {
          id: string;
          workspace_id: string;
          product_description: string;
          voice: string;
          target_audience: string;
          do_not_say: string[];
          reference_links: string[];
          reference_posts: string[];
          voice_profile: VoiceProfile | null;
          voice_profile_extracted_at: string | null;
          pending_voice_diff: VoiceProfileDiff | null;
          pending_voice_diff_at: string | null;
          // Phase 6.5: IANA timezone the audience lives in. NULL/"UTC" = no
          // preference. Used by smart-timing analysis to bucket post_metrics
          // into day-of-week × 2-hour windows in the right frame.
          audience_timezone: string;
          // Phase 6.9: per-theme snooze/archive entries; opt-out toggle for
          // gap detection. See migration 013_theme_snooze.sql.
          theme_snooze: ThemeSnoozeEntry[];
          theme_gaps_enabled: boolean;
          // Phase 2.6 Founder Mode: opt-in to retain raw voice-memo audio
          // in the `founder-audio` Storage bucket after transcription.
          // Default false (audio discarded post-transcription).
          keep_raw_audio: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          product_description: string;
          voice: string;
          target_audience: string;
          do_not_say?: string[];
          reference_links?: string[];
          reference_posts?: string[];
          voice_profile?: VoiceProfile | null;
          voice_profile_extracted_at?: string | null;
          pending_voice_diff?: VoiceProfileDiff | null;
          pending_voice_diff_at?: string | null;
          audience_timezone?: string;
          theme_snooze?: ThemeSnoozeEntry[];
          theme_gaps_enabled?: boolean;
          keep_raw_audio?: boolean;
        };
        Update: Partial<{
          product_description: string;
          voice: string;
          target_audience: string;
          do_not_say: string[];
          reference_links: string[];
          reference_posts: string[];
          voice_profile: VoiceProfile | null;
          voice_profile_extracted_at: string | null;
          pending_voice_diff: VoiceProfileDiff | null;
          pending_voice_diff_at: string | null;
          audience_timezone: string;
          theme_snooze: ThemeSnoozeEntry[];
          theme_gaps_enabled: boolean;
          keep_raw_audio: boolean;
        }>;
        Relationships: [];
      };
      social_accounts: {
        Row: {
          id: string;
          workspace_id: string;
          channel: Channel;
          handle: string;
          credentials: Json;
          trust_mode: boolean;
          trust_threshold: number;
          successful_post_count: number;
          status: AccountStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          channel: Channel;
          handle: string;
          credentials: Json;
          trust_mode?: boolean;
          trust_threshold?: number;
          successful_post_count?: number;
          status?: AccountStatus;
        };
        Update: Partial<{
          handle: string;
          credentials: Json;
          trust_mode: boolean;
          trust_threshold: number;
          successful_post_count: number;
          status: AccountStatus;
        }>;
        Relationships: [];
      };
      posting_plans: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          start_at: string;
          end_at: string;
          status: PlanStatus;
          parent_plan_id: string | null;
          generation_prompt: string | null;
          generation_response: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          start_at: string;
          end_at: string;
          status?: PlanStatus;
          parent_plan_id?: string | null;
          generation_prompt?: string | null;
          generation_response?: Json | null;
        };
        Update: Partial<{
          name: string;
          start_at: string;
          end_at: string;
          status: PlanStatus;
          parent_plan_id: string | null;
        }>;
        Relationships: [];
      };
      posts: {
        Row: {
          id: string;
          workspace_id: string;
          plan_id: string | null;
          social_account_id: string;
          channel: Channel;
          text: string;
          media: Json;
          theme: string | null;
          scheduled_at: string | null;
          status: PostStatus;
          external_id: string | null;
          posted_at: string | null;
          failure_reason: string | null;
          source_event_id: string | null;
          generation_metadata: Json | null;
          approved_at: string | null;
          revoked_at: string | null;
          voice_score: number | null;
          low_confidence: boolean;
          explainer: Json | null;
          // Phase 2: groups channel-tuned variants that share a single "idea".
          // NULL for legacy / single-channel posts; non-null variants in the
          // same idea share the value so the queue UI can group them.
          idea_id: IdeaId | null;
          // Phase 2.5: the source artifact that anchored this post's cluster.
          // NULL for posts not generated from a source. Analytics rolls
          // engagement up via this FK; deleting the source ON DELETE SET NULL
          // preserves the audit trail without resurrecting the source row.
          source_id: string | null;
          // Phase 2.1: the content goal that produced this post. NULL for
          // posts not generated from a goal. Same ON DELETE SET NULL
          // semantics as source_id — goal-attribution dashboards filter on
          // non-null.
          goal_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          plan_id?: string | null;
          social_account_id: string;
          channel: Channel;
          text: string;
          media?: Json;
          theme?: string | null;
          scheduled_at?: string | null;
          status?: PostStatus;
          source_event_id?: string | null;
          generation_metadata?: Json | null;
          voice_score?: number | null;
          low_confidence?: boolean;
          explainer?: Json | null;
          idea_id?: IdeaId | null;
          source_id?: string | null;
          goal_id?: string | null;
        };
        Update: Partial<{
          text: string;
          media: Json;
          theme: string | null;
          scheduled_at: string | null;
          status: PostStatus;
          external_id: string | null;
          posted_at: string | null;
          failure_reason: string | null;
          approved_at: string | null;
          revoked_at: string | null;
          voice_score: number | null;
          low_confidence: boolean;
          explainer: Json | null;
          idea_id: IdeaId | null;
          source_id: string | null;
          goal_id: string | null;
        }>;
        Relationships: [];
      };
      // Phase 2.1 — Reverse-Plan from a Content Goal.
      // The questionnaire on /goals/new creates a draft row; the strategy
      // preview screen flips status to 'active' after the user approves and
      // generatePostsFromGoal() runs. Mirrors migration 018.
      content_goals: {
        Row: {
          id: string;
          workspace_id: string;
          goal_text: string;
          goal_metric: GoalMetric;
          target_value: number | null;
          target_date: string | null;
          status: GoalStatus;
          baseline_snapshot: Json | null;
          strategy: Json | null;
          // Phase 2.1 follow-up — stamped by the daily replan cron each
          // time it walks this goal. Throttles proposal generation.
          // Migration 020.
          last_replan_check_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          goal_text: string;
          goal_metric: GoalMetric;
          target_value?: number | null;
          target_date?: string | null;
          status?: GoalStatus;
          baseline_snapshot?: Json | null;
          strategy?: Json | null;
          last_replan_check_at?: string | null;
        };
        Update: Partial<{
          goal_text: string;
          goal_metric: GoalMetric;
          target_value: number | null;
          target_date: string | null;
          status: GoalStatus;
          baseline_snapshot: Json | null;
          strategy: Json | null;
          last_replan_check_at: string | null;
        }>;
        Relationships: [];
      };
      // Phase 2.1 follow-up — replan proposals raised by the daily cron
      // when a goal falls behind pace. The dashboard widget surfaces
      // unaccepted proposals as a CTA on the goal card. Migration 020.
      replan_proposals: {
        Row: {
          id: string;
          goal_id: string;
          proposed_at: string;
          proposed_by: "cron" | "user";
          reason: string;
          accepted_at: string | null;
          accepted_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          goal_id: string;
          proposed_at?: string;
          proposed_by?: "cron" | "user";
          reason: string;
          accepted_at?: string | null;
          accepted_by?: string | null;
        };
        Update: Partial<{
          reason: string;
          accepted_at: string | null;
          accepted_by: string | null;
        }>;
        Relationships: [];
      };
      sources: {
        Row: {
          id: string;
          workspace_id: string;
          source_kind: SourceKind;
          source_url: string | null;
          file_path: string | null;
          title: string | null;
          extracted_summary: string | null;
          extracted_quotes: Json;
          extracted_themes: Json;
          extracted_facts: Json;
          ingested_by: string | null;
          ingested_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          source_kind: SourceKind;
          source_url?: string | null;
          file_path?: string | null;
          title?: string | null;
          extracted_summary?: string | null;
          extracted_quotes?: Json;
          extracted_themes?: Json;
          extracted_facts?: Json;
          ingested_by?: string | null;
        };
        Update: Partial<{
          title: string | null;
          extracted_summary: string | null;
          extracted_quotes: Json;
          extracted_themes: Json;
          extracted_facts: Json;
        }>;
        Relationships: [];
      };
      playbook_patterns: {
        Row: {
          id: string;
          workspace_id: string;
          source_post_id: string | null;
          pattern_kind: string;
          pattern_data: Json;
          summary: string;
          saved_at: string;
          saved_by: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          source_post_id?: string | null;
          pattern_kind: string;
          pattern_data: Json;
          summary: string;
          saved_by?: string | null;
        };
        Update: Partial<{
          pattern_kind: string;
          pattern_data: Json;
          summary: string;
        }>;
        Relationships: [];
      };
      approvals: {
        Row: {
          id: string;
          post_id: string;
          user_id: string;
          action: ApprovalAction;
          diff: string | null;
          reason: RejectionReason | null;
          reason_note: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          post_id: string;
          user_id: string;
          action: ApprovalAction;
          diff?: string | null;
          reason?: RejectionReason | null;
          reason_note?: string | null;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      post_metrics: {
        Row: {
          id: string;
          post_id: string;
          fetched_at: string;
          impressions: number | null;
          likes: number | null;
          reposts: number | null;
          replies: number | null;
          clicks: number | null;
          engagement_rate: number | null;
          raw: Json | null;
        };
        Insert: {
          id?: string;
          post_id: string;
          fetched_at?: string;
          impressions?: number | null;
          likes?: number | null;
          reposts?: number | null;
          replies?: number | null;
          clicks?: number | null;
          engagement_rate?: number | null;
          raw?: Json | null;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      social_posts_ledger: {
        Row: {
          id: string;
          workspace_id: string;
          channel: string;
          event_key: string;
          external_id: string | null;
          payload: Json | null;
          posted_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          channel: string;
          event_key: string;
          external_id?: string | null;
          payload?: Json | null;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      events: {
        Row: {
          id: string;
          workspace_id: string;
          event_type: string;
          payload: Json;
          source: string | null;
          processed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          event_type: string;
          payload: Json;
          source?: string | null;
        };
        Update: Partial<{ processed_at: string | null }>;
        Relationships: [];
      };
      event_rules: {
        Row: {
          id: string;
          workspace_id: string;
          event_type: string;
          template: string;
          channels: string[];
          theme: string | null;
          enabled: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          event_type: string;
          template: string;
          channels: string[];
          theme?: string | null;
          enabled?: boolean;
        };
        Update: Partial<{
          event_type: string;
          template: string;
          channels: string[];
          theme: string | null;
          enabled: boolean;
        }>;
        Relationships: [];
      };
      integrations: {
        // Phase 4.7: third-party transports (Discord today, Slack deferred).
        // One row per (workspace, provider, channel) destination. See
        // migration 011 for the CHECK constraint on `provider` and the
        // partial index on workspace_id where provider = 'discord'.
        Row: {
          id: string;
          workspace_id: string;
          provider: "discord";
          target_channel_id: string;
          target_guild_id: string | null;
          auth_payload: Json | null;
          // Defaults to {digest: true, realtime: false, alerts_only: false}
          // in the DB; modelled here as an interface for the UI toggles.
          event_filters: DiscordEventFilters;
          installed_by: string | null;
          installed_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          provider: "discord";
          target_channel_id: string;
          target_guild_id?: string | null;
          auth_payload?: Json | null;
          event_filters?: DiscordEventFilters;
          installed_by?: string | null;
        };
        Update: Partial<{
          target_channel_id: string;
          target_guild_id: string | null;
          auth_payload: Json | null;
          event_filters: DiscordEventFilters;
        }>;
        Relationships: [];
      };
      workspace_invitations: {
        Row: {
          id: string;
          workspace_id: string;
          email: string;
          role: "editor" | "viewer";
          invited_by: string;
          token: string;
          expires_at: string;
          accepted_at: string | null;
          accepted_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          email: string;
          role: "editor" | "viewer";
          invited_by: string;
          token: string;
          expires_at: string;
          accepted_at?: string | null;
          accepted_by?: string | null;
        };
        Update: Partial<{
          email: string;
          role: "editor" | "viewer";
          token: string;
          expires_at: string;
          accepted_at: string | null;
          accepted_by: string | null;
        }>;
        Relationships: [];
      };
      hashtag_usage: {
        // Phase 6.10: per-workspace tag history. One row per (post, tag)
        // pair, populated by the extract→insert hook on plan-generation
        // and by the one-shot backfill admin endpoint. Recommender reads
        // this; it never writes back to posts.text.
        Row: {
          id: string;
          workspace_id: string;
          channel: string;
          tag: string;
          post_id: string | null;
          engagement_at_post: number | null;
          recorded_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          channel: string;
          tag: string;
          post_id?: string | null;
          engagement_at_post?: number | null;
          recorded_at?: string;
        };
        Update: Partial<{
          engagement_at_post: number | null;
        }>;
        Relationships: [];
      };
      discord_links: {
        // Phase 4.7 (Multi-member attribution): maps a Discord user
        // (workspace_id + discord_user_id) → the Supabase auth.users row
        // they've claimed via the /integrations/discord/link flow. The
        // Discord action handler reads this to attribute approvals.
        Row: {
          workspace_id: string;
          discord_user_id: string;
          member_user_id: string;
          linked_at: string;
        };
        Insert: {
          workspace_id: string;
          discord_user_id: string;
          member_user_id: string;
          linked_at?: string;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      ai_reviews: {
        Row: {
          id: string;
          workspace_id: string;
          window_days: number;
          summary: string;
          themes_worked: string[];
          themes_struggled: string[];
          timing_suggestions: string[];
          next_actions: string[];
          raw: Json | null;
          generated_at: string;
          expires_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          window_days: number;
          summary: string;
          themes_worked?: string[];
          themes_struggled?: string[];
          timing_suggestions?: string[];
          next_actions?: string[];
          raw?: Json | null;
          expires_at: string;
        };
        Update: Partial<{
          summary: string;
          themes_worked: string[];
          themes_struggled: string[];
          timing_suggestions: string[];
          next_actions: string[];
          raw: Json | null;
          expires_at: string;
        }>;
        Relationships: [];
      };
      // Phase 6B — Quick Experiments. Sequential variants of a parent
      // post, scheduled across distinct time slots. Verdict is always
      // labelled "directional, not statistically rigorous" — see
      // src/lib/experiments/winner.ts for the eval logic.
      experiments: {
        Row: {
          id: string;
          workspace_id: string;
          parent_post_id: string;
          status: "active" | "complete" | "cancelled";
          variant_count: number;
          created_at: string;
          completed_at: string | null;
          winner_variant_id: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          parent_post_id: string;
          status?: "active" | "complete" | "cancelled";
          variant_count: number;
          winner_variant_id?: string | null;
        };
        Update: Partial<{
          status: "active" | "complete" | "cancelled";
          completed_at: string | null;
          winner_variant_id: string | null;
        }>;
        Relationships: [];
      };
      post_variants: {
        Row: {
          id: string;
          experiment_id: string;
          parent_post_id: string;
          workspace_id: string;
          allocation_weight: number;
          posted_at: string | null;
          metrics_snapshot: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          experiment_id: string;
          parent_post_id: string;
          workspace_id: string;
          allocation_weight?: number;
          posted_at?: string | null;
          metrics_snapshot?: Json | null;
        };
        Update: Partial<{
          posted_at: string | null;
          metrics_snapshot: Json | null;
        }>;
        Relationships: [];
      };
    };
    Views: {
      social_accounts_safe: {
        Row: {
          id: string;
          workspace_id: string;
          channel: Channel;
          handle: string;
          trust_mode: boolean;
          trust_threshold: number;
          successful_post_count: number;
          status: AccountStatus;
          created_at: string;
          updated_at: string;
        };
        Relationships: [];
      };
    };
    Functions: {
      is_workspace_member: { Args: { ws_id: string }; Returns: boolean };
    };
    Enums: Record<string, never>;
  };
}

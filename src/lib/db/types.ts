export type Json = string | number | boolean | null | { [k: string]: Json | undefined } | Json[];

export type Channel = "x" | "instagram" | "facebook" | "threads" | "bluesky" | "linkedin" | "tiktok";
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
export type AccountStatus = "connected" | "expired" | "revoked" | "disconnected";
// Bet 4 (migration 048): tri-state engagement mode for the autonomous
// auto-reply + comment→DM paths. 'shadow' is the safe middle state — drafts
// + audits what it WOULD send, but never posts. Mirrors policy.EngagementMode.
export type EngagementMode = "off" | "shadow" | "live";

// Agency / Organization layer (Phase A — migration 029). An organization is
// the agency tenant; it owns many client workspaces (workspaces.organization_id
// set) and holds ONE Stripe subscription. `plan` reuses the workspace plan
// vocabulary so the entitlement resolver can fall back through tierFor().
export type OrgPlan = "hobby" | "pro" | "agency" | "founder";
// Agency staff role on an org. `admin` = full control incl. billing + members;
// `manager` = manages client workspaces but not org billing/membership.
// Mirrors the CHECK constraint on org_memberships.role in migration 029.
export type OrgRole = "admin" | "manager";
// Client-portal token scopes (migration 029). Stored as text[]; this union is
// the source of truth for what a tokenized client link is allowed to do.
export type ClientPortalScope = "approve" | "view_reports";
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

// Facebook Group Assist (migration 040). See the facebook_groups table.
// How a group tolerates promotional posts: 'open' (any day), 'limited'
// (only on promo_weekdays), 'value_only' (never straight promo).
export type FacebookGroupPromoPolicy = "open" | "limited" | "value_only";
export type FacebookGroupDraftSource = "ai" | "manual";
export type FacebookGroupDraftStatus = "draft" | "posted" | "dismissed";

// Outcome Loop MVP (migration 042). The kind of self-reported BUSINESS outcome
// a user attributes to a live post. Closed vocabulary so the per-theme roll-up
// (src/lib/analytics/outcomes.ts) stays comparable; 'other' is the catch-all.
// Mirrors the CHECK constraint on post_outcomes.outcome_type and the Zod enum
// in src/lib/analytics/outcome-schema.ts.
export type PostOutcomeType = "lead" | "sale" | "signup" | "booking" | "other";

// PLG share (migration 032): the content persisted under a preview_shares.slug
// so an anonymous /start preview can be re-rendered read-only and unfurled on
// social. Mirrors the signed preview-token payload but is the SHAREABLE subset
// only — preview content, never any account/workspace data.
export interface PreviewSharePostItem {
  channel: string;
  text: string;
  theme: string;
  suggested_scheduled_at: string;
  rationale: string;
  image_prompt?: string;
}
export interface PreviewSharePayload {
  channel: "x" | "linkedin" | "instagram" | "bluesky" | "threads";
  handle: string;
  niche_hint?: string;
  plan: {
    plan_name: string;
    overview: string;
    posts: PreviewSharePostItem[];
  };
  voice_summary: string;
  source: "scrape" | "paste";
}

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

// Phase 6.6 (Competitor Watch): the five channels the watch list accepts.
// Mirrors the CHECK constraint in migration 021. Intersected with the
// global Channel union for callers that want a strictly-typed narrowing.
export type CompetitorWatchChannel = "x" | "bluesky" | "linkedin" | "instagram" | "threads";

// Phase 4.5 (Reply Inbox + Engagement Assistant): the five channels the
// inbox / pollers handle. Same set as competitor watch — IG / Threads
// rows are accepted at the DB layer but the pollers throw
// MetaAppReviewPendingError until the Meta scopes land.
// Mirrors the CHECK constraint in migration 023.
export type InteractionChannel = "x" | "linkedin" | "bluesky" | "instagram" | "threads";

// Phase 4.5: lifecycle of an interaction row. `unread` = freshly pulled;
// `read` = opened OR downgraded by native-reply conflict; `replied` =
// the user clicked send via the inbox composer; `snoozed` = hidden
// until snooze_until passes; `dismissed` = manually cleared; `ignored` =
// auto-ignored as spam by the poll-interactions spam pass (TODO #0,
// migration 056) — distinct from `dismissed` so the inbox can show an
// explicit "auto-ignored as spam" review lane.
// Mirrors the CHECK constraint in migrations 023 + 056.
export type InteractionStatus =
  | "unread"
  | "read"
  | "replied"
  | "snoozed"
  | "dismissed"
  | "ignored";

export interface Database {
  public: {
    Tables: {
      workspaces: {
        Row: {
          id: string;
          slug: string;
          name: string;
          owner_id: string;
          // Phase A (migration 029): when non-null, this workspace is a client
          // sub-tenant of the referenced organization. NULL = solo workspace
          // (today's behaviour, unchanged).
          organization_id: string | null;
          webhook_secret: string | null;
          plan: "hobby" | "pro" | "agency" | "founder";
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          subscription_status: string | null;
          // PLG loop (migration 030). referral_bonus_posts: extra monthly posts
          // granted by referrals, added to the tier ceiling. attribution_enabled:
          // the "Made with marketingmagic" toggle (only ever applied on hobby).
          referral_bonus_posts: number;
          attribution_enabled: boolean;
          // Bet 4 (migration 045): workspace-wide hard stop for autonomous
          // auto-replies. TRUE = no account auto-sends, period. Defaults false.
          auto_reply_kill_switch: boolean;
          // Bet 5 (migration 047): weekly-growth-orchestrator trust dial.
          // 'draft' (default) = prepare + email a recommendation, never act
          // autonomously. 'auto' = reserved future graduation.
          autopilot_mode: "draft" | "auto";
          // TODO #0 (migration 056): tri-state inbox spam auto-ignore.
          // 'shadow' classifies + audits would-ignore but never flips a row;
          // 'live' flips spam → status='ignored'. Requires trust_mode to go
          // live; respects auto_reply_kill_switch. Defaults 'off'.
          spam_ignore_mode: EngagementMode;
          // TODO #0 (migration 056): escalate borderline-band inbound to a
          // Claude spam classify (fail-open toward ham). Defaults false.
          spam_ignore_use_claude: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          slug: string;
          name: string;
          owner_id: string;
          organization_id?: string | null;
          webhook_secret?: string | null;
          plan?: "hobby" | "pro" | "agency" | "founder";
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          subscription_status?: string | null;
          referral_bonus_posts?: number;
          attribution_enabled?: boolean;
          auto_reply_kill_switch?: boolean;
          autopilot_mode?: "draft" | "auto";
          spam_ignore_mode?: EngagementMode;
          spam_ignore_use_claude?: boolean;
        };
        Update: Partial<{
          slug: string;
          name: string;
          organization_id: string | null;
          webhook_secret: string | null;
          plan: "hobby" | "pro" | "agency" | "founder";
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          subscription_status: string | null;
          referral_bonus_posts: number;
          attribution_enabled: boolean;
          auto_reply_kill_switch: boolean;
          autopilot_mode: "draft" | "auto";
          spam_ignore_mode: EngagementMode;
          spam_ignore_use_claude: boolean;
        }>;
        Relationships: [];
      };
      // Phase A (migration 029): the agency tenant. Owns many client
      // workspaces (workspaces.organization_id) and holds ONE org-level Stripe
      // subscription. Branding cols (logo_url + two colours) drive white-label
      // surfaces in later phases.
      organizations: {
        Row: {
          id: string;
          slug: string;
          name: string;
          owner_id: string;
          logo_url: string | null;
          color_primary: string | null;
          color_accent: string | null;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          subscription_status: string | null;
          plan: OrgPlan;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          slug: string;
          name: string;
          owner_id: string;
          logo_url?: string | null;
          color_primary?: string | null;
          color_accent?: string | null;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          subscription_status?: string | null;
          plan?: OrgPlan;
        };
        Update: Partial<{
          slug: string;
          name: string;
          logo_url: string | null;
          color_primary: string | null;
          color_accent: string | null;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          subscription_status: string | null;
          plan: OrgPlan;
        }>;
        Relationships: [];
      };
      // Phase A (migration 029): agency staff on an org. (organization_id,
      // user_id) PK mirrors public.memberships. Owner manages; members read.
      org_memberships: {
        Row: {
          organization_id: string;
          user_id: string;
          role: OrgRole;
          created_at: string;
        };
        Insert: { organization_id: string; user_id: string; role: OrgRole };
        Update: Partial<{ role: OrgRole }>;
        Relationships: [];
      };
      // Phase A (migration 029): tokenized client portal grants. token_hash is
      // a SHA-256 of the raw token (raw token never stored). scopes gates what
      // the holder can do. The unauthenticated /client/[token] path (Phase D)
      // resolves the hash via the SERVICE ROLE and must scope every query to
      // this row's workspace_id — RLS here only covers the org-staff mgmt UI.
      client_portal_tokens: {
        Row: {
          id: string;
          workspace_id: string;
          token_hash: string;
          label: string | null;
          scopes: ClientPortalScope[];
          expires_at: string | null;
          revoked_at: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          token_hash: string;
          label?: string | null;
          scopes?: ClientPortalScope[];
          expires_at?: string | null;
          revoked_at?: string | null;
          created_by?: string | null;
        };
        Update: Partial<{
          label: string | null;
          scopes: ClientPortalScope[];
          expires_at: string | null;
          revoked_at: string | null;
        }>;
        Relationships: [];
      };
      // Client portal invite audit trail (migration 035). One row per time the
      // agency emails a client their portal/report link. Audit only — never
      // gates portal access. RLS is org-scoped via is_workspace_member.
      client_invites: {
        Row: {
          id: string;
          workspace_id: string;
          token_id: string | null;
          recipient_email: string;
          created_by: string | null;
          sent_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          token_id?: string | null;
          recipient_email: string;
          created_by?: string | null;
          sent_at?: string;
        };
        Update: Partial<{
          token_id: string | null;
          recipient_email: string;
        }>;
        Relationships: [];
      };
      // Client self-connect tokens (migration 044, Agency Proof Engine bet ③).
      // A tokenized link the agency sends a client so the CLIENT connects their
      // own social channels — the /connect/[token] surface resolves the hash to
      // exactly one workspace_id and drives the existing per-channel OAuth
      // initiate, attributing the account to that client workspace. Mirrors
      // client_portal_tokens: SHA-256(raw) stored, short expiry, revocation.
      client_self_connect_tokens: {
        Row: {
          id: string;
          workspace_id: string;
          token_hash: string;
          label: string | null;
          expires_at: string | null;
          revoked_at: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          token_hash: string;
          label?: string | null;
          expires_at?: string | null;
          revoked_at?: string | null;
          created_by?: string | null;
        };
        Update: Partial<{
          label: string | null;
          expires_at: string | null;
          revoked_at: string | null;
        }>;
        Relationships: [];
      };
      // Client ACCOUNTS (migration 037). The NARROW link between an authenticated
      // client user and a client workspace they may read the REPORT for. This is
      // deliberately SEPARATE from `memberships` (full member rights) — it grants
      // ONLY aggregate-report read access, gated in code via user_is_client_of.
      // A user SELECTs only their own rows; all writes are service-role only.
      client_memberships: {
        Row: {
          id: string;
          user_id: string;
          workspace_id: string;
          created_at: string;
        };
        Insert: { id?: string; user_id: string; workspace_id: string };
        Update: Partial<{ user_id: string; workspace_id: string }>;
        Relationships: [];
      };
      usage_counters: {
        Row: {
          workspace_id: string;
          month: string;
          posts_generated: number;
          images_generated: number;
          videos_generated: number;
          updated_at: string;
        };
        Insert: {
          workspace_id: string;
          month: string;
          posts_generated?: number;
          images_generated?: number;
          videos_generated?: number;
        };
        Update: Partial<{
          posts_generated: number;
          images_generated: number;
          videos_generated: number;
        }>;
        Relationships: [];
      };
      // PLG loop (migration 030). One stable invite code per workspace; the
      // /settings/referrals page renders ?ref=<code> against it. Writes are
      // service-role only (minted lazily in the settings action).
      referral_codes: {
        Row: {
          id: string;
          workspace_id: string;
          code: string;
          created_at: string;
        };
        Insert: { id?: string; workspace_id: string; code: string };
        Update: Partial<{ code: string }>;
        Relationships: [];
      };
      // PLG loop (migration 030). One row per attributed signup.
      // referred_workspace_id is UNIQUE → a workspace is attributed at most
      // once (idempotency key for the reward grant). Writes service-role only.
      referrals: {
        Row: {
          id: string;
          referrer_workspace_id: string;
          referred_workspace_id: string;
          code: string;
          created_at: string;
          // PLG vesting (migration 032). NULL = reward pending (referred
          // workspace hasn't shipped its first post). Set once when that first
          // post reaches 'posted' and the +5 bonus is granted — the conditional
          // null→now() flip is the idempotency key against double-granting.
          vested_at: string | null;
        };
        Insert: {
          id?: string;
          referrer_workspace_id: string;
          referred_workspace_id: string;
          code: string;
          vested_at?: string | null;
        };
        Update: Partial<{ code: string; vested_at: string | null }>;
        Relationships: [];
      };
      // PLG share (migration 032). A persisted, read-only snapshot of an
      // anonymous /start preview plan, addressable by an unguessable slug at
      // /p/<slug>. Holds ONLY preview content (no account data); writes + reads
      // go through the service role (the slug is the capability).
      preview_shares: {
        Row: {
          id: string;
          slug: string;
          payload: PreviewSharePayload;
          created_at: string;
          expires_at: string | null;
        };
        Insert: {
          id?: string;
          slug: string;
          payload: PreviewSharePayload;
          expires_at?: string | null;
        };
        Update: Partial<{ payload: PreviewSharePayload; expires_at: string | null }>;
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
          // in the `founder-audio` Storage bucket for 30 days after
          // transcription. Default false (audio deleted immediately post-
          // transcription). Renamed from keep_raw_audio in migration 050.
          audio_retention_opt_in: boolean;
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
          audio_retention_opt_in?: boolean;
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
          audio_retention_opt_in: boolean;
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
          // Bet 4 (migration 045): per-account opt-in for auto-SENDING drafted
          // replies. KEPT for backward-compat; the tri-state auto_reply_mode
          // below is the source of truth, and this boolean is kept in sync
          // (true iff auto_reply_mode='live'). Defaults false.
          auto_reply_enabled: boolean;
          // Bet 4 (migration 046): per-account opt-in for the comment→DM lead-
          // capture path. KEPT for backward-compat; dm_capture_mode below is the
          // source of truth, kept in sync (true iff dm_capture_mode='live').
          // Independent of auto_reply_enabled. Defaults false.
          dm_capture_enabled: boolean;
          // Bet 4 (migration 048): tri-state engagement mode — the source of
          // truth for the gate/orchestrator. 'shadow' = draft + audit, never
          // send/flip. Defaults 'off'. Requires trust_mode to engage.
          auto_reply_mode: EngagementMode;
          // Bet 4 (migration 048): tri-state comment→DM mode. 'shadow' = draft +
          // audit, never DM/tag/flip. Independent of auto_reply_mode. Defaults 'off'.
          dm_capture_mode: EngagementMode;
          // Bet 4 (migration 046): { keywords[], link, valueCents?, message? }
          // keyword→DM rule, or null when no rule is configured (path no-ops).
          lead_keyword_rule: Json | null;
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
          auto_reply_enabled?: boolean;
          dm_capture_enabled?: boolean;
          auto_reply_mode?: EngagementMode;
          dm_capture_mode?: EngagementMode;
          lead_keyword_rule?: Json | null;
          status?: AccountStatus;
        };
        Update: Partial<{
          handle: string;
          credentials: Json;
          trust_mode: boolean;
          trust_threshold: number;
          successful_post_count: number;
          auto_reply_enabled: boolean;
          dm_capture_enabled: boolean;
          auto_reply_mode: EngagementMode;
          dm_capture_mode: EngagementMode;
          lead_keyword_rule: Json | null;
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
          // Phase 2.1 follow-up — when this goal was spawned by accepting
          // a replan_proposal on a prior goal, this points at that prior
          // goal. NULL for root goals. ON DELETE SET NULL preserves the
          // descendant if the parent is hard-deleted. Migration 022.
          parent_goal_id: string | null;
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
          parent_goal_id?: string | null;
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
          parent_goal_id: string | null;
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
          // Nullable since migration 029: a client-portal approve/reject has no
          // auth user. Exactly one of (user_id, client_token_id) is set — a
          // CHECK constraint enforces this.
          user_id: string | null;
          // Phase A (migration 029): set when the action came through a client
          // portal token instead of an authenticated member.
          client_token_id: string | null;
          action: ApprovalAction;
          diff: string | null;
          reason: RejectionReason | null;
          reason_note: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          post_id: string;
          user_id?: string | null;
          client_token_id?: string | null;
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
      watch_handles: {
        // Phase 6.6 (Competitor Watch): one row per (workspace, channel,
        // handle) pair. Founder-tier-only at the application layer
        // (`hasCompetitorWatch()`); DB schema doesn't enforce the gate
        // (would couple to billing).
        Row: {
          id: string;
          workspace_id: string;
          channel: CompetitorWatchChannel;
          handle: string;
          display_name: string | null;
          status: "active" | "failed" | "rate_limited" | "paused";
          failure_reason: string | null;
          last_pulled_at: string | null;
          added_by: string | null;
          added_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          channel: CompetitorWatchChannel;
          handle: string;
          display_name?: string | null;
          status?: "active" | "failed" | "rate_limited" | "paused";
          failure_reason?: string | null;
          last_pulled_at?: string | null;
          added_by?: string | null;
        };
        Update: Partial<{
          status: "active" | "failed" | "rate_limited" | "paused";
          failure_reason: string | null;
          last_pulled_at: string | null;
          display_name: string | null;
        }>;
        Relationships: [];
      };
      interactions: {
        // Phase 4.5 (Reply Inbox + Engagement Assistant): one row per
        // inbound mention / reply / comment across X, LinkedIn, Bluesky
        // (and IG / Threads once Meta App Review lands). See migration
        // 023 for the CHECK constraints + the snooze/replied/snoozed
        // shape invariants. Polled into shape by
        // src/lib/interactions/pollers/*; never auto-replied to —
        // sendReplyAction requires explicit user click.
        Row: {
          id: string;
          workspace_id: string;
          social_account_id: string;
          channel: InteractionChannel;
          external_id: string;
          parent_post_id: string | null;
          author_handle: string;
          author_display_name: string | null;
          body: string;
          received_at: string;
          status: InteractionStatus;
          priority_score: number | null;
          // TODO #0 (migration 056): 0-100 spam likelihood (higher = spammier).
          // Set by src/lib/interactions/spam.ts on poll. NULL until classified.
          spam_score: number | null;
          snooze_until: string | null;
          replied_at: string | null;
          replied_to_post_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          social_account_id: string;
          channel: InteractionChannel;
          external_id: string;
          parent_post_id?: string | null;
          author_handle: string;
          author_display_name?: string | null;
          body: string;
          received_at: string;
          status?: InteractionStatus;
          priority_score?: number | null;
          spam_score?: number | null;
          snooze_until?: string | null;
          replied_at?: string | null;
          replied_to_post_id?: string | null;
        };
        Update: Partial<{
          status: InteractionStatus;
          priority_score: number | null;
          spam_score: number | null;
          snooze_until: string | null;
          replied_at: string | null;
          replied_to_post_id: string | null;
          parent_post_id: string | null;
          author_display_name: string | null;
        }>;
        Relationships: [];
      };
      auto_reply_log: {
        // Bet 4 (migration 045): audit trail of every autonomous reply
        // auto-sent / shadow / blocked / failed on X, Bluesky, LinkedIn. Also
        // the source the per-account hourly rate cap counts against (counts
        // outcome='sent' only — 'shadow' never consumes budget). See
        // src/lib/interactions/auto-reply/*. 'shadow' (migration 048) =
        // drafted + audited but NOT sent and the interaction NOT flipped.
        Row: {
          id: string;
          workspace_id: string;
          social_account_id: string;
          interaction_id: string | null;
          channel: "x" | "bluesky" | "linkedin";
          outcome: "sent" | "shadow" | "blocked" | "failed";
          outcome_reason: string | null;
          reply_text: string;
          // Bet 4 (migration 048): the exact reply we WOULD have sent, set only
          // for outcome='shadow' (operator review). Null otherwise.
          would_send_text: string | null;
          external_id: string | null;
          reply_post_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          social_account_id: string;
          interaction_id?: string | null;
          channel: "x" | "bluesky" | "linkedin";
          outcome: "sent" | "shadow" | "blocked" | "failed";
          outcome_reason?: string | null;
          reply_text: string;
          would_send_text?: string | null;
          external_id?: string | null;
          reply_post_id?: string | null;
        };
        Update: Partial<{
          outcome: "sent" | "shadow" | "blocked" | "failed";
          outcome_reason: string | null;
          would_send_text: string | null;
          external_id: string | null;
          reply_post_id: string | null;
        }>;
        Relationships: [];
      };
      dm_capture_log: {
        // Bet 4 (migration 046): audit trail of every comment→DM auto-send
        // (sent / shadow / blocked / failed / scope_missing) on X, Bluesky,
        // LinkedIn. Also the source the per-account hourly DM rate cap counts
        // against (counts outcome='sent' only — 'shadow' never consumes budget).
        // See src/lib/interactions/auto-reply/dm-send.ts + lead-capture.ts.
        // 'shadow' (migration 048) = drafted + audited but NO DM sent, NO lead
        // tagged, and the interaction NOT flipped.
        Row: {
          id: string;
          workspace_id: string;
          social_account_id: string;
          interaction_id: string | null;
          channel: "x" | "bluesky" | "linkedin";
          outcome: "sent" | "shadow" | "blocked" | "failed" | "scope_missing";
          outcome_reason: string | null;
          matched_keyword: string | null;
          dm_text: string;
          // Bet 4 (migration 048): the exact DM we WOULD have sent, set only for
          // outcome='shadow' (operator review). Null otherwise.
          would_send_text: string | null;
          external_id: string | null;
          lead_tagged: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          social_account_id: string;
          interaction_id?: string | null;
          channel: "x" | "bluesky" | "linkedin";
          outcome: "sent" | "shadow" | "blocked" | "failed" | "scope_missing";
          outcome_reason?: string | null;
          matched_keyword?: string | null;
          dm_text: string;
          would_send_text?: string | null;
          external_id?: string | null;
          lead_tagged?: boolean;
        };
        Update: Partial<{
          outcome: "sent" | "shadow" | "blocked" | "failed" | "scope_missing";
          outcome_reason: string | null;
          matched_keyword: string | null;
          would_send_text: string | null;
          external_id: string | null;
          lead_tagged: boolean;
        }>;
        Relationships: [];
      };
      spam_ignore_log: {
        // TODO #0 (migration 056): audit trail of every spam auto-ignore
        // decision (ignored / shadow / blocked) on X, Bluesky, LinkedIn.
        // 'ignored' = row flipped to status='ignored' (live). 'shadow' =
        // would-ignore audited, row left visible. 'blocked' = a spam verdict
        // held by a guard (kill switch / not-trusted). See
        // src/lib/interactions/auto-reply/spam-ignore.ts. Nothing is silently
        // dropped — every decision is reviewable here.
        Row: {
          id: string;
          workspace_id: string;
          social_account_id: string;
          interaction_id: string | null;
          channel: "x" | "bluesky" | "linkedin";
          outcome: "ignored" | "shadow" | "blocked";
          outcome_reason: string | null;
          spam_score: number;
          verdict: "ham" | "spam" | "borderline";
          signal_summary: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          social_account_id: string;
          interaction_id?: string | null;
          channel: string;
          outcome: "ignored" | "shadow" | "blocked";
          outcome_reason?: string | null;
          spam_score: number;
          verdict: "ham" | "spam" | "borderline";
          signal_summary: string;
        };
        Update: Partial<{
          outcome: "ignored" | "shadow" | "blocked";
          outcome_reason: string | null;
          spam_score: number;
          verdict: "ham" | "spam" | "borderline";
          signal_summary: string;
        }>;
        Relationships: [];
      };
      weekly_growth_runs: {
        // Bet 5 (migration 047): one row per workspace per weekly window — the
        // idempotency record for the weekly-growth-orchestrator cron (never
        // double-send a window) plus an audit blob of what the cycle
        // measured/recommended. See src/app/api/cron/weekly-growth/route.ts.
        Row: {
          id: string;
          workspace_id: string;
          // The Monday (UTC, ISO date "YYYY-MM-DD") of the cycle week.
          window_start: string;
          mode: "draft" | "auto";
          status: "sent" | "skipped" | "failed";
          summary: Json | null;
          detail: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          window_start: string;
          mode: "draft" | "auto";
          status: "sent" | "skipped" | "failed";
          summary?: Json | null;
          detail?: string | null;
        };
        Update: Partial<{
          status: "sent" | "skipped" | "failed";
          summary: Json | null;
          detail: string | null;
        }>;
        Relationships: [];
      };
      competitor_posts: {
        // Phase 6.6: per-watch-handle post cache. Outlier-detection sets
        // is_winner; pattern extraction populates pattern_tags / reason.
        Row: {
          id: string;
          watch_handle_id: string;
          workspace_id: string;
          external_id: string;
          post_url: string | null;
          posted_at: string;
          text: string;
          likes: number | null;
          reposts: number | null;
          replies: number | null;
          impressions: number | null;
          engagement_rate: number | null;
          is_winner: boolean;
          pattern_tags: string[] | null;
          pattern_reason: string | null;
          fetched_at: string;
          drafted_at: string | null;
          drafted_by: string | null;
        };
        Insert: {
          id?: string;
          watch_handle_id: string;
          workspace_id: string;
          external_id: string;
          post_url?: string | null;
          posted_at: string;
          text?: string;
          likes?: number | null;
          reposts?: number | null;
          replies?: number | null;
          impressions?: number | null;
          engagement_rate?: number | null;
          is_winner?: boolean;
          pattern_tags?: string[] | null;
          pattern_reason?: string | null;
          drafted_at?: string | null;
          drafted_by?: string | null;
        };
        Update: Partial<{
          text: string;
          likes: number | null;
          reposts: number | null;
          replies: number | null;
          impressions: number | null;
          engagement_rate: number | null;
          is_winner: boolean;
          pattern_tags: string[] | null;
          pattern_reason: string | null;
          drafted_at: string | null;
          drafted_by: string | null;
        }>;
        Relationships: [];
      };
      video_jobs: {
        // Phase 2 (P2): one row per MPT render request. The poll-video-jobs
        // cron walks status='processing' rows. BYO secrets are NOT here —
        // only opaque render params.
        Row: {
          id: string;
          workspace_id: string;
          social_account_id: string | null;
          post_id: string | null;
          status: "pending" | "processing" | "ready" | "failed";
          mpt_task_id: string | null;
          params: Json;
          progress: number;
          storage_path: string | null;
          failure_reason: string | null;
          // Reference-image video (bet ④) — migration 030. Null for MPT jobs.
          reference_image_path: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          social_account_id?: string | null;
          post_id?: string | null;
          status?: "pending" | "processing" | "ready" | "failed";
          mpt_task_id?: string | null;
          params?: Json;
          progress?: number;
          storage_path?: string | null;
          failure_reason?: string | null;
          reference_image_path?: string | null;
        };
        Update: Partial<{
          social_account_id: string | null;
          post_id: string | null;
          status: "pending" | "processing" | "ready" | "failed";
          mpt_task_id: string | null;
          params: Json;
          progress: number;
          storage_path: string | null;
          failure_reason: string | null;
          reference_image_path: string | null;
        }>;
        Relationships: [];
      };
      workspace_byo_keys: {
        // Phase 2 (P2): encrypted bring-your-own credentials, one row per
        // (workspace, provider). Service-role only — RLS denies all client
        // reads. Ciphertext is an opaque AES-256-GCM blob.
        Row: {
          workspace_id: string;
          provider: string;
          ciphertext: string;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          workspace_id: string;
          provider: string;
          ciphertext: string;
          created_by?: string | null;
        };
        Update: Partial<{
          provider: string;
          ciphertext: string;
          created_by: string | null;
        }>;
        Relationships: [];
      };
      // UGC avatars (migration 039). A workspace's reusable presenter portraits
      // for the Higgsfield UGC workflow. The image lives in the reference-image
      // bucket (030); we store its path + public URL + a label here. Writes are
      // service-role only; members read their own workspace's rows.
      avatars: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          image_path: string;
          image_url: string;
          is_primary: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          image_path: string;
          image_url: string;
          is_primary?: boolean;
          created_by?: string | null;
        };
        Update: Partial<{
          name: string;
          image_path: string;
          image_url: string;
          is_primary: boolean;
        }>;
        Relationships: [];
      };
      // Facebook Group Assist (migration 040). Meta removed the Groups API
      // (2024-04-22), so there is no way to post to a group programmatically —
      // these tables back a ToS-safe, human-in-the-loop workflow: we draft the
      // copy, the operator pastes & posts it. Deliberately separate from
      // `posts` so group drafts NEVER enter the auto-publish cron/dispatcher.
      facebook_groups: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          url: string;
          member_count: number | null;
          promo_policy: FacebookGroupPromoPolicy;
          promo_weekdays: number[];
          allow_links: boolean;
          rules_notes: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          url: string;
          member_count?: number | null;
          promo_policy?: FacebookGroupPromoPolicy;
          promo_weekdays?: number[];
          allow_links?: boolean;
          rules_notes?: string;
          created_by?: string | null;
        };
        Update: Partial<{
          name: string;
          url: string;
          member_count: number | null;
          promo_policy: FacebookGroupPromoPolicy;
          promo_weekdays: number[];
          allow_links: boolean;
          rules_notes: string;
        }>;
        Relationships: [];
      };
      facebook_group_drafts: {
        Row: {
          id: string;
          workspace_id: string;
          group_id: string;
          text: string;
          source: FacebookGroupDraftSource;
          status: FacebookGroupDraftStatus;
          posted_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          group_id: string;
          text: string;
          source?: FacebookGroupDraftSource;
          status?: FacebookGroupDraftStatus;
          posted_at?: string | null;
          created_by?: string | null;
        };
        Update: Partial<{
          text: string;
          status: FacebookGroupDraftStatus;
          posted_at: string | null;
        }>;
        Relationships: [];
      };
      // Outcome Loop MVP (migration 042). One self-reported BUSINESS outcome
      // (lead / sale / signup / booking / other) attributed to a live post,
      // optionally with a dollar amount (value_cents). A post can have MANY
      // outcomes. Members read/write their own workspace's rows (RLS via
      // is_workspace_member); analytics rolls these up per theme in
      // src/lib/analytics/outcomes.ts. SCOPE: self-report only — no UTM /
      // pixel ingestion (deferred phase 2).
      post_outcomes: {
        Row: {
          id: string;
          workspace_id: string;
          post_id: string;
          outcome_type: PostOutcomeType;
          // Revenue in CENTS when known; null for value-less outcomes (a 'lead'
          // or 'signup' with no dollar figure attached).
          value_cents: number | null;
          note: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          post_id: string;
          outcome_type: PostOutcomeType;
          value_cents?: number | null;
          note?: string | null;
          created_by?: string | null;
        };
        Update: Partial<{
          outcome_type: PostOutcomeType;
          value_cents: number | null;
          note: string | null;
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
      // Phase A (migration 029) org-access helpers.
      user_owns_organization: { Args: { org_id: string }; Returns: boolean };
      user_is_org_member: { Args: { org_id: string }; Returns: boolean };
      // Phase E (migration 033) tight org-admin gate (owner or 'admin' role).
      user_is_org_admin: { Args: { org_id: string }; Returns: boolean };
      // Client accounts (migration 037): is the CALLER (auth.uid()) a client of
      // this workspace? Derives strictly from auth.uid() — no user-id arg.
      user_is_client_of: { Args: { ws_id: string }; Returns: boolean };
    };
    Enums: Record<string, never>;
  };
}

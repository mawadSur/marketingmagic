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
          plan: "hobby" | "pro" | "agency";
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
          plan?: "hobby" | "pro" | "agency";
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          subscription_status?: string | null;
        };
        Update: Partial<{
          slug: string;
          name: string;
          webhook_secret: string | null;
          plan: "hobby" | "pro" | "agency";
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
        };
        Update: Partial<{
          product_description: string;
          voice: string;
          target_audience: string;
          do_not_say: string[];
          reference_links: string[];
          reference_posts: string[];
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
          explainer: Json | null;
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
          explainer?: Json | null;
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
          explainer: Json | null;
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
          created_at: string;
        };
        Insert: { id?: string; post_id: string; user_id: string; action: ApprovalAction; diff?: string | null };
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

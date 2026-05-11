export type Json = string | number | boolean | null | { [k: string]: Json | undefined } | Json[];

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
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          slug: string;
          name: string;
          owner_id: string;
          webhook_secret?: string | null;
        };
        Update: Partial<{
          slug: string;
          name: string;
          webhook_secret: string | null;
        }>;
      };
      memberships: {
        Row: {
          workspace_id: string;
          user_id: string;
          role: "owner" | "editor" | "viewer";
          created_at: string;
        };
        Insert: {
          workspace_id: string;
          user_id: string;
          role: "owner" | "editor" | "viewer";
        };
        Update: Partial<{ role: "owner" | "editor" | "viewer" }>;
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
      };
      social_accounts: {
        Row: {
          id: string;
          workspace_id: string;
          channel: "x" | "instagram" | "facebook" | "threads" | "bluesky" | "linkedin";
          handle: string;
          credentials: Json;
          trust_mode: boolean;
          successful_post_count: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          channel: "x" | "instagram" | "facebook" | "threads" | "bluesky" | "linkedin";
          handle: string;
          credentials: Json;
          trust_mode?: boolean;
          successful_post_count?: number;
        };
        Update: Partial<{
          handle: string;
          credentials: Json;
          trust_mode: boolean;
          successful_post_count: number;
        }>;
      };
      posting_plans: {
        Row: {
          id: string;
          workspace_id: string;
          parent_plan_id: string | null;
          starts_on: string;
          ends_on: string;
          status: "draft" | "active" | "archived";
          rationale: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          parent_plan_id?: string | null;
          starts_on: string;
          ends_on: string;
          status?: "draft" | "active" | "archived";
          rationale?: string | null;
        };
        Update: Partial<{
          status: "draft" | "active" | "archived";
          rationale: string | null;
        }>;
      };
      posts: {
        Row: {
          id: string;
          workspace_id: string;
          plan_id: string | null;
          social_account_id: string;
          channel: "x" | "instagram" | "facebook" | "threads" | "bluesky" | "linkedin";
          text: string;
          theme: string | null;
          status:
            | "draft"
            | "pending_approval"
            | "approved"
            | "scheduled"
            | "posted"
            | "rejected"
            | "failed";
          scheduled_at: string | null;
          sent_at: string | null;
          external_id: string | null;
          rationale: string | null;
          error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          plan_id?: string | null;
          social_account_id: string;
          channel: "x" | "instagram" | "facebook" | "threads" | "bluesky" | "linkedin";
          text: string;
          theme?: string | null;
          status?:
            | "draft"
            | "pending_approval"
            | "approved"
            | "scheduled"
            | "posted"
            | "rejected"
            | "failed";
          scheduled_at?: string | null;
          rationale?: string | null;
        };
        Update: Partial<{
          text: string;
          theme: string | null;
          status:
            | "draft"
            | "pending_approval"
            | "approved"
            | "scheduled"
            | "posted"
            | "rejected"
            | "failed";
          scheduled_at: string | null;
          sent_at: string | null;
          external_id: string | null;
          rationale: string | null;
          error: string | null;
        }>;
      };
      approvals: {
        Row: {
          id: string;
          post_id: string;
          actor_id: string;
          action: "approve" | "edit" | "reject" | "revoke";
          notes: string | null;
          before_text: string | null;
          after_text: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          post_id: string;
          actor_id: string;
          action: "approve" | "edit" | "reject" | "revoke";
          notes?: string | null;
          before_text?: string | null;
          after_text?: string | null;
        };
        Update: never;
      };
      social_posts: {
        Row: {
          id: string;
          post_id: string;
          channel: string;
          external_id: string;
          posted_at: string;
        };
        Insert: {
          id?: string;
          post_id: string;
          channel: string;
          external_id: string;
          posted_at?: string;
        };
        Update: never;
      };
      post_metrics: {
        Row: {
          id: string;
          post_id: string;
          fetched_at: string;
          impressions: number;
          likes: number;
          reposts: number;
          replies: number;
          clicks: number;
        };
        Insert: {
          id?: string;
          post_id: string;
          fetched_at?: string;
          impressions?: number;
          likes?: number;
          reposts?: number;
          replies?: number;
          clicks?: number;
        };
        Update: never;
      };
      events: {
        Row: {
          id: string;
          workspace_id: string;
          event_type: string;
          payload: Json;
          received_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          event_type: string;
          payload: Json;
        };
        Update: never;
      };
      event_rules: {
        Row: {
          id: string;
          workspace_id: string;
          event_type: string;
          channels: string[];
          template: string;
          theme: string | null;
          enabled: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          event_type: string;
          channels: string[];
          template: string;
          theme?: string | null;
          enabled?: boolean;
        };
        Update: Partial<{
          event_type: string;
          channels: string[];
          template: string;
          theme: string | null;
          enabled: boolean;
        }>;
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_workspace_member: { Args: { ws_id: string }; Returns: boolean };
    };
    Enums: Record<string, never>;
  };
}

import { z } from "zod";

export const planPostSchema = z.object({
  channel: z.enum(["x", "linkedin", "threads", "instagram", "bluesky"]),
  // Max chars enforced per-channel downstream (channels/registry.ts). The
  // schema uses the largest cap (LinkedIn = 3000) so Claude isn't rejected
  // wholesale for a long LinkedIn post.
  text: z.string().min(1).max(3000),
  theme: z.string().min(1).max(60),
  suggested_scheduled_at: z.string().datetime(),
  rationale: z.string().min(1).max(1000),
  // Optional starting prompt for image gen. Claude may omit it for posts that
  // shouldn't have an image (e.g. pure text replies, time-sensitive announcements).
  image_prompt: z.preprocess(v => (v === "" ? undefined : v), z.string().min(1).max(500).optional()),
  // Phase 1 (Voice Wedge): Claude self-scores fidelity to the supplied
  // voice profile. Optional because the field is unset on legacy plans
  // and when no voice_profile is on the brief.
  voice_score: z.number().min(0).max(100).optional(),
});

export const planSchema = z.object({
  plan_name: z.string().min(1).max(120),
  overview: z.string().min(1).max(800),
  posts: z.array(planPostSchema).min(1).max(50),
});

export type PlanPost = z.infer<typeof planPostSchema>;
export type GeneratedPlan = z.infer<typeof planSchema>;

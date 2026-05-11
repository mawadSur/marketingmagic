import { z } from "zod";

export const planPostSchema = z.object({
  channel: z.enum(["x"]),
  text: z.string().min(1).max(280),
  theme: z.string().min(1).max(60),
  suggested_scheduled_at: z.string().datetime(),
  rationale: z.string().min(1).max(280),
});

export const planSchema = z.object({
  plan_name: z.string().min(1).max(120),
  overview: z.string().min(1).max(800),
  posts: z.array(planPostSchema).min(1).max(50),
});

export type PlanPost = z.infer<typeof planPostSchema>;
export type GeneratedPlan = z.infer<typeof planSchema>;

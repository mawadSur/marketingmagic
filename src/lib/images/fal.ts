import { serverEnv } from "@/lib/env";
import type { ImageGenInputs, ImageGenResult, ImageProvider } from "./provider";

// fal.ai sync endpoint. Works for fast models (Flux schnell) where the call
// returns the rendered image directly. For longer-running models (Flux pro)
// we'd switch to the queue endpoint; out of scope until we add a slower model.
const SYNC_BASE = "https://fal.run";

const ASPECT_TO_FAL: Record<ImageGenInputs["aspect"], string> = {
  square: "square_hd",
  landscape: "landscape_4_3",
  portrait: "portrait_4_3",
};

interface FalImage {
  url: string;
  width: number;
  height: number;
  content_type: string;
}

interface FalResponse {
  images: FalImage[];
  seed?: number;
  has_nsfw_concepts?: boolean[];
}

export class FalImageProvider implements ImageProvider {
  readonly name = "fal";

  async generate(input: ImageGenInputs): Promise<ImageGenResult> {
    const env = serverEnv();
    if (!env.FAL_API_KEY) {
      throw new Error("FAL_API_KEY is not set. Add it to .env to enable image generation.");
    }

    const model = env.FAL_DEFAULT_MODEL;
    const started = Date.now();

    const res = await fetch(`${SYNC_BASE}/${model}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${env.FAL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: input.prompt,
        image_size: ASPECT_TO_FAL[input.aspect],
        num_inference_steps: 4,
        num_images: 1,
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`fal.ai generation failed (${res.status}): ${body.slice(0, 400)}`);
    }

    const json = (await res.json()) as FalResponse;
    const image = json.images?.[0];
    if (!image) {
      throw new Error("fal.ai returned no images.");
    }
    if (json.has_nsfw_concepts?.[0]) {
      throw new Error("Image flagged by safety filter — try a different prompt.");
    }

    // fal returns a CDN URL that can expire. Pull bytes now so the caller can
    // own the asset (upload to Supabase Storage).
    const imgRes = await fetch(image.url);
    if (!imgRes.ok) {
      throw new Error(`fal.ai image fetch failed (${imgRes.status}).`);
    }
    const buffer = new Uint8Array(await imgRes.arrayBuffer());

    return {
      bytes: buffer,
      contentType: image.content_type || "image/jpeg",
      width: image.width,
      height: image.height,
      meta: {
        provider: "fal",
        model,
        seed: json.seed,
        latency_ms: Date.now() - started,
      },
    };
  }
}

export const falProvider = new FalImageProvider();

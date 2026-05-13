// Image-generation provider interface. Lets us swap fal.ai for higgsfield
// (or add a higgsfield video sibling later) without touching call sites.

export interface ImageGenInputs {
  prompt: string;
  // Hint for aspect ratio. fal uses preset names; higgsfield will be mapped at
  // adapter time.
  aspect: "square" | "landscape" | "portrait";
  // Optional seed for reproducibility when iterating on a prompt.
  seed?: number;
}

export interface ImageGenResult {
  // Raw image bytes — adapters must hydrate temp URLs before returning so
  // callers never deal with provider CDN expiry.
  bytes: Uint8Array;
  contentType: string;
  width: number;
  height: number;
  // Provider-specific metadata persisted into posts.media for debugging.
  meta: {
    provider: string;
    model: string;
    seed?: number;
    latency_ms: number;
  };
}

export interface ImageProvider {
  readonly name: string;
  generate(input: ImageGenInputs): Promise<ImageGenResult>;
}

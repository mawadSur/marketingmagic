import { falProvider } from "./fal";
import type { ImageProvider } from "./provider";

export type { ImageGenInputs, ImageGenResult, ImageProvider } from "./provider";

// Single-provider for now. When higgsfield arrives, this becomes a registry
// keyed by provider name and the queue UI gets a provider toggle.
export function defaultImageProvider(): ImageProvider {
  return falProvider;
}

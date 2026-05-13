import Stripe from "stripe";
import { serverEnv } from "@/lib/env";

// Lazy Stripe singleton. The SDK is heavy and we don't want to instantiate
// it on every cold start — only when a billing route actually needs it.
//
// Throws a clear error (not a generic 500) when STRIPE_SECRET_KEY is missing
// so the operator immediately sees what's wrong instead of seeing a Stripe
// "Invalid API Key provided: " stack trace deep inside the SDK.
let cached: Stripe | null = null;

export class BillingNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`Stripe billing is not configured: ${missing} is missing from env.`);
    this.name = "BillingNotConfiguredError";
  }
}

export function stripeClient(): Stripe {
  if (cached) return cached;
  const env = serverEnv();
  if (!env.STRIPE_SECRET_KEY) {
    throw new BillingNotConfiguredError("STRIPE_SECRET_KEY");
  }
  cached = new Stripe(env.STRIPE_SECRET_KEY, {
    // Pin the API version we wrote against. Bumping is a deliberate act.
    apiVersion: "2026-04-22.dahlia",
    typescript: true,
    appInfo: {
      name: "marketingmagic",
      url: "https://marketingmagic.app",
    },
  });
  return cached;
}

// True iff Stripe is fully configured (secret + price ids). The /settings/
// billing UI uses this to render an inert state rather than buttons that
// would error on click.
export function billingConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_PRO && env.STRIPE_PRICE_AGENCY);
}

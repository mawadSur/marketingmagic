import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: env video feature flags (src/lib/env.ts) ───────────────────────────
//
// mptConfigured / byoKeysConfigured / videoPublishEnabled all read serverEnv(),
// which Zod-validates the FULL process.env against serverSchema. So we seed a
// minimal-but-valid base env (the required fields) and then toggle the optional
// video fields per test. serverEnv() memoises its parse, so each test resets the
// module registry (vi.resetModules) and re-imports to get a fresh cache.

const BASE_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  ANTHROPIC_API_KEY: "anthropic-key",
  CRON_SECRET: "cron-secret-at-least-16-chars",
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Strip any pre-existing video env so tests start from a clean slate.
  for (const k of ["MPT_BASE_URL", "MPT_API_TOKEN", "BYO_ENCRYPTION_KEY", "VIDEO_PUBLISH_CHANNELS"]) {
    delete process.env[k];
  }
  Object.assign(process.env, BASE_ENV);
  vi.resetModules();
});
afterEach(() => {
  process.env = savedEnv;
  vi.resetModules();
});

async function loadEnv() {
  return import("@/lib/env");
}

describe("mptConfigured", () => {
  it("is false when MPT_BASE_URL / MPT_API_TOKEN are unset", async () => {
    const { mptConfigured } = await loadEnv();
    expect(mptConfigured()).toBe(false);
  });

  it("is false when only the base URL is set (token missing)", async () => {
    process.env.MPT_BASE_URL = "https://mpt.example.com";
    const { mptConfigured } = await loadEnv();
    expect(mptConfigured()).toBe(false);
  });

  it("is true only when BOTH the base URL and token are set", async () => {
    process.env.MPT_BASE_URL = "https://mpt.example.com";
    process.env.MPT_API_TOKEN = "mpt-token-abc12345";
    const { mptConfigured } = await loadEnv();
    expect(mptConfigured()).toBe(true);
  });
});

describe("byoKeysConfigured", () => {
  it("is false when BYO_ENCRYPTION_KEY is unset", async () => {
    const { byoKeysConfigured } = await loadEnv();
    expect(byoKeysConfigured()).toBe(false);
  });

  it("is true when BYO_ENCRYPTION_KEY is present", async () => {
    process.env.BYO_ENCRYPTION_KEY = "0".repeat(64);
    const { byoKeysConfigured } = await loadEnv();
    expect(byoKeysConfigured()).toBe(true);
  });
});

describe("videoFeatureConfigured", () => {
  it("requires BOTH MPT + BYO to be configured", async () => {
    process.env.MPT_BASE_URL = "https://mpt.example.com";
    process.env.MPT_API_TOKEN = "mpt-token-abc12345";
    // BYO still missing → not fully configured.
    let mod = await loadEnv();
    expect(mod.videoFeatureConfigured()).toBe(false);

    process.env.BYO_ENCRYPTION_KEY = "0".repeat(64);
    vi.resetModules();
    mod = await loadEnv();
    expect(mod.videoFeatureConfigured()).toBe(true);
  });
});

describe("videoPublishEnabled", () => {
  it("defaults to the three no-review-gate channels when VIDEO_PUBLISH_CHANNELS is unset", async () => {
    const { videoPublishEnabled } = await loadEnv();
    expect(videoPublishEnabled("bluesky")).toBe(true);
    expect(videoPublishEnabled("facebook")).toBe(true);
    expect(videoPublishEnabled("threads")).toBe(true);
    // App-review-gated channels are OFF by default.
    expect(videoPublishEnabled("instagram")).toBe(false);
    expect(videoPublishEnabled("x")).toBe(false);
    expect(videoPublishEnabled("linkedin")).toBe(false);
  });

  it("honours an explicit allowlist (case-insensitive, whitespace-trimmed)", async () => {
    process.env.VIDEO_PUBLISH_CHANNELS = " Instagram , X ";
    const { videoPublishEnabled } = await loadEnv();
    expect(videoPublishEnabled("instagram")).toBe(true);
    expect(videoPublishEnabled("x")).toBe(true);
    // Not in the explicit list → off, even though it's a default channel.
    expect(videoPublishEnabled("bluesky")).toBe(false);
  });

  it("treats an empty-string env as 'use the default allowlist' (Zod coerces '' → undefined)", async () => {
    process.env.VIDEO_PUBLISH_CHANNELS = "";
    const { videoPublishEnabled } = await loadEnv();
    expect(videoPublishEnabled("bluesky")).toBe(true);
  });
});

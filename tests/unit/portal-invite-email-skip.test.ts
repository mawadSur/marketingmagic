import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: invite-email graceful degrade (src/lib/portal/invite-email.ts) ─────
//
// The "email this link to the client" send must degrade gracefully when the
// deployment has no Resend key — EXACTLY like the digest cron: log + skip, never
// throw, never hit the network. This proves:
//   • RESEND_API_KEY unset → status "skipped", no fetch attempted, no throw.
//   • RESEND_API_KEY set + Resend 200 → status "sent".
//   • RESEND_API_KEY set + Resend 4xx → status "failed" (still no throw).
// And that the rendered email reflects the token scopes + org branding.

const { serverEnv } = vi.hoisted(() => ({ serverEnv: vi.fn() }));
vi.mock("@/lib/env", () => ({ serverEnv }));

import {
  renderInviteEmail,
  sendInviteEmail,
} from "@/lib/portal/invite-email";

const baseRender = {
  workspaceName: "Client Co",
  portalUrl: "https://app.example.com/client/sometoken1234567890",
  scopes: ["approve", "view_reports"],
  branding: { orgName: "Bright Agency", logoUrl: null, colorAccent: null },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("sendInviteEmail — graceful degrade when unconfigured", () => {
  it("skips (no throw, no fetch) when RESEND_API_KEY is unset", async () => {
    serverEnv.mockReturnValue({
      RESEND_API_KEY: undefined,
      EMAIL_FROM: "noreply@x.app",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendInviteEmail(
      "jane@client.co",
      renderInviteEmail(baseRender),
    );

    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toBe("email_not_configured");
    }
    expect(fetchSpy).not.toHaveBeenCalled(); // never touched the network
  });

  it("sends when RESEND_API_KEY is set and Resend returns 200", async () => {
    serverEnv.mockReturnValue({
      RESEND_API_KEY: "re_test_key_1234",
      EMAIL_FROM: "noreply@x.app",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    const result = await sendInviteEmail(
      "jane@client.co",
      renderInviteEmail(baseRender),
    );

    expect(result.status).toBe("sent");
  });

  it("returns failed (no throw) when Resend rejects with 4xx", async () => {
    serverEnv.mockReturnValue({
      RESEND_API_KEY: "re_test_key_1234",
      EMAIL_FROM: "noreply@x.app",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad recipient", { status: 422 }),
    );

    const result = await sendInviteEmail(
      "jane@client.co",
      renderInviteEmail(baseRender),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/422/);
    }
  });

  it("returns failed (no throw) when fetch itself throws", async () => {
    serverEnv.mockReturnValue({
      RESEND_API_KEY: "re_test_key_1234",
      EMAIL_FROM: "noreply@x.app",
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    const result = await sendInviteEmail(
      "jane@client.co",
      renderInviteEmail(baseRender),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/network down/i);
    }
  });
});

describe("renderInviteEmail — content + branding", () => {
  it("includes the portal URL and a scope-aware blurb", () => {
    const out = renderInviteEmail(baseRender);
    expect(out.html).toContain(baseRender.portalUrl);
    expect(out.text).toContain(baseRender.portalUrl);
    // both scopes → approve + reports language
    expect(out.html).toMatch(/approve drafts and see performance reports/i);
    expect(out.subject).toContain("Client Co");
    expect(out.subject).toContain("Bright Agency");
  });

  it("falls back to default accent when the org accent is not a valid hex", () => {
    const out = renderInviteEmail({
      ...baseRender,
      branding: { orgName: "X", logoUrl: null, colorAccent: "not-a-color" },
    });
    expect(out.html).toContain("#2563eb"); // DEFAULT_ACCENT
  });

  it("renders an approve-only blurb when only the approve scope is present", () => {
    const out = renderInviteEmail({ ...baseRender, scopes: ["approve"] });
    expect(out.html).toMatch(/review and approve drafts/i);
    expect(out.html).not.toMatch(/performance reports/i);
  });
});

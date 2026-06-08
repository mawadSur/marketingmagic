import { describe, expect, it } from "vitest";

// ── Unit: BrandStyle loader graceful behaviour (src/lib/brand/load.ts).
//
// loadBrandStyle is the I/O wrapper around the pure projection. These tests use
// a hand-rolled stub of the supabase service client (the same .from().select()
// .eq().maybeSingle() chain the loader calls) to prove:
//   • a workspace under an org with branding + a brief → a fully projected style,
//   • a workspace with NO org → no colours/logo, brief signals still applied,
//   • any query error → EMPTY_BRAND_STYLE (never throws into generation).

import { EMPTY_BRAND_STYLE, loadBrandStyle } from "@/lib/brand/load";

type Row = Record<string, unknown> | null;

// Build a minimal stub matching the chained query surface loadBrandStyle uses.
// `rows` maps a table name to the single row maybeSingle() should resolve.
// `throwOn` (optional) makes a given table's query reject, exercising the
// graceful-fallback path.
function stubClient(rows: Record<string, Row>, throwOn?: string) {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  if (throwOn === table) throw new Error(`boom: ${table}`);
                  return { data: rows[table] ?? null, error: null };
                },
              };
            },
          };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("loadBrandStyle", () => {
  it("projects brand_briefs + org branding for an org-owned workspace", async () => {
    const svc = stubClient({
      brand_briefs: {
        voice: "Plain-spoken and direct",
        voice_profile: null,
        product_description: "A CRM for agencies",
        target_audience: "agency owners",
      },
      workspaces: { organization_id: "org-1" },
      organizations: {
        color_primary: "#102030",
        color_accent: "#abcdef",
        logo_url: "https://cdn/logo.png",
      },
    });

    const style = await loadBrandStyle("ws-1", svc);
    expect(style.colors).toEqual(["#102030", "#abcdef"]);
    expect(style.voiceHint).toBe("Plain-spoken and direct");
    expect(style.subjectContext).toBe("A CRM for agencies (for agency owners)");
    expect(style.hasLogo).toBe(true);
  });

  it("omits colours/logo for a workspace with no organization", async () => {
    const svc = stubClient({
      brand_briefs: {
        voice: "Friendly",
        voice_profile: null,
        product_description: null,
        target_audience: null,
      },
      workspaces: { organization_id: null },
    });

    const style = await loadBrandStyle("ws-2", svc);
    expect(style.colors).toEqual([]);
    expect(style.hasLogo).toBe(false);
    expect(style.voiceHint).toBe("Friendly");
  });

  it("returns EMPTY_BRAND_STYLE (never throws) when a query fails", async () => {
    const svc = stubClient({}, "brand_briefs");
    const style = await loadBrandStyle("ws-3", svc);
    expect(style).toEqual(EMPTY_BRAND_STYLE);
  });

  it("returns an empty-but-valid style when the workspace has no brief at all", async () => {
    const svc = stubClient({ brand_briefs: null, workspaces: { organization_id: null } });
    const style = await loadBrandStyle("ws-4", svc);
    expect(style).toEqual(EMPTY_BRAND_STYLE);
  });
});

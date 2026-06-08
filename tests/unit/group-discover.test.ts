import { describe, expect, it } from "vitest";
import {
  facebookGroupSearchUrl,
  isFacebookGroupSearchUrl,
  normalizeSuggestions,
} from "@/lib/groups/discover";

// ── Facebook Group DISCOVERY — pure logic ────────────────────────────────────
//
// Meta removed the Groups API (2024-04-22), so discovery is AI SUGGESTIONS +
// outbound facebook.com/search/groups/?q=… links the operator clicks to find +
// join by hand. The value-and-safety core is therefore the URL building/
// validation and the normalize/dedupe of the model's output — all pure, so we
// exercise it without the model. (The network call in discoverGroups() forces a
// schema-valid tool call and re-validates with zod, same pattern as
// generate.ts; the testable seam is normalizeSuggestions + the URL helpers.)

// A raw suggestion in the shape normalizeSuggestions expects (post zod
// transform: approx_members already number | null).
function raw(over: Partial<Parameters<typeof normalizeSuggestions>[0][number]> = {}) {
  return {
    name: "Indie SaaS Founders",
    description: "Bootstrappers shipping software products.",
    why_relevant: "Your audience of solo founders gathers here.",
    topic: "SaaS",
    search_query: "indie saas founders",
    approx_members: 12000 as number | null,
    ...over,
  };
}

describe("facebookGroupSearchUrl", () => {
  it("builds a canonical facebook.com group-search URL with an encoded query", () => {
    const url = facebookGroupSearchUrl("indie saas founders");
    expect(url).toBe(
      "https://www.facebook.com/search/groups/?q=indie+saas+founders",
    );
  });

  it("percent-encodes special characters in the query (no URL injection)", () => {
    const url = facebookGroupSearchUrl("dogs & cats #pets");
    // & and # must be encoded so they stay inside the q param.
    expect(url.startsWith("https://www.facebook.com/search/groups/?q=")).toBe(true);
    expect(url).not.toContain("#pets");
    expect(url).toContain("dogs");
    // Round-trips back to the original query.
    const parsed = new URL(url);
    expect(parsed.searchParams.get("q")).toBe("dogs & cats #pets");
  });

  it("trims surrounding whitespace before encoding", () => {
    const parsed = new URL(facebookGroupSearchUrl("  vegan bakers  "));
    expect(parsed.searchParams.get("q")).toBe("vegan bakers");
  });

  it("always produces a URL that passes its own validator", () => {
    for (const q of ["a", "local makers", "emoji 🚀 group", "a & b"]) {
      expect(isFacebookGroupSearchUrl(facebookGroupSearchUrl(q))).toBe(true);
    }
  });
});

describe("isFacebookGroupSearchUrl", () => {
  it("accepts the canonical search URL and the www/m subdomains", () => {
    expect(isFacebookGroupSearchUrl("https://www.facebook.com/search/groups/?q=x")).toBe(true);
    expect(isFacebookGroupSearchUrl("https://facebook.com/search/groups?q=x")).toBe(true);
    expect(isFacebookGroupSearchUrl("https://m.facebook.com/search/groups/?q=x")).toBe(true);
  });

  it("rejects look-alike hosts (substring attacks)", () => {
    expect(isFacebookGroupSearchUrl("https://notfacebook.com/search/groups/?q=x")).toBe(false);
    expect(isFacebookGroupSearchUrl("https://facebook.com.evil.com/search/groups/?q=x")).toBe(false);
    expect(isFacebookGroupSearchUrl("https://evil.com/x?u=facebook.com/search/groups")).toBe(false);
  });

  it("rejects non-https and pseudo-protocols", () => {
    expect(isFacebookGroupSearchUrl("http://www.facebook.com/search/groups/?q=x")).toBe(false);
    expect(isFacebookGroupSearchUrl("javascript:alert(1)//facebook.com/search/groups")).toBe(false);
    expect(isFacebookGroupSearchUrl("not a url")).toBe(false);
  });

  it("rejects facebook.com paths that aren't the group search", () => {
    expect(isFacebookGroupSearchUrl("https://www.facebook.com/groups/123")).toBe(false);
    expect(isFacebookGroupSearchUrl("https://www.facebook.com/search/people/?q=x")).toBe(false);
  });
});

describe("normalizeSuggestions", () => {
  it("builds the search URL itself and never trusts a model-supplied URL", () => {
    const [s] = normalizeSuggestions([raw({ search_query: "local makers" })]);
    expect(s.facebook_search_url).toBe(facebookGroupSearchUrl("local makers"));
    expect(isFacebookGroupSearchUrl(s.facebook_search_url)).toBe(true);
    expect(s.suggested_search_query).toBe("local makers");
  });

  it("preserves the model's fields and a null member estimate", () => {
    const [s] = normalizeSuggestions([
      raw({ name: " Vegan Bakers ", topic: " Food ", approx_members: null }),
    ]);
    expect(s.name).toBe("Vegan Bakers"); // trimmed
    expect(s.topic).toBe("Food");
    expect(s.approx_members).toBeNull();
  });

  it("dedupes case-insensitively on the search query (first wins)", () => {
    const out = normalizeSuggestions([
      raw({ name: "First", search_query: "Indie Hackers" }),
      raw({ name: "Dup", search_query: "indie hackers" }),
      raw({ name: "Other", search_query: "no code makers" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe("First");
    expect(out.map((s) => s.suggested_search_query)).toEqual(["Indie Hackers", "no code makers"]);
  });

  it("excludes queries the workspace already has (existingQueries), case-insensitively", () => {
    const out = normalizeSuggestions(
      [
        raw({ search_query: "indie hackers" }),
        raw({ name: "New", search_query: "etsy sellers" }),
      ],
      ["Indie Hackers"], // already discovered
    );
    expect(out).toHaveLength(1);
    expect(out[0].suggested_search_query).toBe("etsy sellers");
  });

  it("drops suggestions whose query is empty after trim", () => {
    const out = normalizeSuggestions([
      raw({ search_query: "   " }),
      raw({ name: "Keep", search_query: "fitness coaches" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Keep");
  });

  it("caps the result at 8 suggestions", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      raw({ name: `G${i}`, search_query: `query ${i}` }),
    );
    expect(normalizeSuggestions(many)).toHaveLength(8);
  });

  it("returns an empty array when everything is filtered out", () => {
    expect(normalizeSuggestions([raw({ search_query: "x" })], ["X"])).toEqual([]);
  });
});

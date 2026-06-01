#!/usr/bin/env node
// =============================================================================
// prod-smoke.mjs — marketingmagic production go-live smoke test
// =============================================================================
//
// PURPOSE
//   A re-runnable CLI that hits the LIVE deployment and verifies the things
//   that block customer onboarding. Run it after every dashboard / env change
//   to get a green/red board. It reads all config from env vars / CLI flags —
//   it never needs a secret it shouldn't already have on the operator's machine.
//
// USAGE
//   node scripts/prod-smoke.mjs [options]
//
//   Options:
//     --url <url>            Prod base URL  (default: https://marketingmagic.vercel.app
//                                            or $SITE_URL)
//     --cron-secret <s>      CRON_SECRET — enables the WITH-secret 200 cron check
//                            (or $CRON_SECRET)
//     --mpt-url <url>        MPT render worker base URL
//                            (default: https://mpt-render-worker.onrender.com
//                                       or $MPT_BASE_URL)
//     --mpt-token <s>        MPT_API_TOKEN (x-api-key) — enables the authed
//                            "not-401" reachability check (or $MPT_API_TOKEN)
//     --timeout <ms>         Per-request timeout (default 10000)
//     --no-color             Disable ANSI color
//     --help, -h             Show this help and exit
//
//   Exit code: 0 if there are zero FAILs, 1 otherwise. (WARNs do not fail.)
//
// WHAT EACH CHECK MAPS TO (the go-live blocker it guards)
//   1. Homepage 200 ............. App booted & served a page. If boot-critical
//                                 env (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY /
//                                 SERVICE_ROLE_KEY / ANTHROPIC_API_KEY /
//                                 CRON_SECRET) were missing, serverEnv() throws
//                                 and EVERY route 500s. A 200 here proves env OK.
//   2. Auth-gated route 3xx ..... /video & /queue must redirect to login when
//                                 unauthenticated. A redirect (not 500) confirms
//                                 the server-side env loaded inside an app route,
//                                 i.e. serverEnv() didn't throw mid-request.
//   3. Cron auth gate ........... /api/cron/poll-video-jobs must 401 without the
//                                 secret (so randoms can't trigger crons) and,
//                                 if --cron-secret is given, 200 with it (so the
//                                 real scheduler can actually run the pipeline).
//   4. MPT worker /docs 200 ..... The video render worker (FastAPI on Render)
//                                 must be awake. No video onboarding without it.
//   5. MPT worker auth gate ..... POST /api/v1/videos without x-api-key must 401
//                                 (worker up + protected). With --mpt-token we
//                                 only verify the response is NOT 401 — we never
//                                 actually start a render.
//   6. Stripe webhook configured  POST /api/webhooks/stripe with a bogus body:
//                                 400 = configured (signature rejected) = PASS;
//                                 503 = STRIPE_WEBHOOK_SECRET unset = FAIL (no
//                                 paying customers can be provisioned); else WARN.
//
// ZERO new dependencies — built-in fetch / node:process / node:fs only.
// =============================================================================

import process from "node:process";

// ----------------------------------------------------------------------------
// CLI parsing
// ----------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    url: undefined,
    cronSecret: undefined,
    mptUrl: undefined,
    mptToken: undefined,
    timeout: undefined,
    color: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--url": out.url = next(); break;
      case "--cron-secret": out.cronSecret = next(); break;
      case "--mpt-url": out.mptUrl = next(); break;
      case "--mpt-token": out.mptToken = next(); break;
      case "--timeout": out.timeout = Number(next()); break;
      case "--no-color": out.color = false; break;
      case "--help":
      case "-h": out.help = true; break;
      default:
        if (a.startsWith("--")) {
          console.error(`Unknown option: ${a}\nRun with --help for usage.`);
          process.exit(2);
        }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  // Print the top-of-file usage block (everything up to the closing banner).
  const banner = [
    "prod-smoke.mjs — marketingmagic production go-live smoke test",
    "",
    "USAGE",
    "  node scripts/prod-smoke.mjs [options]",
    "",
    "  --url <url>          Prod base URL (default https://marketingmagic.vercel.app or $SITE_URL)",
    "  --cron-secret <s>    CRON_SECRET — enables WITH-secret 200 cron check (or $CRON_SECRET)",
    "  --mpt-url <url>      MPT worker base URL (default https://mpt-render-worker.onrender.com or $MPT_BASE_URL)",
    "  --mpt-token <s>      MPT_API_TOKEN (x-api-key) — enables authed not-401 check (or $MPT_API_TOKEN)",
    "  --timeout <ms>       Per-request timeout (default 10000)",
    "  --no-color           Disable ANSI color",
    "  --help, -h           Show this help",
    "",
    "Exit code 0 if zero FAILs, else 1. See the header comment in this file for what each check guards.",
  ].join("\n");
  console.log(banner);
  process.exit(0);
}

// ----------------------------------------------------------------------------
// Config resolution (flag > env > default)
// ----------------------------------------------------------------------------

const BASE_URL = stripTrailingSlash(
  args.url || process.env.SITE_URL || "https://marketingmagic.vercel.app",
);
const MPT_BASE_URL = stripTrailingSlash(
  args.mptUrl || process.env.MPT_BASE_URL || "https://mpt-render-worker.onrender.com",
);
const CRON_SECRET = args.cronSecret || process.env.CRON_SECRET || undefined;
const MPT_TOKEN = args.mptToken || process.env.MPT_API_TOKEN || undefined;
const TIMEOUT_MS = Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : 10_000;

function stripTrailingSlash(u) {
  return typeof u === "string" ? u.replace(/\/+$/, "") : u;
}

// ----------------------------------------------------------------------------
// Color / formatting (degrade gracefully when not a TTY or --no-color)
// ----------------------------------------------------------------------------

const useColor =
  args.color === false ? false : Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const yellow = (s) => c("33", s);
const dim = (s) => c("2", s);
const bold = (s) => c("1", s);

const STATUS_RENDER = {
  PASS: () => green("PASS"),
  FAIL: () => red("FAIL"),
  WARN: () => yellow("WARN"),
};

// ----------------------------------------------------------------------------
// HTTP helper — every request is wrapped in a per-call AbortController timeout
// so a single hung/refused connection can never abort the whole run.
// ----------------------------------------------------------------------------

async function request(method, url, { headers, body, redirect = "manual" } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect, // "manual" so 3xx are observable instead of auto-followed
      signal: ctrl.signal,
    });
    return { ok: true, status: res.status, location: res.headers.get("location") };
  } catch (err) {
    const aborted = err && (err.name === "AbortError" || ctrl.signal.aborted);
    return {
      ok: false,
      status: 0,
      error: aborted ? `timeout after ${TIMEOUT_MS}ms` : (err?.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// Check runner — each check returns { status, code, meaning }. We never let a
// thrown error escape: the catch turns it into a FAIL so the board stays green/red.
// ----------------------------------------------------------------------------

const results = [];

async function check(name, fn) {
  let outcome;
  try {
    outcome = await fn();
  } catch (err) {
    outcome = { status: "FAIL", code: "ERR", meaning: `unexpected: ${err?.message || err}` };
  }
  results.push({ name, ...outcome });
}

// Helper for the common "saw status N" code label.
const codeLabel = (r) => (r.ok ? String(r.status) : (r.error || "no response"));

// ----------------------------------------------------------------------------
// The checks
// ----------------------------------------------------------------------------

async function checkHomepage() {
  const r = await request("GET", `${BASE_URL}/`, { redirect: "manual" });
  if (!r.ok) return { status: "FAIL", code: codeLabel(r), meaning: "homepage unreachable — deploy down" };
  // A public marketing homepage should be 200. Some setups 3xx the root to a
  // marketing path; treat a redirect as a WARN (booted, but not the expected page).
  if (r.status === 200) return { status: "PASS", code: "200", meaning: "app booted, serverEnv() OK" };
  if (r.status >= 300 && r.status < 400)
    return { status: "WARN", code: String(r.status), meaning: `root redirects → ${r.location || "?"} (still booted)` };
  if (r.status >= 500)
    return { status: "FAIL", code: String(r.status), meaning: "5xx — likely missing boot-critical env (serverEnv threw)" };
  return { status: "WARN", code: String(r.status), meaning: "unexpected status for homepage" };
}

async function checkAuthGatedRoute() {
  // Try /video first, fall back to /queue — either redirecting to auth proves
  // the route's serverEnv() loaded without throwing.
  const paths = ["/video", "/queue"];
  let last;
  for (const p of paths) {
    const r = await request("GET", `${BASE_URL}${p}`, { redirect: "manual" });
    last = { p, r };
    if (r.ok && r.status >= 300 && r.status < 400)
      return { status: "PASS", code: String(r.status), meaning: `${p} → auth redirect (serverEnv OK)` };
    if (r.ok && r.status === 200)
      // 200 means it rendered something without redirecting — unusual for a
      // gated route but proves no 500; surface as WARN to be investigated.
      return { status: "WARN", code: "200", meaning: `${p} returned 200 (expected auth redirect)` };
  }
  const r = last.r;
  if (!r.ok) return { status: "FAIL", code: codeLabel(r), meaning: `${last.p} unreachable` };
  if (r.status >= 500)
    return { status: "FAIL", code: String(r.status), meaning: `${last.p} 5xx — serverEnv() likely threw in-route` };
  return { status: "WARN", code: String(r.status), meaning: `${last.p} unexpected status` };
}

async function checkCronAuth() {
  const url = `${BASE_URL}/api/cron/poll-video-jobs`;
  // Without secret → must be 401.
  const noSecret = await request("GET", url, { redirect: "manual" });
  if (!noSecret.ok)
    return { status: "FAIL", code: codeLabel(noSecret), meaning: "cron endpoint unreachable" };
  if (noSecret.status !== 401) {
    if (noSecret.status >= 500)
      return { status: "FAIL", code: String(noSecret.status), meaning: "cron 5xx (env may be broken)" };
    return {
      status: "FAIL",
      code: String(noSecret.status),
      meaning: `cron NOT gated — expected 401, got ${noSecret.status} (anyone could trigger crons)`,
    };
  }
  // 401 confirmed. If we have the secret, prove the authed path returns 200.
  if (!CRON_SECRET)
    return { status: "PASS", code: "401", meaning: "auth gate works (pass --cron-secret to verify 200 path)" };

  const withSecret = await request("GET", url, {
    redirect: "manual",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  if (!withSecret.ok)
    return { status: "FAIL", code: codeLabel(withSecret), meaning: "cron unreachable WITH secret" };
  if (withSecret.status === 200)
    return { status: "PASS", code: "401→200", meaning: "gated without secret, runs with it" };
  if (withSecret.status === 401)
    return { status: "FAIL", code: "401", meaning: "secret rejected — CRON_SECRET mismatch vs prod" };
  if (withSecret.status >= 500)
    return { status: "WARN", code: String(withSecret.status), meaning: "authed cron 5xx — ran but errored (deps?)" };
  return { status: "WARN", code: String(withSecret.status), meaning: `authed cron unexpected ${withSecret.status}` };
}

async function checkMptDocs() {
  const r = await request("GET", `${MPT_BASE_URL}/docs`, { redirect: "follow" });
  if (!r.ok) return { status: "FAIL", code: codeLabel(r), meaning: "MPT worker unreachable (Render asleep/down?)" };
  if (r.status === 200) return { status: "PASS", code: "200", meaning: "MPT FastAPI awake" };
  if (r.status >= 500) return { status: "FAIL", code: String(r.status), meaning: "MPT 5xx" };
  return { status: "WARN", code: String(r.status), meaning: `MPT /docs unexpected ${r.status}` };
}

async function checkMptAuth() {
  const url = `${MPT_BASE_URL}/api/v1/videos`;
  // Without x-api-key → expect 401 (worker up + gated). We send an empty body;
  // a correctly-gated worker rejects on auth BEFORE validating the body.
  const noKey = await request("POST", url, {
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!noKey.ok) return { status: "FAIL", code: codeLabel(noKey), meaning: "MPT API unreachable" };
  if (noKey.status !== 401) {
    if (noKey.status >= 500)
      return { status: "WARN", code: String(noKey.status), meaning: "MPT 5xx on unauthed POST (up but erroring)" };
    return {
      status: "FAIL",
      code: String(noKey.status),
      meaning: `MPT NOT gated — expected 401, got ${noKey.status}`,
    };
  }
  if (!MPT_TOKEN)
    return { status: "PASS", code: "401", meaning: "worker up + gated (pass --mpt-token to verify authed reachability)" };

  // With the token we only confirm the response is NOT 401 — we deliberately
  // send a body that won't kick off a real render; a 4xx validation error or a
  // 2xx are both fine here. The ONLY failure is "still 401" (bad/rejected key).
  const withKey = await request("POST", url, {
    redirect: "manual",
    headers: { "content-type": "application/json", "x-api-key": MPT_TOKEN },
    body: "{}", // intentionally invalid render payload → never starts a render
  });
  if (!withKey.ok) return { status: "FAIL", code: codeLabel(withKey), meaning: "MPT unreachable WITH key" };
  if (withKey.status === 401)
    return { status: "FAIL", code: "401", meaning: "MPT_API_TOKEN rejected — key mismatch vs worker" };
  return {
    status: "PASS",
    code: `401→${withKey.status}`,
    meaning: "key accepted (no render started — empty payload rejected by validation)",
  };
}

async function checkStripeWebhook() {
  const url = `${BASE_URL}/api/webhooks/stripe`;
  // Bogus body + no valid signature. 503 = secret unset, 400 = configured
  // (signature/header rejected), anything else is unexpected.
  const r = await request("POST", url, {
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ smoke: "test" }),
  });
  if (!r.ok) return { status: "FAIL", code: codeLabel(r), meaning: "stripe webhook unreachable" };
  if (r.status === 400)
    return { status: "PASS", code: "400", meaning: "webhook configured (bad signature correctly rejected)" };
  if (r.status === 503)
    return { status: "FAIL", code: "503", meaning: "STRIPE_WEBHOOK_SECRET unset — paid signups can't be provisioned" };
  if (r.status >= 500)
    return { status: "WARN", code: String(r.status), meaning: "stripe webhook 5xx (not 503) — investigate" };
  return { status: "WARN", code: String(r.status), meaning: `unexpected ${r.status} (expected 400)` };
}

// ----------------------------------------------------------------------------
// Run
// ----------------------------------------------------------------------------

async function main() {
  console.log(bold("\nmarketingmagic — production go-live smoke test"));
  console.log(dim(`  site:    ${BASE_URL}`));
  console.log(dim(`  mpt:     ${MPT_BASE_URL}`));
  console.log(dim(`  timeout: ${TIMEOUT_MS}ms`));
  console.log(
    dim(
      `  secrets: cron-secret=${CRON_SECRET ? "set" : "—"}  mpt-token=${MPT_TOKEN ? "set" : "—"}`,
    ),
  );
  console.log("");

  await check("1. Homepage loads", checkHomepage);
  await check("2. Auth-gated route redirects", checkAuthGatedRoute);
  await check("3. Cron auth gate", checkCronAuth);
  await check("4. MPT worker /docs", checkMptDocs);
  await check("5. MPT worker auth gate", checkMptAuth);
  await check("6. Stripe webhook configured", checkStripeWebhook);

  // Pretty, aligned board.
  const nameW = Math.max(...results.map((r) => r.name.length));
  const codeW = Math.max(...results.map((r) => String(r.code).length), 4);
  for (const r of results) {
    const tag = (STATUS_RENDER[r.status] || ((s) => s))(r.status);
    const name = r.name.padEnd(nameW);
    const code = String(r.code).padStart(codeW);
    console.log(`  ${tag}  ${name}  ${dim(code)}  ${dim(r.meaning)}`);
  }

  const counts = results.reduce(
    (acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc),
    { PASS: 0, FAIL: 0, WARN: 0 },
  );

  console.log("");
  console.log(
    `  ${green(`${counts.PASS} PASS`)}   ${counts.FAIL ? red(`${counts.FAIL} FAIL`) : dim("0 FAIL")}   ${
      counts.WARN ? yellow(`${counts.WARN} WARN`) : dim("0 WARN")
    }`,
  );

  if (!CRON_SECRET)
    console.log(dim("  note: cron 200-path not verified (no --cron-secret / $CRON_SECRET)"));
  if (!MPT_TOKEN)
    console.log(dim("  note: MPT authed-path not verified (no --mpt-token / $MPT_API_TOKEN)"));

  const exitCode = counts.FAIL > 0 ? 1 : 0;
  console.log(
    exitCode === 0 ? green("\n  GO — no blockers detected\n") : red("\n  NO-GO — blockers above\n"),
  );
  process.exit(exitCode);
}

main().catch((err) => {
  // Last-resort guard: even a runner-level crash prints something actionable.
  console.error(red(`\nfatal: ${err?.stack || err}\n`));
  process.exit(1);
});

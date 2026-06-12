// fal-video-smoke.mjs — ONE real end-to-end Kling image-to-video render against
// LIVE fal.ai, to prove the 405 poll-URL fix (commit b4300ce) works in reality.
//
// This is a PAID call (~cents, ~90s). Gated behind --fire so it never runs by
// accident. It mirrors src/lib/video/reference/fal-video-provider.ts EXACTLY:
//   • submit POSTs to the FULL versioned model path
//   • status/result poll the model's APP NAMESPACE (first two path segments)
// and ADDITIONALLY asserts that derived app-namespace URL === the status_url
// fal returns in the submit response. If those match AND a real render completes
// with no 405, the shipped provider (same derivation) is provably correct.
//
// Usage: node scripts/fal-video-smoke.mjs --fire
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

const FIRE = process.argv.includes("--fire");
const KEY = process.env.FAL_API_KEY;
const QUEUE_BASE = "https://queue.fal.run";
// The env default (REFERENCE_VIDEO_FAL_MODEL) — the model the prod adapter uses.
const MODEL = process.env.REFERENCE_VIDEO_FAL_MODEL || "fal-ai/kling-video/v1.6/standard/image-to-video";

// EXACT copy of FalReferenceVideoProvider.requestsBase() — owner+app, first two
// path segments. This is the line the 405 bug lived on.
function requestsBase() {
  const segments = MODEL.split("/").filter(Boolean);
  const app = segments.slice(0, 2).join("/") || segments.join("/");
  return `${QUEUE_BASE}/${app}`;
}

const authHeaders = { Authorization: `Key ${KEY}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function main() {
  if (!KEY) {
    console.error("FAIL: FAL_API_KEY not set in .env / .env.local");
    process.exit(2);
  }
  if (!FIRE) {
    log("Dry run. This fires a REAL paid Kling render (~cents, ~90s).");
    log("Re-run with --fire to actually submit.");
    log(`\n  model        : ${MODEL}`);
    log(`  submit URL   : ${QUEUE_BASE}/${MODEL}`);
    log(`  poll base    : ${requestsBase()}   <- app namespace (the fix)`);
    process.exit(0);
  }

  // 1) Seed still — FLUX schnell, synchronous, sub-cent. Gives us a public CDN
  //    image_url Kling can condition on (a smoke render; quality irrelevant).
  log("① generating seed still (flux/schnell)…");
  const seedRes = await fetch("https://fal.run/fal-ai/flux/schnell", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      prompt:
        "a calm sunlit modern office desk with a laptop and a coffee cup, shallow depth of field, photographic, 16:9",
      image_size: "landscape_16_9",
      num_images: 1,
      num_inference_steps: 4,
    }),
  });
  if (!seedRes.ok) {
    console.error(`FAIL: flux seed failed (${seedRes.status}): ${(await seedRes.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const seedJson = await seedRes.json();
  const imageUrl = seedJson?.images?.[0]?.url;
  if (!imageUrl) {
    console.error(`FAIL: flux returned no image url: ${JSON.stringify(seedJson).slice(0, 300)}`);
    process.exit(1);
  }
  log(`   seed image: ${imageUrl.slice(0, 80)}…`);

  // 2) Submit the i2v render to the FULL versioned model path.
  log("② submitting Kling image-to-video render…");
  const submitRes = await fetch(`${QUEUE_BASE}/${MODEL}`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      image_url: imageUrl,
      prompt: "slow gentle push-in, soft natural light, subtle camera drift",
      duration: "5",
      aspect_ratio: "16:9",
    }),
  });
  if (!submitRes.ok) {
    console.error(`FAIL: submit failed (${submitRes.status}): ${(await submitRes.text()).slice(0, 400)}`);
    process.exit(1);
  }
  const submitJson = await submitRes.json();
  const requestId = submitJson?.request_id;
  const falStatusUrl = submitJson?.status_url;
  const falResponseUrl = submitJson?.response_url;
  if (!requestId) {
    console.error(`FAIL: submit returned no request_id: ${JSON.stringify(submitJson).slice(0, 300)}`);
    process.exit(1);
  }
  log(`   request_id: ${requestId}`);

  // 3) THE ASSERTION — our derived app-namespace status URL must equal the
  //    status_url fal itself returns. (The provider builds the SAME string.)
  const derivedStatus = `${requestsBase()}/requests/${requestId}/status`;
  const derivedResult = `${requestsBase()}/requests/${requestId}`;
  log("③ asserting derived poll URL === fal's returned status_url");
  log(`   derived : ${derivedStatus}`);
  log(`   fal says: ${falStatusUrl}`);
  const matches = falStatusUrl === derivedStatus;
  log(`   MATCH   : ${matches ? "✓ yes" : "✗ NO — derivation diverges from fal!"}`);

  // 4) Poll the DERIVED url (the fixed path). A 405 here = the old bug.
  log("④ polling derived status URL (≤3min)…");
  const deadline = Date.now() + 3 * 60 * 1000;
  let status = "";
  let saw405 = false;
  while (Date.now() < deadline) {
    const pr = await fetch(derivedStatus, { headers: authHeaders });
    if (pr.status === 405) {
      saw405 = true;
      console.error("FAIL: poll returned 405 — the bug is NOT fixed on this path.");
      break;
    }
    if (!pr.ok && pr.status !== 202) {
      // 200 with a status body is normal; tolerate transient 5xx as "keep going".
      if (pr.status >= 500) {
        log(`   transient ${pr.status}, retrying…`);
        await sleep(5000);
        continue;
      }
      console.error(`FAIL: poll error ${pr.status}: ${(await pr.text()).slice(0, 200)}`);
      process.exit(1);
    }
    const body = await pr.json().catch(() => ({}));
    status = body?.status ?? "";
    log(`   status: ${status || "(none)"}`);
    if (status === "COMPLETED") break;
    await sleep(5000);
  }
  if (saw405) process.exit(1);
  if (status !== "COMPLETED") {
    console.error("FAIL: render did not COMPLETE within the deadline.");
    process.exit(1);
  }

  // 5) Fetch the result envelope via the derived result URL, dig out the mp4.
  log("⑤ fetching result…");
  const resultRes = await fetch(derivedResult, { headers: authHeaders });
  if (!resultRes.ok) {
    console.error(`FAIL: result fetch failed (${resultRes.status}).`);
    process.exit(1);
  }
  const resultJson = await resultRes.json();
  const videoUrl = resultJson?.video?.url ?? resultJson?.output?.video?.url;
  if (!videoUrl) {
    console.error(`FAIL: COMPLETED but no video url: ${JSON.stringify(resultJson).slice(0, 300)}`);
    process.exit(1);
  }

  // 6) Confirm the mp4 is real (pull the bytes — fal CDN url, no auth).
  const vr = await fetch(videoUrl);
  const buf = vr.ok ? new Uint8Array(await vr.arrayBuffer()) : null;
  const sizeKb = buf ? Math.round(buf.byteLength / 1024) : 0;
  const ctype = vr.headers.get("content-type") || "?";

  log("\n=== RESULT ===");
  log(`  derived-URL matches fal status_url : ${matches ? "PASS" : "FAIL"}`);
  log(`  no 405 on poll path                : PASS`);
  log(`  render COMPLETED                   : PASS`);
  log(`  mp4 fetched                        : ${buf ? `PASS (${sizeKb} KB, ${ctype})` : "FAIL"}`);
  log(`  video url                          : ${videoUrl.slice(0, 90)}…`);
  log(`  fal response_url                   : ${falResponseUrl?.slice(0, 90) ?? "(none)"}…`);

  const ok = matches && buf && sizeKb > 0;
  log(ok ? "\n  ✓ FAL VIDEO 405 FIX VERIFIED AGAINST LIVE KLING\n" : "\n  ✗ verification incomplete\n");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e);
  process.exit(1);
});

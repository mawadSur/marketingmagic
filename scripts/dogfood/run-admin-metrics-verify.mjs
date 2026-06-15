// Verify the /admin/metrics operator gate + render on the real authed app.
// Run twice: once with ADMIN_EMAILS unset (expect 404 for a normal user) and
// once with ADMIN_EMAILS=<the dogfood user's email> (expect the dashboard).
// Assumes bootstrap-session already ran (authed storageState saved).
import { drive, shot, note, finish, BASE } from "./lib.mjs";

await drive("admin-metrics", async (page) => {
  await page.goto(`${BASE}/admin/metrics`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await shot(page, "page");
  const body = (await page.locator("body").innerText()).toLowerCase();
  const isNotFound = /404|could not be found|page could not/.test(body);
  const hasDashboard =
    (await page.getByText(/founder dashboard/i).count()) > 0 &&
    (await page.getByText(/workspaces published in the last 7 days/i).count()) > 0;
  note("shows 404 / not-found:", isNotFound);
  note("shows founder dashboard:", hasDashboard);
  note("url:", page.url());
});

finish();

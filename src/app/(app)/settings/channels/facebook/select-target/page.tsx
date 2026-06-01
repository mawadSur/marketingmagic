import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { FB_PAGE_PICKER_COOKIE, type FacebookPickerStash } from "@/lib/social/facebook";
import { selectFacebookPageAction } from "./actions";

// Post-OAuth Page picker. Reached only when the Facebook OAuth callback found
// MORE than one publishable Page on the operator's account and stashed them in
// the short-lived `fb_page_picker` cookie. With exactly one Page the callback
// finalizes it directly and this page never renders.
//
// Page tokens live only in that httpOnly cookie (server-side). We render Page
// *names* here; the secret token is never sent to the client. The pick action
// resolves the chosen Page's token from the same cookie and inserts the row.

export const dynamic = "force-dynamic";

export default async function FacebookSelectTargetPage() {
  const ws = await getActiveWorkspaceOrRedirect();

  const raw = (await cookies()).get(FB_PAGE_PICKER_COOKIE)?.value;
  if (!raw) redirect("/settings/channels");

  let stash: FacebookPickerStash;
  try {
    stash = JSON.parse(raw) as FacebookPickerStash;
  } catch {
    redirect("/settings/channels?error=facebook_picker_expired");
  }

  // The cookie is bound to the workspace that started the OAuth flow. If the
  // operator switched workspaces between auth and pick, bail rather than map a
  // Page to the wrong client.
  if (stash.workspaceId !== ws.id) {
    redirect("/settings/channels?error=facebook_picker_workspace_mismatch");
  }
  const candidates = stash.pages ?? [];
  if (candidates.length === 0) redirect("/settings/channels");

  return (
    <main className="mx-auto max-w-2xl space-y-6 py-8">
      <header className="space-y-2">
        <p className="label-eyebrow">Facebook · Page</p>
        <h1 className="text-3xl font-semibold tracking-tight">Which Page should we post to?</h1>
        <p className="text-sm text-muted-foreground">
          You manage {candidates.length} Facebook Pages. Pick the one to connect to{" "}
          <span className="font-medium">{ws.name}</span>. Posts for this workspace will publish
          to the Page you choose. You can connect Facebook again later to map a different Page.
        </p>
      </header>

      <form action={selectFacebookPageAction} className="space-y-3">
        {candidates.map((page, i) => (
          <label
            key={page.pageId}
            className="flex items-start gap-3 rounded-lg border p-4 hover:bg-muted/30 cursor-pointer"
          >
            <input
              type="radio"
              name="page_id"
              value={page.pageId}
              defaultChecked={i === 0}
              className="mt-1"
            />
            <div>
              <p className="font-medium">{page.pageName}</p>
              <p className="text-xs text-muted-foreground">
                Posts go on the {page.pageName} Page feed.
              </p>
            </div>
          </label>
        ))}

        <div className="pt-2">
          <Button type="submit" className="w-full">
            Connect this Page
          </Button>
        </div>
      </form>
    </main>
  );
}

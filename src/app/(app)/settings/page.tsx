import { redirect } from "next/navigation";

// "Settings" in the top nav lands here; send the user to the first tab.
// (The settings tab bar in layout.tsx handles movement between sections.)
export default function SettingsIndex() {
  redirect("/settings/channels");
}

"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { saveAudienceTimezoneAction } from "./actions";

// A curated, short list of common audience timezones. Users can type a
// different IANA value too (free-text input) — the server-side validation
// accepts any zone Intl recognises.
const TIMEZONE_PRESETS: Array<{ value: string; label: string }> = [
  { value: "UTC", label: "UTC" },
  { value: "America/Los_Angeles", label: "Pacific — Los Angeles" },
  { value: "America/Denver", label: "Mountain — Denver" },
  { value: "America/Chicago", label: "Central — Chicago" },
  { value: "America/New_York", label: "Eastern — New York" },
  { value: "America/Sao_Paulo", label: "São Paulo" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris / Berlin / Madrid" },
  { value: "Europe/Istanbul", label: "Istanbul" },
  { value: "Africa/Lagos", label: "Lagos" },
  { value: "Africa/Johannesburg", label: "Johannesburg" },
  { value: "Asia/Dubai", label: "Dubai" },
  { value: "Asia/Karachi", label: "Karachi" },
  { value: "Asia/Kolkata", label: "Mumbai / Bangalore" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Asia/Seoul", label: "Seoul" },
  { value: "Asia/Shanghai", label: "Shanghai / Beijing" },
  { value: "Australia/Sydney", label: "Sydney" },
];

export function TimezoneSection({ initial }: { initial: string | null }) {
  const current = initial ?? "UTC";
  const [value, setValue] = useState<string>(current);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // If the saved value isn't in our preset list, show it in the dropdown so
  // the user can see what's stored (and switch to a preset if they want).
  const hasCustom = !TIMEZONE_PRESETS.some((p) => p.value === current);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await saveAudienceTimezoneAction(value);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSavedAt(new Date().toISOString());
    });
  }

  return (
    <section className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="space-y-1">
        <Label htmlFor="audience_timezone" className="text-sm">
          Audience timezone
        </Label>
        <p className="text-xs text-muted-foreground">
          The clock smart-timing buckets your posts in. Defaults to UTC. Change to wherever your audience reads.
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          id="audience_timezone"
          name="audience_timezone"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-9 w-full rounded-md border bg-background px-3 text-sm transition-colors duration-200 sm:max-w-xs"
        >
          {hasCustom ? <option value={current}>{current} (custom)</option> : null}
          {TIMEZONE_PRESETS.map((tz) => (
            <option key={tz.value} value={tz.value}>
              {tz.label}
            </option>
          ))}
        </select>

        <Button
          type="button"
          onClick={submit}
          disabled={pending || value === current}
          className="sm:shrink-0"
        >
          {pending ? "Saving…" : "Save timezone"}
        </Button>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {savedAt && !error ? (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          Saved {new Date(savedAt).toLocaleTimeString()}. Smart-timing will use this on next refresh.
        </p>
      ) : null}
    </section>
  );
}

"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { proposeStrategyAction, type ProposeStrategyState } from "./actions";

const initial: ProposeStrategyState = { error: null, goalId: null };

type Metric = "followers" | "inbound" | "launch_date" | "credibility" | "recovery" | "custom";

const METRIC_OPTIONS: Array<{ value: Metric; label: string; placeholder: string; showValue: boolean; showDate: boolean }> = [
  { value: "followers", label: "Followers (audience size)", placeholder: "Hit 5,000 X followers", showValue: true, showDate: true },
  { value: "inbound", label: "Inbound (qualified DMs / leads)", placeholder: "Land 25 design-partner intros", showValue: true, showDate: true },
  { value: "launch_date", label: "Launch (build buzz to a date)", placeholder: "Launch the public beta", showValue: false, showDate: true },
  { value: "credibility", label: "Credibility (authority in a niche)", placeholder: "Become a known voice on B2B onboarding", showValue: false, showDate: false },
  { value: "recovery", label: "Recovery (rebuild after a quiet stretch)", placeholder: "Restart after a 3-month posting gap", showValue: false, showDate: false },
  { value: "custom", label: "Custom (anything else)", placeholder: "Describe your goal", showValue: true, showDate: true },
];

export function GoalForm() {
  const [state, formAction, pending] = useActionState(proposeStrategyAction, initial);
  const [metric, setMetric] = useState<Metric>("followers");

  const opt = METRIC_OPTIONS.find((o) => o.value === metric) ?? METRIC_OPTIONS[0]!;

  return (
    <form action={formAction} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="goal_metric">Metric</Label>
        <select
          id="goal_metric"
          name="goal_metric"
          value={metric}
          onChange={(e) => setMetric(e.target.value as Metric)}
          className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {METRIC_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          The strategist tunes its cadence and milestone arc to the metric you pick.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {opt.showValue ? (
          <div className="space-y-2">
            <Label htmlFor="target_value">Target value</Label>
            <Input
              id="target_value"
              name="target_value"
              type="number"
              step="any"
              min="0"
              placeholder={metric === "followers" ? "5000" : metric === "inbound" ? "25" : "100"}
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Number you want to hit. Leave blank for a qualitative goal.
            </p>
          </div>
        ) : null}
        {opt.showDate ? (
          <div className="space-y-2">
            <Label htmlFor="target_date">Target date</Label>
            <Input
              id="target_date"
              name="target_date"
              type="date"
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Sets the strategy's weeks count. Distance to today.
            </p>
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="goal_text">Goal description</Label>
        <Textarea
          id="goal_text"
          name="goal_text"
          rows={4}
          placeholder={opt.placeholder}
          required
          minLength={10}
          maxLength={1000}
          className="text-sm"
        />
        <p className="text-xs text-muted-foreground">
          One or two sentences. The more specific you are about the audience and the constraint, the
          better the strategy.
        </p>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Proposing strategy (≈8s)…" : "Propose strategy"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Strategy preview is the next screen. Nothing is generated until you approve.
      </p>
    </form>
  );
}

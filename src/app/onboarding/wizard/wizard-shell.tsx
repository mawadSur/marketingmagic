"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";

export interface WizardShellProps {
  step: 1 | 2 | 3 | 4;
  title: string;
  subtitle?: string;
  /** Where Skip should send the user. `null` hides the skip link entirely. */
  skipHref?: string | null;
  skipLabel?: string;
  /** The body of the current step. */
  children: React.ReactNode;
}

const STEP_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: "Your brand",
  2: "Connect a channel",
  3: "First plan",
  4: "All set",
};

const TOTAL_STEPS = 4;

/**
 * Wizard chrome: progress dots up top, page body in the middle, and a
 * footer with Back / Skip controls. The "Next" action lives inside each
 * step body (because it's tied to the step's own form submission), so
 * this shell only owns navigation between steps.
 */
export function WizardShell({ step, title, subtitle, skipHref, skipLabel = "Skip for now", children }: WizardShellProps) {
  const router = useRouter();

  function handleBack() {
    if (step === 1) {
      router.push("/dashboard");
      return;
    }
    router.push(`/onboarding/wizard?step=${step - 1}`);
  }

  return (
    <main className="container flex min-h-screen flex-col items-center py-12 sm:py-16">
      <div className="w-full max-w-2xl space-y-10">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2" aria-label={`Step ${step} of ${TOTAL_STEPS}`}>
          {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((n) => {
            const isActive = n === step;
            const isDone = n < step;
            return (
              <div key={n} className="flex items-center gap-2">
                <span
                  className={
                    isActive
                      ? "h-2.5 w-2.5 rounded-full bg-primary"
                      : isDone
                        ? "h-2.5 w-2.5 rounded-full bg-primary/60"
                        : "h-2.5 w-2.5 rounded-full bg-muted-foreground/25"
                  }
                  aria-hidden
                />
                {n < TOTAL_STEPS ? (
                  <span
                    className={
                      isDone ? "h-px w-6 bg-primary/60" : "h-px w-6 bg-muted-foreground/25"
                    }
                    aria-hidden
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="text-center text-xs uppercase tracking-wide text-muted-foreground">
          Step {step} of {TOTAL_STEPS} · {STEP_LABELS[step]}
        </div>

        {/* Header */}
        <header className="space-y-3 text-center">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
          {subtitle ? (
            <p className="mx-auto max-w-xl text-sm text-muted-foreground sm:text-base">{subtitle}</p>
          ) : null}
        </header>

        {/* Step body */}
        <div className="space-y-6">{children}</div>

        {/* Footer */}
        <footer className="flex items-center justify-between border-t pt-6 text-sm">
          <button
            type="button"
            onClick={handleBack}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            {step === 1 ? "Exit to dashboard" : "Back"}
          </button>
          {skipHref ? (
            <Link
              href={skipHref}
              className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {skipLabel}
            </Link>
          ) : null}
        </footer>
      </div>
    </main>
  );
}

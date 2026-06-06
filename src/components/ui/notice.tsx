import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Notice — small inline callout box. Replaces the repeated
 * `rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm` (and
 * its emerald/sky cousins) that were scattered across the app at
 * inconsistent shades. Tinted off the --warning / --success tokens so the
 * colours live in one place.
 *
 * Optional `title` renders as a font-medium line; `children` flow beneath it
 * in muted text. With no title, children render at the variant's text colour.
 */

const noticeVariants = cva("rounded-md border p-4 text-sm", {
  variants: {
    variant: {
      warning: "border-warning/40 bg-warning/5 text-warning",
      success: "border-success/40 bg-success/5 text-success",
      info: "border-sky-500/40 bg-sky-500/5 text-sky-700 dark:text-sky-400",
    },
  },
  defaultVariants: { variant: "info" },
});

export interface NoticeProps
  // Omit the native `title` (a string tooltip attr) so we can accept a
  // ReactNode heading instead.
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof noticeVariants> {
  title?: React.ReactNode;
}

export function Notice({ className, variant, title, children, ...props }: NoticeProps) {
  return (
    <div className={cn(noticeVariants({ variant }), className)} {...props}>
      {title ? <p className="font-medium">{title}</p> : null}
      {children ? (
        <div className={cn("text-muted-foreground", title && "mt-1")}>{children}</div>
      ) : null}
    </div>
  );
}

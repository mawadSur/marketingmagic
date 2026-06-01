"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { VideoJobStatus } from "@/lib/video/jobs";

// One row of the job table, projected down to only what the UI renders. We
// never expose mpt_task_id or params to keep the surface tight.
export interface JobListItem {
  id: string;
  status: VideoJobStatus;
  progress: number;
  subject: string;
  aspect: string;
  failureReason: string | null;
  createdAt: string;
  // Set once the finished render is attached to a draft post, so a "ready" row
  // can deep-link the user to review/approve it in the queue.
  postId?: string | null;
}

const STATUS_STYLE: Record<VideoJobStatus, string> = {
  pending: "border-muted-foreground/30 bg-muted/30 text-muted-foreground",
  processing: "border-sky-500/40 bg-sky-500/5 text-sky-700 dark:text-sky-400",
  ready: "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
  failed: "border-destructive/40 bg-destructive/5 text-destructive",
};

const STATUS_LABEL: Record<VideoJobStatus, string> = {
  pending: "Queued",
  processing: "Rendering",
  ready: "Ready",
  failed: "Failed",
};

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function JobList({ jobs }: { jobs: JobListItem[] }) {
  const router = useRouter();

  // Poll while anything is still in flight. Server component re-renders with
  // fresh rows on router.refresh(); we stop polling once everything settles
  // so an idle tab isn't hammering the DB.
  const hasActive = jobs.some((j) => j.status === "pending" || j.status === "processing");
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [hasActive, router]);

  return (
    <ul className="divide-y rounded-lg border">
      {jobs.map((job) => (
        <li key={job.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <p className="truncate text-sm font-medium">{job.subject}</p>
            <p className="text-xs text-muted-foreground">
              {job.aspect} · {fmt(job.createdAt)}
            </p>
            {job.status === "failed" && job.failureReason ? (
              <p className="text-xs text-destructive">{job.failureReason}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            {job.status === "processing" ? (
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-sky-500 transition-all"
                    style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
                  />
                </div>
                <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                  {job.progress}%
                </span>
              </div>
            ) : null}
            {job.status === "ready" && job.postId ? (
              <Link
                href="/queue"
                className="text-xs font-medium text-primary underline-offset-4 hover:underline"
              >
                Review in queue →
              </Link>
            ) : null}
            <span
              className={
                "inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium " +
                STATUS_STYLE[job.status]
              }
            >
              {STATUS_LABEL[job.status]}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

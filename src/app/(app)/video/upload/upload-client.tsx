"use client";

// SLICE A — User video upload · client component.
//
// Picks a local video, mints a signed upload ticket (server action), uploads the
// bytes DIRECTLY to Supabase Storage with a real progress bar, then finalises the
// row and routes to the clip editor. The bytes never touch the server action body
// (which caps at ~6MB), so multi-hundred-MB phone/screen-capture footage works.
//
// Progress: Supabase's `uploadToSignedUrl` doesn't surface upload progress, so we
// PUT to the signed URL ourselves via XHR (xhr.upload.onprogress). The signed URL
// is built from the storage base + the bucket/path + ?token=<token>, exactly the
// endpoint uploadToSignedUrl posts to.

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { publicEnv } from "@/lib/env";
import { SOURCE_VIDEO_BUCKET } from "@/lib/video/uploads/types";
import {
  createUploadTicketAction,
  registerUploadedVideoAction,
} from "./actions";

const ACCEPT = "video/mp4,video/quicktime,video/webm";
const ALLOWED_MIME = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // keep in lockstep with the action.

type Phase = "idle" | "uploading" | "finalising" | "done" | "error";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Probe duration/dimensions from a <video> element (best-effort; never blocks).
async function probeVideo(
  file: File,
): Promise<{ duration: number | null; width: number | null; height: number | null }> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const el = document.createElement("video");
      el.preload = "metadata";
      const cleanup = () => URL.revokeObjectURL(url);
      el.onloadedmetadata = () => {
        const out = {
          duration: Number.isFinite(el.duration) ? el.duration : null,
          width: el.videoWidth || null,
          height: el.videoHeight || null,
        };
        cleanup();
        resolve(out);
      };
      el.onerror = () => {
        cleanup();
        resolve({ duration: null, width: null, height: null });
      };
      el.src = url;
    } catch {
      resolve({ duration: null, width: null, height: null });
    }
  });
}

// PUT the file to the signed upload URL with byte-level progress.
function putWithProgress(
  signedUrl: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl, true);
    // Mirror uploadToSignedUrl's raw-body PUT headers.
    xhr.setRequestHeader("x-upsert", "false");
    xhr.setRequestHeader("cache-control", "max-age=3600");
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    xhr.send(file);
  });
}

export function UploadClient({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const onPick = useCallback((f: File | null) => {
    setError(null);
    if (!f) {
      setFile(null);
      return;
    }
    if (!ALLOWED_MIME.has(f.type)) {
      setFile(null);
      setError("Video must be MP4, MOV, or WebM.");
      return;
    }
    if (f.size > MAX_BYTES) {
      setFile(null);
      setError("Video must be 2GB or smaller.");
      return;
    }
    setFile(f);
  }, []);

  const onUpload = useCallback(async () => {
    if (!file) return;
    setError(null);
    setPhase("uploading");
    setPct(0);

    // 1. Mint the signed upload ticket.
    const ticket = await createUploadTicketAction(
      workspaceId,
      file.name,
      file.type,
      file.size,
    );
    if (!ticket.ok) {
      setPhase("error");
      setError(ticket.error);
      return;
    }

    // 2. Build the signed upload URL + PUT the bytes with progress.
    const { NEXT_PUBLIC_SUPABASE_URL } = publicEnv();
    const base = NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
    const signedUrl =
      `${base}/storage/v1/object/upload/sign/${SOURCE_VIDEO_BUCKET}/` +
      `${ticket.ticket.path}?token=${encodeURIComponent(ticket.ticket.token)}`;
    try {
      await putWithProgress(signedUrl, file, setPct);
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Upload failed.");
      return;
    }

    // 3. Probe metadata + finalise the row (flips to ready, kicks transcription).
    setPhase("finalising");
    const meta = await probeVideo(file);
    const registered = await registerUploadedVideoAction(ticket.ticket.uploadedVideoId, meta);
    if (!registered.ok) {
      setPhase("error");
      setError(registered.error);
      return;
    }

    setPhase("done");
    router.push(`/video/upload/${registered.uploadedVideoId}`);
  }, [file, workspaceId, router]);

  const busy = phase === "uploading" || phase === "finalising";

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="source_video">Video file</Label>
        <Input
          id="source_video"
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          disabled={busy}
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        />
        <p className="text-xs text-muted-foreground">
          MP4, MOV, or WebM, up to 2GB. Your footage uploads straight to secure
          storage — it never passes through our server.
        </p>
        {file ? (
          <p className="text-xs text-muted-foreground">
            Selected: {file.name} ({humanSize(file.size)})
          </p>
        ) : null}
      </div>

      {busy ? (
        <div className="space-y-1.5" aria-live="polite">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-150"
              style={{ width: `${phase === "finalising" ? 100 : pct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {phase === "finalising" ? "Finalising…" : `Uploading… ${pct}%`}
          </p>
        </div>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {phase === "done" ? (
        <p className="text-sm text-emerald-600">Uploaded — opening the editor…</p>
      ) : null}

      <Button type="button" onClick={onUpload} disabled={!file || busy || phase === "done"}>
        {busy ? "Uploading…" : "Upload video"}
      </Button>
    </div>
  );
}

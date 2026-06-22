"""Cut one or more clips out of a user-uploaded source video.

The orchestrator hands MPT a signed GET URL to the source plus a list of clip
windows (`start_ms`/`end_ms`, a filesystem-safe `label`, optional pre-sliced
`subtitles_srt`). For each clip we run a single re-encoding ffmpeg pass with
`-ss`/`-to` (re-encode, not stream-copy, so the cut is frame-accurate), burn the
subtitles when requested, and optionally normalize to a target aspect ratio.

Each finished clip lands at `<task_id>/<label>.mp4` and is surfaced in the
task's `videos[]` so the existing GET /tasks/{id} + GET /download/{id}/{file}
state machine serves it back unchanged.

Runs inside MPT's in-process task manager (background thread), owning the task
lifecycle via app.services.state — same shape as the render + extract-audio
tasks.
"""

import os
import re
import subprocess

import requests
from loguru import logger

from app.config import config
from app.models import const
from app.services import state as sm
from app.services.video import get_ffmpeg_binary
from app.utils import utils

# Map the public aspect strings to WxH. Mirrors VideoAspect.to_resolution but is
# kept local so clip output sizes don't drift if the render aspects ever change.
_ASPECT_RESOLUTION = {
    "9:16": (1080, 1920),
    "16:9": (1920, 1080),
    "1:1": (1080, 1080),
}

_LABEL_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]")


def _safe_label(label: str) -> str:
    """Re-validate the clip label at the boundary so a hostile caller can't write
    outside the task dir (path traversal) or collide with reserved names."""
    normalized = (label or "").replace("\\", "/").split("/")[-1].strip()
    normalized = _LABEL_SAFE_RE.sub("_", normalized)
    if not normalized or normalized in {".", ".."}:
        raise ValueError(f"invalid clip label: {label!r}")
    return normalized


def _download_source(source_url: str, dest_path: str):
    """Stream the source video to disk. MPT fetches the URL itself (signed GET)."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
    }
    with requests.get(
        source_url,
        headers=headers,
        proxies=config.proxy,
        stream=True,
        timeout=(60, 600),
    ) as r:
        r.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)
    if not (os.path.exists(dest_path) and os.path.getsize(dest_path) > 0):
        raise RuntimeError("downloaded source is empty")


def _aspect_filter(aspect: str) -> str:
    """Scale-to-fit then pad to the exact target resolution (letterbox/pillarbox).

    Padding (rather than cropping) keeps the whole frame visible — safer default
    for arbitrary user footage where cropping could cut off the subject.
    """
    w, h = _ASPECT_RESOLUTION[aspect]
    return (
        f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1"
    )


def _build_clip_filters(burn_captions: bool, srt_path, aspect):
    """Assemble the ordered -vf chain: aspect normalization first, captions last
    so subtitles are burned at the final output resolution."""
    filters = []
    if aspect in _ASPECT_RESOLUTION:
        filters.append(_aspect_filter(aspect))
    if burn_captions and srt_path:
        # subtitles filter needs the path escaped (colons/backslashes) on the
        # filtergraph; forward-slash + escaped-colon is portable enough here.
        escaped = srt_path.replace("\\", "/").replace(":", "\\:")
        filters.append(f"subtitles='{escaped}'")
    return ",".join(filters)


def _cut_clip(source_path, work_dir, clip, aspect):
    label = _safe_label(clip["label"])
    start_ms = int(clip["start_ms"])
    end_ms = int(clip["end_ms"])
    if end_ms <= start_ms:
        raise ValueError(
            f"clip {label!r}: end_ms ({end_ms}) must be greater than start_ms ({start_ms})"
        )

    burn_captions = bool(clip.get("burn_captions"))
    subtitles_srt = clip.get("subtitles_srt")

    srt_path = None
    if burn_captions and subtitles_srt:
        srt_path = os.path.join(work_dir, f"{label}.srt")
        with open(srt_path, "w", encoding="utf-8") as fp:
            fp.write(subtitles_srt)

    output_path = os.path.join(work_dir, f"{label}.mp4")

    command = [
        get_ffmpeg_binary(),
        "-y",
        # -ss/-to expressed in seconds; placed AFTER -i so ffmpeg decodes from 0
        # and the re-encode lands on a frame boundary (accurate seek).
        "-i",
        source_path,
        "-ss",
        f"{start_ms / 1000:.3f}",
        "-to",
        f"{end_ms / 1000:.3f}",
    ]

    vf = _build_clip_filters(burn_captions, srt_path, aspect)
    if vf:
        command += ["-vf", vf]

    command += [
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-pix_fmt",
        "yuv420p",
        output_path,
    ]

    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        error_message = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(error_message or f"ffmpeg failed to cut clip {label!r}")
    if not (os.path.exists(output_path) and os.path.getsize(output_path) > 0):
        raise RuntimeError(f"clip {label!r} produced an empty file")

    return output_path


def start(task_id: str, source_url: str, clips, aspect=None):
    logger.info(f"start clip task: {task_id}, clips: {len(clips)}")
    sm.state.update_task(task_id, state=const.TASK_STATE_PROCESSING, progress=5)
    try:
        work_dir = utils.task_dir(task_id)
        source_path = os.path.join(work_dir, "source-input")

        _download_source(source_url, source_path)
        sm.state.update_task(task_id, state=const.TASK_STATE_PROCESSING, progress=30)

        outputs = []
        total = len(clips)
        for i, clip in enumerate(clips):
            output_path = _cut_clip(source_path, work_dir, clip, aspect)
            outputs.append(output_path)
            # spread the back half of the bar (30 -> 95) across the clips
            progress = 30 + int((i + 1) / total * 65)
            sm.state.update_task(
                task_id, state=const.TASK_STATE_PROCESSING, progress=progress
            )

        # The source input is large and only needed during cutting.
        try:
            os.remove(source_path)
        except OSError as exc:
            logger.warning(f"failed to remove source input {source_path}: {exc}")

        sm.state.update_task(
            task_id,
            state=const.TASK_STATE_COMPLETE,
            progress=100,
            videos=outputs,
        )
        logger.success(f"clip task {task_id} finished, produced {len(outputs)} clips.")
        return {"videos": outputs}
    except Exception as e:
        logger.exception(f"clip task {task_id} failed: {e}")
        sm.state.update_task(task_id, state=const.TASK_STATE_FAILED)
        return

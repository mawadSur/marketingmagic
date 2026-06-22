"""Extract a compact mono AAC audio track from a source video.

Long user uploads (a 40-minute webinar) blow past Groq/Whisper's ~25MB upload
cap, so the orchestrator can't transcribe the raw video directly. This task
fetches the source (a signed GET URL), strips a small mono AAC `audio.m4a`, and
exposes it via the existing `GET /api/v1/download/{task_id}/audio.m4a` so the MM
side can pull + chunk it for Whisper.

Runs inside MPT's in-process task manager (background thread) exactly like the
render task: it owns the task lifecycle via app.services.state.
"""

import os
import subprocess

import requests
from loguru import logger

from app.config import config
from app.models import const
from app.services import state as sm
from app.services.video import get_ffmpeg_binary
from app.utils import utils


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


def _extract(source_path: str, audio_path: str):
    """ffmpeg: drop video, downmix to mono AAC at a Whisper-friendly bitrate."""
    command = [
        get_ffmpeg_binary(),
        "-y",
        "-i",
        source_path,
        "-vn",  # no video stream
        "-ac",
        "1",  # mono
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        audio_path,
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        error_message = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(error_message or "ffmpeg audio extraction failed")
    if not (os.path.exists(audio_path) and os.path.getsize(audio_path) > 0):
        raise RuntimeError("audio extraction produced an empty file")


def start(task_id: str, source_url: str):
    logger.info(f"start extract-audio task: {task_id}")
    sm.state.update_task(task_id, state=const.TASK_STATE_PROCESSING, progress=5)
    try:
        work_dir = utils.task_dir(task_id)
        source_path = os.path.join(work_dir, "source-input")
        audio_path = os.path.join(work_dir, "audio.m4a")

        _download_source(source_url, source_path)
        sm.state.update_task(task_id, state=const.TASK_STATE_PROCESSING, progress=40)

        _extract(source_path, audio_path)

        # The source input is large and no longer needed once audio is cut.
        try:
            os.remove(source_path)
        except OSError as exc:
            logger.warning(f"failed to remove source input {source_path}: {exc}")

        sm.state.update_task(
            task_id,
            state=const.TASK_STATE_COMPLETE,
            progress=100,
            audio_file=audio_path,
        )
        logger.success(f"extract-audio task {task_id} finished: {audio_path}")
        return {"audio_file": audio_path}
    except Exception as e:
        logger.exception(f"extract-audio task {task_id} failed: {e}")
        sm.state.update_task(task_id, state=const.TASK_STATE_FAILED)
        return

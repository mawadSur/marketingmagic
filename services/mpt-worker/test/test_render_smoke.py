"""Real end-to-end render smoke test (no external API keys required).

This drives a genuine render through the FastAPI app:

  1. Synthesize a tiny local mp4 with the system `ffmpeg` (>=480x480 so it
     passes preprocess_video's minimum-resolution gate).
  2. Upload it via POST /api/v1/video_materials.
  3. POST /api/v1/videos with a *provided* video_script (so the LLM is skipped),
     video_source="local", a local material, an Edge-TTS voice, subtitles on.
  4. Poll GET /api/v1/tasks/{id} until state COMPLETE (1) or FAILED (-1).
  5. Download final-1.mp4 and assert it is a valid, non-trivial mp4.
  6. Clean up via DELETE /api/v1/tasks/{id}.

The render runs in a background thread spawned by MPT's in-process task manager
(see app/controllers/manager/base_manager.execute_task), so the POST returns a
task_id immediately and we poll for completion against the same TestClient.

KNOWN ENVIRONMENT CAVEAT — ffmpeg 8.x:
  MoviePy 2.1.2 cannot read frames from video produced by ffmpeg 8.x: it reports
  "0 frames" and the render fails. Homebrew on macOS currently ships ffmpeg 8.x,
  so this test is SKIPPED locally when the detected ffmpeg major version is >= 8.
  CI (ubuntu-latest, apt ffmpeg 5.x/6.x) is compatible, so it RUNS there.
  Edge-TTS needs outbound network, which is available in CI.

No MPT_API_KEY is set here, so the API is in fail-open (auth-disabled) mode and
no x-api-key header is needed — this test focuses purely on the render path.
"""

import os
import re
import subprocess
import sys
import time
from pathlib import Path

import pytest

# add project root to python path (mirrors the existing test/ convention)
sys.path.insert(0, str(Path(__file__).parent.parent))


# --- ffmpeg version gate -------------------------------------------------------
def _ffmpeg_major_version():
    """Return the system ffmpeg major version (int), or None if undetectable."""
    try:
        out = subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None
    # e.g. "ffmpeg version 6.1.1 ..." or "ffmpeg version n6.0 ..." or "8.1.1"
    m = re.search(r"ffmpeg version n?(\d+)\.", out)
    return int(m.group(1)) if m else None


_FFMPEG_MAJOR = _ffmpeg_major_version()

_skip_reason = None
if _FFMPEG_MAJOR is None:
    _skip_reason = "ffmpeg not found on PATH; required to synthesize the render input."
elif _FFMPEG_MAJOR >= 8:
    _skip_reason = (
        f"ffmpeg {_FFMPEG_MAJOR}.x detected: MoviePy 2.1.2 reads 0 frames from "
        f"ffmpeg 8.x output, so the render fails on this host. This test runs in "
        f"CI (ubuntu apt ffmpeg 5.x/6.x). Skipping locally."
    )

pytestmark = pytest.mark.skipif(_skip_reason is not None, reason=_skip_reason or "")


def _make_test_mp4(path: str, seconds: int = 1, size: int = 640):
    """Create a tiny solid-color mp4 with the system ffmpeg.

    Must be >= 480x480: preprocess_video rejects anything smaller. We use a
    yuv420p H.264 clip so MoviePy/ffmpeg can read it back cleanly.
    """
    cmd = [
        "ffmpeg",
        "-y",
        "-f", "lavfi",
        "-i", f"color=c=blue:s={size}x{size}:d={seconds}:r=24",
        "-pix_fmt", "yuv420p",
        "-c:v", "libx264",
        path,
    ]
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    assert os.path.exists(path) and os.path.getsize(path) > 0


def _valid_mp4(path: str) -> bool:
    """Use ffprobe to confirm the file has a real video stream and duration."""
    try:
        out = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=codec_type,width,height",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1",
                path,
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False
    if "codec_type=video" not in out:
        return False
    m = re.search(r"duration=([0-9.]+)", out)
    return bool(m) and float(m.group(1)) > 0.0


@pytest.fixture(scope="module")
def client():
    # Import app modules lazily, inside the fixture, so that collecting this file
    # on an ffmpeg-8 host (where pytestmark skips everything) does not pay the
    # cost / side effects of importing the whole app.
    from fastapi.testclient import TestClient

    from app.asgi import app as asgi_app
    from app.config import config

    # This smoke test runs in fail-open (auth-disabled) mode and sends no
    # x-api-key. test_byo.py sets MPT_API_KEY/config.app["api_key"] at *import*
    # time (a load-time singleton) and never clears it, so when both files run
    # in one pytest process that leaked token makes verify_token reject our
    # unauthenticated upload with 401. Force fail-open for this test, restore after.
    _prev_api_key = config.app.get("api_key", "")
    config.app["api_key"] = ""
    try:
        with TestClient(asgi_app) as c:
            yield c
    finally:
        config.app["api_key"] = _prev_api_key


def test_real_render_produces_valid_mp4(client, tmp_path):
    # 1. Synthesize the local material.
    material_path = tmp_path / "material.mp4"
    _make_test_mp4(str(material_path), seconds=1, size=640)
    assert _valid_mp4(str(material_path)), "synthesized input mp4 is not valid"

    # 2. Upload it as a local video material.
    with open(material_path, "rb") as fh:
        up = client.post(
            "/api/v1/video_materials",
            files={"file": ("material.mp4", fh, "video/mp4")},
        )
    assert up.status_code == 200, up.text
    uploaded_name = up.json()["data"]["file"]
    assert uploaded_name

    task_id = None
    try:
        # 3. Kick off a real render with a provided script (LLM is skipped).
        body = {
            "video_subject": "smoke test",
            "video_script": (
                "This is a tiny end to end render smoke test. "
                "It uses a local clip and Edge text to speech."
            ),
            "video_source": "local",
            "video_materials": [
                {"provider": "local", "url": uploaded_name, "duration": 0}
            ],
            "video_aspect": "1:1",
            "video_clip_duration": 1,
            "video_count": 1,
            "voice_name": "en-US-JennyNeural-Female",
            "subtitle_enabled": True,
            "bgm_type": "",
            "video_language": "en",
            "paragraph_number": 1,
        }
        resp = client.post("/api/v1/videos", json=body)
        assert resp.status_code == 200, resp.text
        task_id = resp.json()["data"]["task_id"]
        assert task_id

        # 4. Poll for completion. The render runs in a background thread.
        deadline = time.time() + 240  # generous: Edge-TTS + MoviePy encode
        state = None
        while time.time() < deadline:
            q = client.get(f"/api/v1/tasks/{task_id}")
            assert q.status_code == 200, q.text
            data = q.json().get("data", {})
            state = data.get("state")
            # 1 = COMPLETE, -1 = FAILED, 4 = PROCESSING
            if state in (1, -1):
                break
            time.sleep(2)

        assert state == 1, (
            f"render did not COMPLETE (final state={state}). "
            f"On ffmpeg 8.x MoviePy reads 0 frames — this test is meant to be "
            f"skipped there; in CI it should reach state 1."
        )

        # 5. Download final-1.mp4 and validate it.
        dl = client.get(f"/api/v1/download/{task_id}/final-1.mp4")
        assert dl.status_code == 200, dl.text
        out_path = tmp_path / "final-1.mp4"
        out_path.write_bytes(dl.content)

        assert out_path.stat().st_size > 10 * 1024, (
            f"final mp4 is suspiciously small: {out_path.stat().st_size} bytes"
        )
        assert _valid_mp4(str(out_path)), "downloaded final-1.mp4 is not a valid mp4"

    finally:
        # 6. Clean up the task directory.
        if task_id:
            client.delete(f"/api/v1/tasks/{task_id}")


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))

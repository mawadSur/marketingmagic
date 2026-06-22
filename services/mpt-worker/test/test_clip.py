"""Tests for the user-clip + extract-audio endpoints (Slice C).

These exercise the two new endpoints end-to-end through the FastAPI app WITHOUT
running real ffmpeg or hitting the network: the source download (`requests.get`)
and the ffmpeg invocation (`subprocess.run`) are mocked, and the mock writes the
expected output file so the service's "non-empty output" guard passes. We then
poll the same task-state machine the orchestrator uses and assert the task
lifecycle (PROCESSING -> COMPLETE / FAILED), the emitted file naming
(`<task_id>/<label>.mp4`, `<task_id>/audio.m4a`), and that the cut ffmpeg
command carries the right -ss/-to/-vf flags.

No MPT_API_KEY is configured here, so the API is in fail-open mode and no
x-api-key header is needed (mirrors test_render_smoke).
"""

import os
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import pytest

# add project root to python path (mirrors the existing test/ convention)
sys.path.insert(0, str(Path(__file__).parent.parent))


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    from app.asgi import app as asgi_app
    from app.config import config

    # Force fail-open so an MPT_API_KEY leaked by another test file (load-time
    # singleton) can't 401 our unauthenticated requests. Restore after.
    _prev_api_key = config.app.get("api_key", "")
    config.app["api_key"] = ""
    try:
        with TestClient(asgi_app) as c:
            yield c
    finally:
        config.app["api_key"] = _prev_api_key


def _poll_state(client, task_id, timeout=10):
    deadline = time.time() + timeout
    state = None
    while time.time() < deadline:
        q = client.get(f"/api/v1/tasks/{task_id}")
        assert q.status_code == 200, q.text
        state = q.json().get("data", {}).get("state")
        if state in (1, -1):
            return state, q.json()["data"]
        time.sleep(0.05)
    return state, {}


@contextmanager
def _fake_pipeline(captured_cmds, *, source_ok=True, ffmpeg_ok=True):
    """Patch the network fetch + ffmpeg subprocess for BOTH new services.

    The download mock writes a non-empty source file; the subprocess mock writes
    each ffmpeg output target so the service's emptiness guard is satisfied.
    """

    class _FakeResponse:
        def __init__(self):
            self.status_code = 200

        def raise_for_status(self):
            if not source_ok:
                raise RuntimeError("source fetch failed")

        def iter_content(self, chunk_size=1):
            yield b"\x00" * 1024

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def _fake_get(url, **kwargs):
        return _FakeResponse()

    def _fake_run(command, **kwargs):
        captured_cmds.append(command)

        class _Result:
            returncode = 0 if ffmpeg_ok else 1
            stderr = "" if ffmpeg_ok else "boom"
            stdout = ""

        if ffmpeg_ok:
            # The output path is always the last positional ffmpeg arg.
            out = command[-1]
            with open(out, "wb") as f:
                f.write(b"\x00" * 2048)
        return _Result()

    with patch("app.services.clip.requests.get", _fake_get), patch(
        "app.services.extract_audio.requests.get", _fake_get
    ), patch("app.services.clip.subprocess.run", _fake_run), patch(
        "app.services.extract_audio.subprocess.run", _fake_run
    ), patch(
        "app.services.clip.get_ffmpeg_binary", return_value="ffmpeg"
    ), patch(
        "app.services.extract_audio.get_ffmpeg_binary", return_value="ffmpeg"
    ):
        yield


# --------------------------------------------------------------------------- #
# POST /api/v1/clip
# --------------------------------------------------------------------------- #
def test_clip_produces_labelled_outputs(client):
    cmds = []
    with _fake_pipeline(cmds):
        body = {
            "source_url": "https://signed.example/source.mp4",
            "clips": [
                {"label": "hook", "start_ms": 0, "end_ms": 2000},
                {
                    "label": "punchline",
                    "start_ms": 5000,
                    "end_ms": 8000,
                    "burn_captions": True,
                    "subtitles_srt": "1\n00:00:00,000 --> 00:00:02,000\nhi\n",
                },
            ],
            "aspect": "9:16",
        }
        resp = client.post("/api/v1/clip", json=body)
        assert resp.status_code == 200, resp.text
        task_id = resp.json()["data"]["task_id"]
        assert task_id

        state, data = _poll_state(client, task_id)

    try:
        assert state == 1, f"clip task did not COMPLETE (state={state})"
        videos = data.get("videos", [])
        assert len(videos) == 2
        assert any(v.endswith("hook.mp4") for v in videos)
        assert any(v.endswith("punchline.mp4") for v in videos)

        # ffmpeg ran once per clip with frame-accurate -ss/-to.
        clip_cmds = [c for c in cmds if "-ss" in c]
        assert len(clip_cmds) == 2
        for c in clip_cmds:
            assert "-to" in c
            assert "libx264" in c
        # The captioned clip carries an aspect + subtitles filtergraph.
        vf_cmds = [c[c.index("-vf") + 1] for c in clip_cmds if "-vf" in c]
        assert any("subtitles=" in vf for vf in vf_cmds)
        assert all("scale=1080:1920" in vf for vf in vf_cmds)
    finally:
        client.delete(f"/api/v1/tasks/{task_id}")


def test_clip_marks_failed_when_ffmpeg_errors(client):
    cmds = []
    with _fake_pipeline(cmds, ffmpeg_ok=False):
        body = {
            "source_url": "https://signed.example/source.mp4",
            "clips": [{"label": "hook", "start_ms": 0, "end_ms": 2000}],
        }
        resp = client.post("/api/v1/clip", json=body)
        assert resp.status_code == 200, resp.text
        task_id = resp.json()["data"]["task_id"]
        state, _ = _poll_state(client, task_id)

    try:
        assert state == -1, f"expected FAILED on ffmpeg error, got state={state}"
    finally:
        client.delete(f"/api/v1/tasks/{task_id}")


def test_clip_rejects_empty_clips_list(client):
    resp = client.post(
        "/api/v1/clip",
        json={"source_url": "https://signed.example/source.mp4", "clips": []},
    )
    # Pydantic min_length=1 on clips -> validation error (this app maps
    # RequestValidationError to status 400 via its custom handler).
    assert resp.status_code == 400, resp.text


def test_clip_label_path_traversal_is_neutralized(client):
    cmds = []
    with _fake_pipeline(cmds):
        body = {
            "source_url": "https://signed.example/source.mp4",
            "clips": [{"label": "../../etc/passwd", "start_ms": 0, "end_ms": 1000}],
        }
        resp = client.post("/api/v1/clip", json=body)
        assert resp.status_code == 200, resp.text
        task_id = resp.json()["data"]["task_id"]
        state, data = _poll_state(client, task_id)

    try:
        assert state == 1, f"clip task did not COMPLETE (state={state})"
        videos = data.get("videos", [])
        assert len(videos) == 1
        # The traversal segments are stripped/sanitized: output stays in the
        # task dir and never resolves to an absolute system path.
        out = videos[0]
        assert "/etc/passwd" not in out
        assert out.endswith(".mp4")
        assert ".." not in os.path.basename(out)
    finally:
        client.delete(f"/api/v1/tasks/{task_id}")


# --------------------------------------------------------------------------- #
# POST /api/v1/extract-audio
# --------------------------------------------------------------------------- #
def test_extract_audio_produces_audio_m4a(client):
    cmds = []
    with _fake_pipeline(cmds):
        resp = client.post(
            "/api/v1/extract-audio",
            json={"source_url": "https://signed.example/source.mp4"},
        )
        assert resp.status_code == 200, resp.text
        task_id = resp.json()["data"]["task_id"]
        state, data = _poll_state(client, task_id)

    try:
        assert state == 1, f"extract-audio did not COMPLETE (state={state})"
        audio_file = data.get("audio_file", "")
        assert audio_file.endswith(f"{task_id}/audio.m4a") or audio_file.endswith(
            os.path.join(task_id, "audio.m4a")
        )
        # ffmpeg dropped video and downmixed to mono AAC.
        assert len(cmds) == 1
        assert "-vn" in cmds[0]
        assert "aac" in cmds[0]
    finally:
        client.delete(f"/api/v1/tasks/{task_id}")


def test_extract_audio_marks_failed_on_ffmpeg_error(client):
    cmds = []
    with _fake_pipeline(cmds, ffmpeg_ok=False):
        resp = client.post(
            "/api/v1/extract-audio",
            json={"source_url": "https://signed.example/source.mp4"},
        )
        assert resp.status_code == 200, resp.text
        task_id = resp.json()["data"]["task_id"]
        state, _ = _poll_state(client, task_id)

    try:
        assert state == -1, f"expected FAILED on ffmpeg error, got state={state}"
    finally:
        client.delete(f"/api/v1/tasks/{task_id}")


def test_extract_audio_requires_source_url(client):
    resp = client.post("/api/v1/extract-audio", json={})
    assert resp.status_code == 400, resp.text


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))

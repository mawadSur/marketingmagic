"""Request/response models for the user-clip + extract-audio endpoints.

These back the user-video-upload pipeline (MM migration 068). The clip endpoint
cuts one or more labelled clips out of a user-uploaded source video; the audio
endpoint extracts a compact audio track for Whisper transcription of long
sources. Both take a Supabase signed GET URL (`source_url`) that MPT fetches
itself, and return a `task_id` that drives the SAME tasks/{id} + download/{id}
state machine as the render endpoint.

Validation happens at the boundary here (Pydantic): non-empty source_url, a
non-empty clips list with sane windows (start_ms >= 0, end_ms > 0), and a label
that's safe to use as an output filename stem. The service re-sanitizes the
label defensively too (path-traversal guard).
"""

from typing import List, Optional

from pydantic import BaseModel, Field

from app.models.schema import BaseResponse


class ClipSpec(BaseModel):
    """One clip to cut out of the source. `label` becomes the output filename
    stem (`<task_id>/<label>.mp4`), so it must be filesystem-safe; the service
    re-sanitizes it as a second line of defence."""

    label: str = Field(..., min_length=1, max_length=64)
    start_ms: int = Field(..., ge=0)
    end_ms: int = Field(..., gt=0)
    # When true (and subtitles_srt is present) the captions are burned into the
    # clip at the final output resolution.
    burn_captions: bool = False
    # Pre-sliced SRT (already re-based to this clip's window) — sent only when
    # burn_captions is on.
    subtitles_srt: Optional[str] = None


class ClipRequest(BaseModel):
    # Signed GET URL to the raw source object; MPT downloads it itself.
    source_url: str = Field(..., min_length=1)
    # At least one clip; an empty list is a 400 (min_length=1).
    clips: List[ClipSpec] = Field(..., min_length=1)
    # Optional output aspect ("9:16" | "16:9" | "1:1"). When omitted, keep the
    # source aspect.
    aspect: Optional[str] = None


class ExtractAudioRequest(BaseModel):
    # Signed GET URL to the raw source object; MPT downloads it itself.
    source_url: str = Field(..., min_length=1)


class ClipResponse(BaseResponse):
    class Config:
        json_schema_extra = {
            "example": {
                "status": 200,
                "message": "success",
                "data": {"task_id": "6c85c8cc-a77a-42b9-bc30-947815aa0558"},
            },
        }


class ExtractAudioResponse(BaseResponse):
    class Config:
        json_schema_extra = {
            "example": {
                "status": 200,
                "message": "success",
                "data": {"task_id": "6c85c8cc-a77a-42b9-bc30-947815aa0558"},
            },
        }

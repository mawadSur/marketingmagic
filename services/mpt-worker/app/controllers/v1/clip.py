"""Clip + extract-audio endpoints for the user-video-upload pipeline.

POST /api/v1/clip — cut one or more labelled clips out of a source video.
POST /api/v1/extract-audio — strip a compact audio.m4a for Whisper transcription.

Both mirror the render endpoint's shape: they reuse the shared task queue
manager from app.controllers.v1.video, the shared state store, and the existing
verify_token auth dependency, register a task in PROCESSING, hand the work to the
in-process task manager (background thread), and return a task_id immediately.
The finished outputs surface through the unchanged GET /tasks/{id} +
GET /download/{id}/{file} state machine.
"""

from fastapi import BackgroundTasks, Depends, Request
from loguru import logger

from app.controllers import base
from app.controllers.manager.base_manager import TaskQueueFullError
from app.controllers.v1.base import new_router
from app.controllers.v1.video import task_manager
from app.models.clip import (
    ClipRequest,
    ClipResponse,
    ExtractAudioRequest,
    ExtractAudioResponse,
)
from app.models.exception import HttpException
from app.services import clip as clip_service
from app.services import extract_audio as extract_audio_service
from app.services import state as sm
from app.utils import utils

# Same auth gate as the render endpoints — locked to the orchestrator when an
# MPT_API_KEY is configured (fail-open otherwise, matching the existing routes).
router = new_router(dependencies=[Depends(base.verify_token)])


def _enqueue(request: Request, func, task_kwargs: dict, log_label: str):
    """Shared enqueue path mirroring video.create_task: register task state, hand
    the work to the task manager, return a 200 with the task id. Maps a full
    queue to 429 and a bad request to 400, deleting the half-registered task."""
    task_id = utils.get_uuid()
    request_id = base.get_task_id(request)
    try:
        sm.state.update_task(task_id)
        task_manager.add_task(func, task_id=task_id, **task_kwargs)
        logger.success(f"{log_label} task created: {task_id}")
        return utils.get_response(200, {"task_id": task_id})
    except TaskQueueFullError as e:
        sm.state.delete_task(task_id)
        logger.warning(
            f"reject {log_label} task because queue is full, request_id: {request_id}, "
            f"task_id: {task_id}"
        )
        raise HttpException(
            task_id=task_id, status_code=429, message=f"{request_id}: {str(e)}"
        )
    except ValueError as e:
        sm.state.delete_task(task_id)
        raise HttpException(
            task_id=task_id, status_code=400, message=f"{request_id}: {str(e)}"
        )


@router.post(
    "/clip",
    response_model=ClipResponse,
    summary="Cut labelled clips out of a source video",
)
def create_clip(
    background_tasks: BackgroundTasks, request: Request, body: ClipRequest
):
    clips = [c.model_dump() for c in body.clips]
    return _enqueue(
        request,
        clip_service.start,
        {
            "source_url": body.source_url,
            "clips": clips,
            "aspect": body.aspect,
        },
        log_label="clip",
    )


@router.post(
    "/extract-audio",
    response_model=ExtractAudioResponse,
    summary="Extract a compact audio track for transcription",
)
def create_extract_audio(
    background_tasks: BackgroundTasks, request: Request, body: ExtractAudioRequest
):
    return _enqueue(
        request,
        extract_audio_service.start,
        {"source_url": body.source_url},
        log_label="extract-audio",
    )

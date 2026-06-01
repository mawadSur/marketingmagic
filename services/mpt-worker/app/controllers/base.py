from uuid import uuid4

from fastapi import Request

from app.config import config
from app.models.exception import HttpException


def get_task_id(request: Request):
    task_id = request.headers.get("x-task-id")
    if not task_id:
        task_id = uuid4()
    return str(task_id)


def get_api_key(request: Request):
    api_key = request.headers.get("x-api-key")
    return api_key


def verify_token(request: Request):
    expected = config.app.get("api_key", "")
    # When no token is configured (local/dev), auth is disabled so the default
    # experience still works. Set MPT_API_KEY (or [app] api_key) to lock the API
    # down to the orchestrator only — required for any multi-tenant deployment.
    if not expected:
        return
    token = get_api_key(request)
    if token != expected:
        request_id = get_task_id(request)
        request_url = request.url
        user_agent = request.headers.get("user-agent")
        raise HttpException(
            task_id=request_id,
            status_code=401,
            message=f"invalid token: {request_url}, {user_agent}",
        )

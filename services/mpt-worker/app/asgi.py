"""Application implementation - ASGI."""

import os

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger

from app.config import config
from app.models.exception import HttpException
from app.router import root_api_router
from app.utils import utils


def exception_handler(request: Request, e: HttpException):
    return JSONResponse(
        status_code=e.status_code,
        content=utils.get_response(e.status_code, e.data, e.message),
    )


def validation_exception_handler(request: Request, e: RequestValidationError):
    return JSONResponse(
        status_code=400,
        content=utils.get_response(
            status=400, data=e.errors(), message="field required"
        ),
    )


def get_application() -> FastAPI:
    """Initialize FastAPI application.

    Returns:
       FastAPI: Application object instance.

    """
    instance = FastAPI(
        title=config.project_name,
        description=config.project_description,
        version=config.project_version,
        debug=False,
    )
    instance.include_router(root_api_router)
    instance.add_exception_handler(HttpException, exception_handler)
    instance.add_exception_handler(RequestValidationError, validation_exception_handler)
    return instance


app = get_application()

# Configures the CORS middleware for the FastAPI app
cors_allowed_origins_str = os.getenv("CORS_ALLOWED_ORIGINS", "")
origins = cors_allowed_origins_str.split(",") if cors_allowed_origins_str else ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

task_dir = utils.task_dir()
app.mount(
    "/tasks", StaticFiles(directory=task_dir, html=True, follow_symlink=True), name=""
)

public_dir = utils.public_dir()
app.mount("/", StaticFiles(directory=public_dir, html=True), name="")


@app.on_event("shutdown")
def shutdown_event():
    logger.info("shutdown event")


@app.on_event("startup")
def startup_event():
    logger.info("startup event")
    # TEMP ffmpeg diagnostic — confirms which ffmpeg MoviePy uses and whether it
    # can actually read a clip on this host (renders were failing with "0 frames").
    try:
        import os as _os
        import subprocess as _sp
        import imageio_ffmpeg as _iff

        exe = _iff.get_ffmpeg_exe()
        logger.info(f"[FFDIAG] IMAGEIO_FFMPEG_EXE env={_os.environ.get('IMAGEIO_FFMPEG_EXE')!r}")
        logger.info(f"[FFDIAG] moviepy will use ffmpeg: {exe}")
        try:
            ver = _sp.run([exe, "-version"], capture_output=True, text=True, timeout=20)
            logger.info(f"[FFDIAG] {exe} -version: {ver.stdout.splitlines()[0] if ver.stdout else ver.stderr[:120]}")
        except Exception as _e:
            logger.info(f"[FFDIAG] could not run {exe} -version: {_e}")
        # Generate a 1s clip with THIS ffmpeg, then read it back with MoviePy.
        test_mp4 = "/tmp/ffdiag.mp4"
        gen = _sp.run([exe, "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=1",
                       "-r", "24", "-pix_fmt", "yuv420p", test_mp4],
                      capture_output=True, text=True, timeout=40)
        logger.info(f"[FFDIAG] gen rc={gen.returncode} size={_os.path.getsize(test_mp4) if _os.path.exists(test_mp4) else 'NA'}")
        from moviepy import VideoFileClip as _VFC
        c = _VFC(test_mp4)
        n = getattr(c.reader, "n_frames", getattr(c.reader, "nframes", "?"))
        logger.info(f"[FFDIAG] moviepy read ffdiag.mp4 -> duration={c.duration} fps={c.fps} nframes={n}")
        c.close()
    except Exception as _e:
        logger.exception(f"[FFDIAG] diagnostic failed: {_e}")

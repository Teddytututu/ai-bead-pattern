from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import ValidationError
from .contracts import RegionRequest
from .engine import RegionEngine
from .grid import prepare_context

MAX_BYTES = 25 * 1024 * 1024


def create_app(engine=None):
    runtime = engine or RegionEngine()
    app = FastAPI(title="SDXL region generation (experimental)", version="0.1.0")

    @app.get("/health")
    def health():
        return runtime.health()

    @app.get("/v1/regions/example")
    def example():
        from .fixtures import example_request
        request, _ = example_request()
        return request.model_dump()

    async def parse(request: Request):
        if not request.headers.get("content-type", "").startswith("application/json"):
            raise HTTPException(415, "expected application/json")
        body = bytearray()
        async for part in request.stream():
            body.extend(part)
            if len(body) > MAX_BYTES:
                raise HTTPException(413, "request exceeds 25 MiB")
        try:
            data = RegionRequest.model_validate_json(bytes(body))
        except (ValidationError, ValueError) as error:
            raise HTTPException(422, str(error)) from error
        if await request.is_disconnected():
            raise HTTPException(499, "client disconnected")
        return data

    @app.post("/v1/regions/prepare")
    async def prepare(request: Request):
        return prepare_context(await parse(request))

    @app.post("/v1/regions/generate")
    async def generate(request: Request):
        data = await parse(request)
        try:
            return await run_in_threadpool(runtime.generate, data)
        except BlockingIOError as error:
            raise HTTPException(409, str(error)) from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        except (RuntimeError, OSError) as error:
            raise HTTPException(503, str(error)) from error

    return app


app = create_app()

from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool

from .contracts import (
    MODEL_DESCRIPTOR,
    PROVIDER_ID,
    SCHEMA_VERSION,
    PairRequest,
)
from .engine import OpenClipPairEngine

MAXIMUM_IMAGE_BYTES = 24 * 1024 * 1024


async def _read_image(upload: UploadFile, label: str) -> bytes:
    source = await upload.read(MAXIMUM_IMAGE_BYTES + 1)
    if len(source) == 0 or len(source) > MAXIMUM_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail=f"{label} exceeds the sidecar limit")
    return source


def create_app(engine: OpenClipPairEngine | None = None) -> FastAPI:
    runtime = engine or OpenClipPairEngine()
    app = FastAPI(title="AI Bead OpenCLIP Pair Sidecar", version="0.1.0")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        status, message = await run_in_threadpool(runtime.health)
        return {
            "status": status,
            "model": MODEL_DESCRIPTOR,
            "message": message,
        }

    @app.post("/v1/analyze")
    async def analyze(
        http_request: Request,
        image: UploadFile = File(...),
        reference_image: UploadFile = File(..., alias="referenceImage"),
        request: str = Form(...),
    ) -> dict[str, Any]:
        try:
            payload = json.loads(request)
            pair_request = PairRequest.from_wire(payload)
        except (json.JSONDecodeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        candidate_source = await _read_image(image, "candidate image")
        reference_source = await _read_image(reference_image, "reference image")
        if await http_request.is_disconnected():
            raise HTTPException(status_code=499, detail="client disconnected")
        try:
            score = await run_in_threadpool(
                runtime.score_pair,
                reference_source,
                candidate_source,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return {
            "schemaVersion": SCHEMA_VERSION,
            "providerId": PROVIDER_ID,
            "model": MODEL_DESCRIPTOR,
            "capabilities": list(pair_request.capabilities),
            "confidence": score.confidence,
            "inferenceMs": score.inference_ms,
            "preferenceFeatures": {
                "names": [
                    "semanticRetention",
                    "classDistributionRetention",
                    "petBirdMargin",
                ],
                "values": [
                    score.semantic_retention,
                    score.class_distribution_retention,
                    score.pet_bird_margin,
                ],
                "confidence": score.confidence,
                "scope": "pair",
                "candidateId": pair_request.candidate_id,
            },
            "warnings": [
                f"inferenceMs={score.inference_ms:.1f}",
                f"embeddingCacheHits={score.cache_hits}",
            ],
        }

    return app


app = create_app()

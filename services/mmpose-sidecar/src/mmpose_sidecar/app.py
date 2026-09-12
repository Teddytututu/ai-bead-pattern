from __future__ import annotations

import json
from typing import Protocol

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool

from .contracts import (
    MODEL_DESCRIPTOR,
    MODEL_IDENTITY,
    PROVIDER_ID,
    SCHEMA_VERSION,
    PoseRequest,
)
from .engine import MMPoseEngine, PoseResult
from .landmarks import landmarks_from_ap10k, pose_confidence

MAXIMUM_IMAGE_BYTES = 24 * 1024 * 1024
MAXIMUM_REQUEST_CHARACTERS = 64 * 1024


class Engine(Protocol):
    def health(self) -> tuple[str, str]: ...

    def analyze(self, source: bytes, request: PoseRequest) -> PoseResult: ...


def create_app(engine: Engine | None = None) -> FastAPI:
    runtime = engine or MMPoseEngine()
    app = FastAPI(title="AI Bead Pattern MMPose sidecar", version="0.1.0")

    @app.get("/health")
    async def health() -> dict:
        status, message = await run_in_threadpool(runtime.health)
        return {
            "status": status,
            "message": message,
            "model": MODEL_DESCRIPTOR,
        }

    @app.post("/v1/analyze")
    async def analyze(
        http_request: Request,
        image: UploadFile = File(...),
        request: str = Form(...),
    ) -> dict:
        if len(request) > MAXIMUM_REQUEST_CHARACTERS:
            raise HTTPException(status_code=413, detail="request metadata exceeds the sidecar limit")
        try:
            payload = json.loads(request)
            pose_request = PoseRequest.from_wire(payload)
        except (json.JSONDecodeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        source = await image.read(MAXIMUM_IMAGE_BYTES + 1)
        if len(source) == 0 or len(source) > MAXIMUM_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="uploaded image exceeds the sidecar limit")
        if await http_request.is_disconnected():
            raise HTTPException(status_code=499, detail="client disconnected")
        try:
            result = await run_in_threadpool(runtime.analyze, source, pose_request)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        landmarks = []
        for index, instance in enumerate(pose_request.instances):
            landmarks.extend(landmarks_from_ap10k(
                instance.instance_id,
                result.keypoints[index:index + 1],
                result.scores[index:index + 1],
            ))
        confidence = pose_confidence(result.scores)
        observed_count = sum(
            landmark["observationState"] == "observed" for landmark in landmarks
        )
        inferred_count = sum(
            landmark["observationState"] == "inferred" for landmark in landmarks
        )
        missing_count = sum(
            landmark["observationState"] == "missing" for landmark in landmarks
        )
        provenance = [{
            "origin": "model",
            "provider": PROVIDER_ID,
            "model": MODEL_IDENTITY["modelId"],
            "version": MODEL_IDENTITY["weightRevision"],
        }]
        return {
            "schemaVersion": SCHEMA_VERSION,
            "providerId": PROVIDER_ID,
            "model": MODEL_DESCRIPTOR,
            "capabilities": list(pose_request.capabilities),
            "confidence": confidence,
            "inferenceMs": result.inference_ms,
            "analysis": {
                "landmarks": landmarks,
                "imageType": "pet",
                "confidence": confidence,
                "modelVersions": {
                    "keypoints": MODEL_IDENTITY["weightRevision"],
                },
                "provenance": provenance,
            },
            "warnings": [
                f"instanceCount={len(pose_request.instances)}",
                f"landmarksObserved={observed_count}",
                f"landmarksInferred={inferred_count}",
                f"landmarksMissing={missing_count}",
                f"device={result.device}",
                f"inferenceMs={result.inference_ms:.1f}",
            ],
        }

    return app


app = create_app()

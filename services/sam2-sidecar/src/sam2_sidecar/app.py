from __future__ import annotations

import base64
import json
from hashlib import sha256
from typing import Protocol

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from starlette.concurrency import run_in_threadpool

from .contracts import (
    GROUNDED_MODEL_DESCRIPTOR,
    GROUNDED_MODEL_IDENTITY,
    GROUNDED_PROVIDER_ID,
    MODEL_DESCRIPTOR,
    MODEL_IDENTITY,
    PROVIDER_ID,
    SCHEMA_VERSION,
    SegmentationRequest,
)
from .engine import Sam2SegmentationEngine, SegmentationBatchResult, encode_uncompressed_rle

MAXIMUM_IMAGE_BYTES = 32 * 1024 * 1024
MAXIMUM_REQUEST_CHARACTERS = 64 * 1024


class Engine(Protocol):
    def health(self) -> tuple[str, str]: ...

    def grounded_health(self) -> tuple[str, str]: ...

    def analyze(self, source: bytes, request: SegmentationRequest) -> SegmentationBatchResult: ...


def _mask_payload(mask: np.ndarray) -> dict:
    height, width = mask.shape
    return {
        "width": int(width),
        "height": int(height),
        "rle": encode_uncompressed_rle(mask),
    }


def _importance_payload(importance_map: np.ndarray) -> dict:
    height, width = importance_map.shape
    quantized = (importance_map.clip(0.0, 1.0) * 255.0).round().astype("uint8")
    return {
        "width": int(width),
        "height": int(height),
        "uint8Base64": base64.b64encode(quantized.tobytes(order="C")).decode("ascii"),
    }


def create_app(engine: Engine | None = None) -> FastAPI:
    runtime = engine or Sam2SegmentationEngine()
    app = FastAPI(title="AI Bead Pattern SAM2 sidecar", version="0.1.0")

    @app.get("/health")
    def health() -> dict:
        status, message = runtime.health()
        return {
            "status": status,
            "message": message,
            "model": MODEL_DESCRIPTOR,
        }

    @app.get("/health/grounded")
    def grounded_health() -> dict:
        status, message = runtime.grounded_health()
        return {
            "status": status,
            "message": message,
            "model": GROUNDED_MODEL_DESCRIPTOR,
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
        except json.JSONDecodeError as error:
            raise HTTPException(status_code=400, detail="request metadata must use JSON") from error
        try:
            segmentation_request = SegmentationRequest.from_wire(payload)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        source = await image.read(MAXIMUM_IMAGE_BYTES + 1)
        if len(source) == 0 or len(source) > MAXIMUM_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="uploaded image exceeds the sidecar limit")
        if await http_request.is_disconnected():
            raise HTTPException(status_code=499, detail="client disconnected")
        try:
            result = await run_in_threadpool(runtime.analyze, source, segmentation_request)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        height, width = result.subject_mask.shape
        mask = _mask_payload(result.subject_mask)
        importance = _importance_payload(result.importance_map)
        provider_id = GROUNDED_PROVIDER_ID if segmentation_request.automatic_detection else PROVIDER_ID
        model_identity = (
            GROUNDED_MODEL_IDENTITY
            if segmentation_request.automatic_detection
            else MODEL_IDENTITY
        )
        model_descriptor = (
            GROUNDED_MODEL_DESCRIPTOR
            if segmentation_request.automatic_detection
            else MODEL_DESCRIPTOR
        )
        revision = (
            provider_id
            + ":"
            + model_identity["weightRevision"]
            + ":"
            + sha256(
                source + ",".join(instance.instance_id for instance in result.instances).encode("utf-8")
            ).hexdigest()[:16]
        )
        provenance = ([{
            "origin": "model",
            "provider": GROUNDED_PROVIDER_ID,
            "model": "IDEA-Research/grounding-dino-tiny",
            "version": "hf:a2bb814dd30d776dcf7e30523b00659f4f141c71",
        }, {
            "origin": "model",
            "provider": GROUNDED_PROVIDER_ID,
            "model": "facebook/sam2.1-hiera-small",
            "version": "hf:ee5bba1d82bb8749febdf90f45e84b687142ba03",
        }] if segmentation_request.automatic_detection else [{
            "origin": "model",
            "provider": PROVIDER_ID,
            "model": MODEL_IDENTITY["modelId"],
            "version": MODEL_IDENTITY["weightRevision"],
        }])
        x, y, crop_width, crop_height = result.crop
        primary_index = max(
            range(len(result.instances)),
            key=lambda index: (result.instances[index].confidence, -index),
        )
        proposals = []
        semantic_regions = []
        for index, instance in enumerate(result.instances):
            instance_mask = _mask_payload(instance.mask)
            if instance.detection_box is None:
                box_x, box_y, box_width, box_height = instance.crop
            else:
                left, top, right, bottom = instance.detection_box
                box_x, box_y = left, top
                box_width, box_height = right - left, bottom - top
            proposals.append({
                "id": f"{instance.instance_id}:{revision[-16:]}",
                "instanceId": instance.instance_id,
                **({} if instance.label is None else {"label": instance.label}),
                "bbox": {
                    "x": box_x / width,
                    "y": box_y / height,
                    "width": box_width / width,
                    "height": box_height / height,
                },
                "maskRle": instance_mask["rle"],
                "confidence": instance.confidence,
                **({} if instance.detection_score is None else {
                    "detectionScore": instance.detection_score,
                }),
                "predictedIoU": instance.predicted_iou,
                "stabilityScore": instance.stability_score,
                "promptAgreement": instance.prompt_agreement,
                "selected": index == primary_index,
                "diagnostics": {
                    "promptSource": instance.prompt_source,
                    "positivePointCount": instance.positive_point_count,
                    "negativePointCount": instance.negative_point_count,
                    "maskAreaRatio": instance.mask_area_ratio,
                    "lassoContainment": instance.lasso_containment,
                    "inferenceMs": instance.inference_ms,
                    "device": instance.device,
                },
            })
            semantic_regions.append({
                "id": f"{instance.instance_id}:subject",
                "label": "subject",
                "mask": instance_mask,
                "confidence": instance.confidence,
                "importance": 1.0,
                "provenance": provenance,
            })
        return {
            "schemaVersion": SCHEMA_VERSION,
            "providerId": provider_id,
            "model": model_descriptor,
            "capabilities": list(segmentation_request.capabilities),
            "confidence": result.confidence,
            "inferenceMs": result.inference_ms,
            "analysis": {
                "subjectMask": mask,
                "subjectMaskEvidence": {
                    "mask": mask,
                    "confidence": result.confidence,
                    "source": "ai",
                    "revision": revision,
                    "provenance": provenance,
                },
                **({} if "edge-thin-structure" not in segmentation_request.capabilities else {
                    "importanceMap": importance,
                }),
                "semanticRegions": semantic_regions,
                "suggestedCrop": {
                    "x": x,
                    "y": y,
                    "width": crop_width,
                    "height": crop_height,
                },
                "suggestedCropConfidence": result.confidence,
                "suggestedCropSource": "automatic",
                "imageType": segmentation_request.image_type_hint or "general",
                "confidence": result.confidence,
                "modelVersions": {
                    "subject-segmentation": (
                        f"{model_identity['modelId']}@{model_identity['weightRevision']}"
                    ),
                },
                "provenance": provenance,
            },
            "instanceProposals": proposals,
        }

    return app


app = create_app()

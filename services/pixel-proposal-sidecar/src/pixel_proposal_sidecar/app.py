from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool

from .contracts import MODEL_IDENTITY, PROVIDER_ID, ProposalRequest, SCHEMA_VERSION
from .engine import PixelProposalEngine, encode_raw_rgba

MAXIMUM_IMAGE_BYTES = 24 * 1024 * 1024


def create_app(engine: PixelProposalEngine | None = None) -> FastAPI:
    runtime = engine or PixelProposalEngine()
    app = FastAPI(title="AI Bead Pixel Proposal Sidecar", version="0.1.0")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        status, message = runtime.health()
        return {
            "status": status,
            "model": MODEL_IDENTITY,
            "message": message,
        }

    @app.post("/v1/analyze")
    async def analyze(
        http_request: Request,
        image: UploadFile = File(...),
        request: str = Form(...),
    ) -> dict[str, Any]:
        try:
            payload = json.loads(request)
            proposal_request = ProposalRequest.from_wire(payload)
        except (json.JSONDecodeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        source = await image.read(MAXIMUM_IMAGE_BYTES + 1)
        if len(source) == 0 or len(source) > MAXIMUM_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="uploaded image exceeds the sidecar limit")
        if await http_request.is_disconnected():
            raise HTTPException(status_code=499, detail="client disconnected")
        try:
            proposals, elapsed_ms = await run_in_threadpool(runtime.generate, source, proposal_request)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return {
            "schemaVersion": SCHEMA_VERSION,
            "providerId": PROVIDER_ID,
            "model": MODEL_IDENTITY,
            "capabilities": [proposal_request.kind],
            "confidence": max(proposal.confidence for proposal in proposals),
            "learnedProposals": [{
                "id": proposal.proposal_id,
                "kind": proposal_request.kind,
                "confidence": proposal.confidence,
                "seed": proposal.seed,
                "targetGrid": {
                    "width": proposal_request.target_grid[0],
                    "height": proposal_request.target_grid[1],
                },
                **({} if proposal_request.palette_id is None else {
                    "paletteId": proposal_request.palette_id,
                }),
                **({} if proposal_request.style_id is None else {
                    "styleId": proposal_request.style_id,
                }),
                "sourceFrame": proposal.source_frame.to_wire(),
                "image": {
                    "width": proposal.image.width,
                    "height": proposal.image.height,
                    "rgbaBase64": encode_raw_rgba(proposal.image),
                },
            } for proposal in proposals],
            "warnings": [f"inferenceMs={elapsed_ms:.0f}"],
        }

    return app


app = create_app()

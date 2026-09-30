import unittest
from unittest.mock import patch
from contextlib import nullcontext
from types import SimpleNamespace
import json
from PIL import Image
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sdxl_region_sidecar.contracts import RegionRequest
from sdxl_region_sidecar.fixtures import example_request
from sdxl_region_sidecar.grid import prepare, prepare_context, render_grid, compose, context_indices, choose_skin
from sdxl_region_sidecar.app import create_app
from sdxl_region_sidecar.engine import RegionEngine


def small_request():
    return {"schemaVersion": "region-generation-v3", "task": "harmonize", "harmonyStrength": 0.0, "currentGrid": {
        "width": 3, "height": 2, "paletteId": "test", "paletteVersion": "1",
        "colors": [{"id": "white", "rgb": [255, 255, 255]}, {"id": "black", "rgb": [0, 0, 0]}, {"id": "red", "rgb": [255, 0, 0]}],
        "cells": [0, -1, 0, 1, 0, 0]}, "editMask": [True, True, True, False, False, True],
        "lockedMask": [True, False, False, False, False, False], "prompt": "test", "maximumColors": 3}


class ContractTests(unittest.TestCase):
    def test_rejects_malformed_contracts(self):
        cases = [dict(schemaVersion="region-generation-v2"), dict(editMask=[True]), dict(editMask=[False] * 6),
                 dict(lockedMask=[True] * 6), dict(unknown=True), dict(inputMode="source"),
                 dict(maximumColors=1), dict(steps=2, strength=0.1), dict(editMask=[1] * 6), dict(maxAttempts=4)]
        for change in cases:
            with self.subTest(change=change), self.assertRaises(ValidationError):
                RegionRequest.model_validate({**small_request(), **change})

    def test_rejects_grid_errors(self):
        for field, value in [("width", 65), ("cells", [0]), ("cells", [0, -1, 0, 1, 0, 999])]:
            data = small_request(); data["currentGrid"][field] = value
            with self.subTest(field=field), self.assertRaises(ValidationError):
                RegionRequest.model_validate(data)

    def test_source_cannot_be_silently_ignored(self):
        with self.assertRaises(ValidationError):
            RegionRequest.model_validate({**small_request(), "sourceImage": {"width": 1, "height": 1}})

    def test_locked_hole_and_missing_surroundings_are_rejected(self):
        data = small_request(); data["lockedMask"][1] = True
        with self.assertRaisesRegex(ValidationError, "locked"): RegionRequest.model_validate(data)
        data = small_request(); data.update(editMask=[True] * 6, lockedMask=[False] * 6)
        with self.assertRaisesRegex(ValidationError, "context"): RegionRequest.model_validate(data)


class GridTests(unittest.TestCase):
    def test_skin_prefill_uses_surroundings_or_explicit_material(self):
        request, _ = example_request()
        self.assertEqual(choose_skin(request), 2)
        request.skinColorId = 'diag-4'
        canvas, mask, _ = prepare(request)
        self.assertEqual(canvas.getpixel((160, 208)), (59, 145, 151))
        self.assertEqual(canvas.getpixel((120, 184)), (239, 192, 155))  # Locked corner.
        self.assertEqual(mask.getpixel((120, 184)), 0)

    def test_integer_phase_redaction_and_locks_on_rectangular_grid(self):
        request = RegionRequest.model_validate(small_request())
        canvas, mask, transform = prepare(request)
        self.assertEqual((transform["scale"], transform["x"], transform["y"]), (170, 1, 86))
        self.assertEqual(canvas.getpixel((85, 170)), (255, 255, 255))
        self.assertEqual(mask.getpixel((85, 170)), 0)
        self.assertEqual(canvas.getpixel((425, 170)), (255, 255, 255))
        self.assertEqual(mask.getpixel((425, 170)), 255)
        self.assertEqual(mask.getpixel((0, 0)), 0)

    def test_hidden_target_changes_cannot_leak_into_neural_input(self):
        a = RegionRequest.model_validate(small_request())
        b = a.model_copy(deep=True); b.currentGrid.cells[2] = 2
        self.assertEqual(prepare(a)[0].tobytes(), prepare(b)[0].tobytes())
        self.assertEqual(prepare_context(a)["contextMaterialIds"], prepare_context(b)["contextMaterialIds"])
        self.assertNotEqual(prepare_context(a)["contextSha256"], prepare_context(b)["contextSha256"])

    def test_every_editable_cell_filled_with_exact_outside_and_locks(self):
        request = RegionRequest.model_validate(small_request()); _, _, transform = prepare(request)
        result = compose(request, Image.new("RGB", (512, 512), "red"), transform)
        self.assertEqual(result["grid"]["cells"], [0, 2, 2, 1, 0, 2])
        self.assertEqual(result["diagnostics"]["unfilledCells"], 0)
        self.assertEqual(result["diagnostics"]["newlyOccupiedCells"], 1)
        self.assertEqual([c["index"] for c in result["changedCells"]], [1, 2, 5])
        json.dumps(result)  # No NumPy scalars cross the API.

    def test_budget_and_existing_outside_empty_board(self):
        data = small_request(); data["maximumColors"] = 2; data["currentGrid"]["cells"][4] = -1
        request = RegionRequest.model_validate(data); _, _, transform = prepare(request)
        result = compose(request, Image.new("RGB", (512, 512), "red"), transform)
        self.assertNotIn(2, result["grid"]["cells"])
        self.assertEqual(result["grid"]["cells"][4], -1)
        self.assertGreaterEqual(result["grid"]["cells"][1], 0)

    def test_only_empty_selected_is_actually_filled_including_white_material(self):
        data = small_request(); data["editMask"] = [False, True, False, False, False, False]
        request = RegionRequest.model_validate(data); _, _, transform = prepare(request)
        result = compose(request, Image.new("RGB", (512, 512), "white"), transform)
        self.assertEqual(result["decision"], "candidate")
        self.assertEqual(result["grid"]["cells"][1], 0)

    def test_transparent_output_is_not_a_candidate(self):
        request = RegionRequest.model_validate(small_request()); canvas, _, transform = prepare(request)
        for image in [Image.new("RGBA", (512, 512), (255, 255, 255, 0))]:
            result = compose(request, image, transform)
            self.assertEqual(result["decision"], "rejected")
            self.assertIsNone(result["grid"])

    def test_flat_detail_is_rejected_but_color_fill_can_be_uniform(self):
        request, _ = example_request(); _, _, transform = prepare(request)
        flat = Image.new("RGB", (512, 512), tuple(request.currentGrid.colors[2].rgb))
        self.assertEqual(compose(request, flat, transform)["decision"], "rejected")
        request.task = "harmonize"
        self.assertEqual(compose(request, flat, transform)["decision"], "candidate")

    def test_multiple_components_require_each_detail_to_have_structure(self):
        data = small_request(); data["currentGrid"].update(width=8, height=4, cells=[0] * 32)
        data["editMask"] = [i % 8 in (0, 1, 6, 7) and i // 8 < 2 for i in range(32)]
        data["lockedMask"] = [False] * 32; data["task"] = "detail-repair"
        request = RegionRequest.model_validate(data); canvas, transform = render_grid(request.currentGrid, 512)
        # One component remains uniformly white; the other has one dark cell.
        canvas.paste((0, 0, 0), (0, 128, 64, 192))
        result = compose(request, canvas, transform)
        self.assertEqual(result["decision"], "rejected")
        self.assertGreaterEqual(result["diagnostics"]["flatDetailComponents"], 1)

    def test_context_fingerprint_changes_with_mask_palette_and_prompt(self):
        request = RegionRequest.model_validate(small_request()); expected = prepare_context(request)["contextSha256"]
        for field, value in [("prompt", "new"), ("workingSize", 1024), ("maximumColors", 2)]:
            changed = request.model_copy(update={field: value})
            self.assertNotEqual(prepare_context(changed)["contextSha256"], expected)
        request.editMask[5] = False
        self.assertNotEqual(prepare_context(request)["contextSha256"], expected)

    def test_64_grid_single_cell_fill_preserves_phase(self):
        data = small_request(); data["currentGrid"].update(width=64, height=48, cells=[0] * 3072)
        index = 31 * 64 + 31
        data["currentGrid"]["cells"][index] = -1
        data["editMask"] = [i == index for i in range(3072)]; data["lockedMask"] = [False] * 3072
        request = RegionRequest.model_validate(data); _, _, transform = prepare(request)
        result = compose(request, Image.new("RGB", (512, 512), "black"), transform)
        self.assertEqual(result["changedCells"], [{"index": index, "before": -1, "after": 1}])


class EngineTests(unittest.TestCase):
    def test_generation_requires_current_context_before_model_load(self):
        runtime = RegionEngine(); request = RegionRequest.model_validate(small_request())
        with patch.object(runtime, "load") as load:
            with self.assertRaisesRegex(ValueError, "先确认周边"): runtime.generate(request)
            request.contextSha256 = prepare_context(request)["contextSha256"]
            request.prompt = "changed"
            with self.assertRaisesRegex(ValueError, "先确认周边"): runtime.generate(request)
            load.assert_not_called()

    def test_retry_budget_and_no_candidate_on_failure(self):
        request, _ = example_request()
        request.contextSha256 = prepare_context(request)["contextSha256"]
        seeds = []
        class Generator:
            def __init__(self, **kwargs): pass
            def manual_seed(self, seed): seeds.append(seed); return self
        cuda = SimpleNamespace(reset_peak_memory_stats=lambda: None, max_memory_allocated=lambda: 0,
                               max_memory_reserved=lambda: 0, empty_cache=lambda: None)
        torch = SimpleNamespace(Generator=Generator, cuda=cuda, inference_mode=nullcontext)
        calls = []
        def pipe(**kwargs):
            calls.append(kwargs)
            self.assertEqual(kwargs["image"].getpixel((160, 208)), (239, 192, 155))
            return SimpleNamespace(images=[Image.new("RGB", (512, 512), (239, 192, 155))])
        runtime = RegionEngine()
        with patch.dict("sys.modules", {"torch": torch}), patch.object(runtime, "load", return_value=pipe):
            result = runtime.generate(request)
        self.assertEqual(seeds, [42, 43, 44])
        self.assertEqual(len(result["attempts"]), 3)
        self.assertIsNone(result["grid"])
        self.assertIsNone(result["preview"]["grid"])
        self.assertEqual(result["decision"], "rejected")
        json.dumps(result)


class FakeEngine:
    def health(self): return {"status": "test"}
    def generate(self, request): return {"schemaVersion": request.schemaVersion}


class ApiTests(unittest.TestCase):
    def test_validation_and_prepare(self):
        client = TestClient(create_app(FakeEngine()))
        self.assertEqual(client.get("/health").json()["status"], "test")
        RegionRequest.model_validate(client.get("/v1/regions/example").json())
        context = client.post("/v1/regions/prepare", json=small_request()).json()
        self.assertEqual(context["stage"], "surroundings-ready")
        self.assertEqual(context["fillableCells"], 3)
        self.assertEqual(client.post("/v1/regions/generate", json={}).status_code, 422)
        with patch("sdxl_region_sidecar.app.MAX_BYTES", 8):
            self.assertEqual(client.post("/v1/regions/generate", content=b"x" * 9, headers={"content-type": "application/json"}).status_code, 413)
        self.assertEqual(client.post("/v1/regions/generate", content=b"{}").status_code, 415)

    def test_busy_and_unavailable_preserve_failure(self):
        for error, status in [(BlockingIOError("busy"), 409), (RuntimeError("out of memory"), 503), (ValueError("adapter missing"), 422)]:
            engine = FakeEngine()
            with patch.object(engine, "generate", side_effect=error):
                response = TestClient(create_app(engine)).post("/v1/regions/generate", json=small_request())
                self.assertEqual(response.status_code, status)

    def test_api_cannot_skip_first_stage(self):
        client = TestClient(create_app(RegionEngine()))
        response = client.post("/v1/regions/generate", json=small_request())
        self.assertEqual(response.status_code, 422)
        self.assertIn("先确认周边", response.json()["detail"])


if __name__ == "__main__": unittest.main()

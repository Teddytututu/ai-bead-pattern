"""Full-grid masked context, local material harmonization and complete filling."""
from __future__ import annotations
import base64
import hashlib
import io
import json
import numpy as np
from PIL import Image
from .contracts import Grid, RegionRequest

BOARD = (246, 248, 250)


def grid_image(grid: Grid) -> Image.Image:
    return Image.fromarray(np.array([BOARD if c == -1 else grid.colors[c].rgb for c in grid.cells], dtype=np.uint8).reshape(grid.height, grid.width, 3))


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def png_data(image: Image.Image) -> str:
    buf = io.BytesIO(); image.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def render_grid(grid: Grid, size: int):
    scale = size // max(grid.width, grid.height)
    w, h = grid.width * scale, grid.height * scale
    x, y = (size - w) // 2, (size - h) // 2
    canvas = Image.new("RGB", (size, size), BOARD)
    canvas.paste(grid_image(grid).resize((w, h), Image.Resampling.NEAREST), (x, y))
    return canvas, {"scale": scale, "x": x, "y": y, "width": w, "height": h, "workingSize": size}


def effective_mask(request):
    return np.array([e and not l for e, l in zip(request.editMask, request.lockedMask)], dtype=bool)


def prepare(request: RegionRequest):
    canvas, transform = render_grid(request.currentGrid, request.workingSize)
    mask = Image.new("L", canvas.size, 0)
    small = Image.fromarray(effective_mask(request).reshape(request.currentGrid.height, request.currentGrid.width).astype(np.uint8) * 255)
    mask.paste(small.resize((transform["width"], transform["height"]), Image.Resampling.NEAREST), (transform["x"], transform["y"]))
    # Preserve the requested skin-base initialization. The normal SDXL inpaint
    # branch separately masks this area when encoding masked-image latents.
    skin = choose_skin(request)
    canvas.paste(tuple(request.currentGrid.colors[skin].rgb), (0, 0, canvas.width, canvas.height), mask)
    transform["conditioning"] = "full-grid-with-skin-prefill"
    transform["skinColorId"] = request.currentGrid.colors[skin].id
    return canvas, mask, transform


def context_indices(request):
    g = request.currentGrid; effective = effective_mask(request)
    context = np.array([i for i, c in enumerate(g.cells) if c >= 0 and not effective[i]], dtype=int)
    near = set()
    for i in np.flatnonzero(effective):
        x, y = int(i % g.width), int(i // g.width)
        for yy in range(max(0, y - 2), min(g.height, y + 3)):
            for xx in range(max(0, x - 2), min(g.width, x + 3)):
                j = yy * g.width + xx
                if not effective[j] and g.cells[j] >= 0: near.add(j)
    return context, np.array(sorted(near), dtype=int)


def choose_skin(request):
    if request.skinColorId is not None:
        return next(i for i, color in enumerate(request.currentGrid.colors) if color.id == request.skinColorId)
    context, ring = context_indices(request)
    indices = ring if len(ring) else context
    counts = np.bincount([request.currentGrid.cells[i] for i in indices], minlength=len(request.currentGrid.colors))
    return int(counts.argmax())


def prepare_context(request):
    canvas, mask, transform = prepare(request)
    context, ring = context_indices(request)
    g = request.currentGrid
    # All inputs are frozen: even changing a prompt requires a fresh stage 1.
    fingerprint = digest(request.model_dump(exclude={"contextSha256"}))
    materials = sorted({g.cells[i] for i in context})
    return {"schemaVersion": request.schemaVersion, "stage": "surroundings-ready",
            "contextSha256": fingerprint, "transform": transform,
            "contextMaterialIds": [g.colors[i].id for i in materials], "localContextCells": len(ring),
            "skinColorId": g.colors[choose_skin(request)].id, "skinColorRgb": g.colors[choose_skin(request)].rgb,
            "fillableCells": int(effective_mask(request).sum()),
            "preview": {"input": png_data(canvas), "mask": png_data(mask)}}


def lab(rgb):
    values = np.asarray(rgb, dtype=np.float64) / 255
    linear = np.where(values <= 0.04045, values / 12.92, ((values + 0.055) / 1.055) ** 2.4)
    xyz = linear @ np.array([[.4124564, .3575761, .1804375], [.2126729, .7151522, .0721750], [.0193339, .1191920, .9503041]]).T
    xyz /= np.array([.95047, 1, 1.08883])
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def components(mask, width, height):
    remaining = set(np.flatnonzero(mask).tolist()); groups = []
    while remaining:
        first = min(remaining); remaining.remove(first); group = [first]; stack = [first]
        while stack:
            i = stack.pop(); x, y = i % width, i // width
            neighbors = ([i - 1] if x else []) + ([i + 1] if x + 1 < width else []) + ([i - width] if y else []) + ([i + width] if y + 1 < height else [])
            for j in neighbors:
                if j in remaining: remaining.remove(j); stack.append(j); group.append(j)
        groups.append(group)
    return groups


def compose(request: RegionRequest, generated: Image.Image, transform: dict):
    if generated.size != (request.workingSize, request.workingSize): raise ValueError("generated canvas dimensions changed")
    g = request.currentGrid; before = np.array(g.cells); cells = before.copy()
    effective = effective_mask(request); indices = np.flatnonzero(effective)
    pixels = np.asarray(generated.convert("RGBA")); rgb = pixels[..., :3]
    scale = transform["scale"]; samples = []; alpha_coverage = []
    for i in range(len(cells)):
        x, y = transform["x"] + i % g.width * scale, transform["y"] + i // g.width * scale
        inset = max(1, scale // 4)
        patch = rgb[y + inset:y + scale - inset, x + inset:x + scale - inset]
        samples.append(np.median(patch.reshape(-1, 3), axis=0))
        alpha_coverage.append(bool(np.all(pixels[y:y + scale, x:x + scale, 3] == 255)))
    samples = np.asarray(samples); sample_lab = lab(samples); material_lab = lab([c.rgb for c in g.colors])
    context, ring = context_indices(request)
    tone_context = ring if len(ring) >= 4 else context
    # Correct observed tone drift from visible surrounding cells, never target pixels.
    shift = np.median(material_lab[before[tone_context]] - sample_lab[tone_context], axis=0)
    shift = np.clip(shift, -12, 12) * request.harmonyStrength
    adjusted = sample_lab[indices] + shift
    distances = ((adjusted[:, None] - material_lab[None, :]) ** 2).sum(axis=-1)
    context_colors = sorted(set(before[context].tolist()))
    # A soft, bounded preference for surrounding colors retains contrast rather
    # than averaging the whole patch into skin. Only supplied materials are legal.
    palette_distance = ((material_lab[:, None] - material_lab[context_colors][None, :]) ** 2).sum(axis=-1).min(axis=1)
    distances += request.harmonyStrength * .15 * np.minimum(palette_distance, 2500)[None, :]
    selected = sorted(set(before[before >= 0].tolist()))
    best = distances[:, selected].min(axis=1) if selected else np.full(len(indices), np.inf)
    while len(selected) < min(request.maximumColors, len(g.colors)):
        gains = np.maximum(best[:, None] - distances, 0).sum(axis=0); gains[selected] = -1
        pick = int(gains.argmax())
        if gains[pick] <= 0: break
        selected.append(pick); best = np.minimum(best, distances[:, pick])
    cells[indices] = np.array(selected)[distances[:, selected].argmin(axis=1)]
    changes = [{"index": i, "before": int(a), "after": int(b)} for i, (a, b) in enumerate(zip(before, cells)) if a != b]
    flat = []; unchanged = []
    for group in components(effective, g.width, g.height):
        values = sorted(set(cells[group].tolist()))
        contrast = float(np.sqrt(((material_lab[values][:, None] - material_lab[values][None, :]) ** 2).sum(axis=-1)).max())
        if len(group) >= 4 and (len(values) < 2 or contrast < 12): flat.append(group[0])
        if np.array_equal(before[group], cells[group]): unchanged.append(group[0])
    transparent = sum(not alpha_coverage[i] for i in indices)
    reasons = []
    if transparent: reasons.append("生成图的编辑区含透明或未覆盖像素")
    if not changes: reasons.append("没有产生格级修改，不能作为修复候选")
    if request.task == "detail-repair" and flat: reasons.append("局部仍是单色或低对比色块，没有形成可辨结构")
    if request.task == "detail-repair" and unchanged: reasons.append("存在完全未修复的编辑区域")
    diagnostics = {"outsideChanged": int(sum(a != b and not effective[i] for i, (a, b) in enumerate(zip(before, cells)))),
        "lockedChanged": int(sum(a != b and request.lockedMask[i] for i, (a, b) in enumerate(zip(before, cells)))),
        "unfilledCells": int(np.sum(cells[indices] < 0)), "filledCells": len(indices),
        "newlyOccupiedCells": int(np.sum((before == -1) & (cells >= 0))), "deletedCells": int(np.sum((before >= 0) & (cells == -1))),
        "colorCount": len(set(cells[cells >= 0].tolist())), "transparentCells": transparent,
        "flatDetailComponents": len(flat), "unchangedComponents": len(unchanged)}
    assert diagnostics["outsideChanged"] == diagnostics["lockedChanged"] == diagnostics["unfilledCells"] == diagnostics["deletedCells"] == 0
    result = g.model_dump(); result["cells"] = cells.tolist()
    return {"decision": "rejected" if reasons else "candidate", "grid": None if reasons else result,
        "changedCells": [] if reasons else changes, "diagnostics": diagnostics,
        "validation": {"status": "rejected" if reasons else "passed", "reasons": reasons, "semanticReviewRequired": True},
        "harmony": {"strength": request.harmonyStrength, "contextMaterialIds": [g.colors[i].id for i in context_colors],
                    "localContextCells": len(ring), "labDriftCorrection": shift.round(4).tolist()}}

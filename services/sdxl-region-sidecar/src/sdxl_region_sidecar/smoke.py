import argparse
import base64
from datetime import datetime, timezone
import importlib.metadata
import io
import json
from pathlib import Path
from PIL import Image, ImageDraw
from .contracts import RegionRequest
from .fixtures import example_request
from .grid import grid_image, prepare, prepare_context
from .engine import RegionEngine
from .model import ROOT, MODEL_PATH


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    parser.add_argument("--request", type=Path)
    parser.add_argument("--mode", choices=["grid-context"], default="grid-context")
    parser.add_argument("--working-size", type=int, choices=[512,768,1024], default=512)
    parser.add_argument("--steps", type=int, default=20)
    parser.add_argument("--adapter", choices=["none", "configured"], default="none")
    parser.add_argument("--fixtures-only", action="store_true")
    args=parser.parse_args()
    target=args.output or ROOT / "output/diagnostics" / ("sdxl-region-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    target.mkdir(parents=True, exist_ok=False)
    if args.request:
        request=RegionRequest.model_validate_json(args.request.read_bytes())
    else:
        request,clean=example_request(args.mode,args.working_size)
        request=RegionRequest.model_validate({**request.model_dump(),"steps":args.steps,"adapter":args.adapter})
        clean.save(target/"synthetic-clean.png")
    context=prepare_context(request)
    request=request.model_copy(update={"contextSha256":context["contextSha256"]})
    (target/"context.json").write_text(json.dumps(context,indent=2),encoding="utf-8")
    (target/"request.json").write_text(request.model_dump_json(indent=2),encoding="utf-8")
    canvas,mask,transform=prepare(request)
    canvas.save(target/"input.png")
    mask.save(target/"mask.png")
    if args.fixtures_only:
        print(str(target),flush=True)
        return
    runtime=RegionEngine()
    try:
        result=runtime.generate(request)
        (target/"result.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
        generated=Image.open(io.BytesIO(base64.b64decode(result["preview"]["generated"].split(",",1)[1])))
        generated.save(target/"generated.png")
        after=Image.open(io.BytesIO(base64.b64decode(result["preview"]["grid"].split(",",1)[1]))) if result["grid"] else grid_image(request.currentGrid)
        after.save(target/("after-grid.png" if result["grid"] else "unchanged-original.png"))
        board=Image.new("RGB",(1024,1080),"white")
        draw=ImageDraw.Draw(board)
        for image,x,y,label in [(canvas,0,28,"FULL INPUT"),(mask.convert("RGB"),512,28,"EDIT MASK (LOCKS REMOVED)"),
                                  (generated,0,568,"RAW SDXL"),(after,512,568,"MATERIAL GRID; OUTSIDE COPIED" if result["grid"] else "REJECTED; ORIGINAL UNCHANGED")]:
            draw.text((x+10,y-20),label,fill="black")
            board.paste(image.resize((512,512),Image.Resampling.NEAREST),(x,y))
        board.save(target/"comparison.png")
        report={"status":"passed-runtime-not-quality", "decision":result["decision"], "validation":result["validation"], "attempts":len(result["attempts"]), "fixture": "provided-request" if args.request else "original-procedural-not-human-gold",
                "metrics":result["metrics"],"diagnostics":result["diagnostics"],"changedCells":len(result["changedCells"]),
                "inputMode":request.inputMode,"modelCache":str(MODEL_PATH),
                "versions":{p:importlib.metadata.version(p) for p in ["torch","diffusers","peft","transformers","accelerate"]}}
        (target/"report.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
        print(json.dumps({"output":str(target),**report}),flush=True)
    except Exception as error:
        (target/"failure.json").write_text(json.dumps({"type":type(error).__name__,"message":str(error)},indent=2),encoding="utf-8")
        raise


if __name__=="__main__":
    main()

"""Original procedural diagnostic artwork, not human-reviewed training truth."""
import base64
import numpy as np
from PIL import Image, ImageDraw
from .contracts import RegionRequest
from .grid import grid_image


def example_request(mode="grid-context", size=512):
    colors = [(246,248,250), (39,49,64), (239,192,155), (255,251,216), (59,145,151), (136,71,91)]
    img = Image.new("RGB", (32,32), colors[0])
    draw = ImageDraw.Draw(img)
    draw.rectangle((6,5,25,24), fill=colors[1])
    draw.rectangle((9,4,22,26), fill=colors[1])
    draw.rectangle((7,10,24,22), fill=colors[2])
    draw.rectangle((10,23,21,26), fill=colors[2])
    for x in (8,19):
        draw.rectangle((x,12,x+4,15), fill=colors[1])
        draw.point((x+1,13), fill=colors[3])
        draw.line((x+2,13,x+2,14), fill=colors[4])
    draw.point((16,18), fill=colors[5])
    draw.line((13,22,18,22), fill=colors[5])
    clean = list(img.getdata())
    cells = [colors.index(rgb) for rgb in clean]
    for y in range(12,16):
        for x in range(8,13):
            cells[y*32+x] = -1
    data = {"schemaVersion":"region-generation-v3",
            "currentGrid":{"width":32,"height":32,"paletteId":"original-diagnostic-six",
                           "paletteVersion":"1", "colors":[{"id":f"diag-{i}","rgb":list(c)} for i,c in enumerate(colors)],"cells":cells},
            "editMask":[7 <= i%32 <= 13 and 11 <= i//32 <= 16 for i in range(1024)],
            "lockedMask":[i == 11*32+7 for i in range(1024)], "inputMode":mode,
            "workingSize":size,"maximumColors":6,"seed":42,"steps":20,"strength":0.99,"guidanceScale":8.0,
            "prompt":"A flat pixel art face with two matching open eyes. Fill the missing eye on the left side of the image with a dark outline, turquoise iris and one tiny pale highlight, matching the existing right eye. Preserve the surrounding skin tone and expression."}
    return RegionRequest.model_validate(data), img

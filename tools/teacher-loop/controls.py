"""Precompute coarse edges with the existing SAM2 environment (contains OpenCV)."""
import cv2,json,pathlib
import numpy as np
from PIL import Image,ImageOps
from store import DATA,ROOT,atomic,digest,items
directory=ROOT/'.tools/teacher-loop-artifacts/controls';directory.mkdir(parents=True,exist_ok=True)
entries={}
for item in items().values():
    image=ImageOps.pad(Image.open(DATA/'dataset-v1'/item['path']).convert('RGB'),(512,512),color='white')
    pixels=cv2.GaussianBlur(np.asarray(image),(5,5),1.3)
    edges=cv2.Canny(pixels,100,200)
    path=directory/(item['id']+'.png')
    Image.fromarray(edges).convert('RGB').resize((1024,1024),Image.Resampling.NEAREST).save(path)
    entries[item['id']]=dict(path=str(path),sha256=digest(path),source_sha256=item['sha256'])
atomic(DATA/'controls.json',dict(transform='white letterbox 512; GaussianBlur(5,5),1.3; Canny(100,200); nearest 1024',items=entries))
print('Prepared',len(entries),'edge controls')

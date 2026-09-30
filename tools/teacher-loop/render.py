"""User outputs are always square without distorting image proportions."""
from PIL import Image,ImageOps
def square_output(image,size=256):
    if size<1: raise ValueError('Invalid output size')
    return ImageOps.pad(image.convert('RGB'),(size,size),method=Image.Resampling.LANCZOS,color='white',centering=(0.5,0.5))

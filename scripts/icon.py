# Draws the extension's icon: a short abbreviation unfolding into a tag. 128x128 PNG (drawn at 4x).
from PIL import Image, ImageDraw, ImageFont
import sys

S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=112, fill=(17, 24, 39, 255))
mono = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
small = ImageFont.truetype(mono, 74)
big = ImageFont.truetype(mono, 132)
# the abbreviation, typed
d.text((S / 2, 150), "crd>hdr", font=small, fill=(148, 163, 184, 255), anchor="mm")
# what it becomes
d.polygon([(S / 2 - 26, 222), (S / 2 + 26, 222), (S / 2, 252)], fill=(56, 189, 248, 255))
d.text((S / 2, 352), "</>", font=big, fill=(56, 189, 248, 255), anchor="mm")
img.resize((128, 128), Image.LANCZOS).save(sys.argv[1])

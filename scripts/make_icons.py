# Draws the app icons (run by the GitHub Action; only writes icons that are missing).
import math, os, random
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
SIZES = {'apple-touch-icon.png': 180, 'icon-192.png': 192, 'icon-512.png': 512, 'favicon-32.png': 32}
os.makedirs(OUT, exist_ok=True)
if all(os.path.exists(os.path.join(OUT, n)) for n in SIZES):
    raise SystemExit(0)

S = 1024
img = Image.new('RGB', (S, S)); d = ImageDraw.Draw(img)
for y in range(S):  # night-blue sky
    t = y / S
    d.line([(0, y), (S, y)], fill=(int(10 + 18 * t), int(22 + 36 * t), int(38 + 56 * t)))
d.polygon([(0, 700), (170, 560), (300, 640), (470, 470), (640, 620), (800, 520), (1024, 650), (1024, 1024), (0, 1024)], fill=(52, 82, 120))
d.polygon([(80, 1024), (512, 300), (944, 1024)], fill=(232, 241, 250))
d.polygon([(512, 300), (944, 1024), (640, 1024), (560, 620)], fill=(178, 203, 228))
d.polygon([(0, 860), (1024, 860), (1024, 1024), (0, 1024)], fill=(20, 52, 46))
for i in range(14):
    x = 40 + i * 72 + random.Random(i).randint(-10, 10); h = 110 + random.Random(i + 50).randint(0, 60)
    d.polygon([(x - 34, 880), (x, 880 - h), (x + 34, 880)], fill=(24, 64, 56))
d.rectangle([0, 930, S, S], fill=(238, 245, 252))
cx, cy, r, w = 250, 230, 105, 22
for k in range(6):  # snowflake
    a = math.pi / 3 * k
    d.line([(cx, cy), (cx + r * math.cos(a), cy + r * math.sin(a))], fill='white', width=w)
    bx, by = cx + r * .55 * math.cos(a), cy + r * .55 * math.sin(a)
    for s in (-1, 1):
        b = a + s * math.pi / 4
        d.line([(bx, by), (bx + r * .28 * math.cos(b), by + r * .28 * math.sin(b))], fill='white', width=w)
rnd = random.Random(7)
for _ in range(38):
    x, y, rr = rnd.randint(30, 994), rnd.randint(30, 560), rnd.randint(5, 13)
    if (x - 250) ** 2 + (y - 230) ** 2 < 160 ** 2: continue
    d.ellipse([x - rr, y - rr, x + rr, y + rr], fill='white')
for name, size in SIZES.items():
    path = os.path.join(OUT, name)
    if not os.path.exists(path):
        img.resize((size, size), Image.LANCZOS).quantize(colors=48).save(path, optimize=True)
        print('wrote', path)

# make-icons.py — generate the toolbar/store icons (16/32/48/128) for OmniRoute Bridge.
# A routing-hub glyph (center node + 3 spokes) on an accent gradient rounded square.
# Rendered at 4x then downscaled for clean anti-aliasing. Re-run after changing the accent.
#   python make-icons.py [ACCENT_TOP ACCENT_BOTTOM]   # hex like 5b8cff 2b5fe0
import sys, math, os
from PIL import Image, ImageDraw

ACC_TOP = sys.argv[1] if len(sys.argv) > 1 else "5b8cff"
ACC_BOT = sys.argv[2] if len(sys.argv) > 2 else "2b5fe0"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT, exist_ok=True)

def hx(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

TOP, BOT = hx(ACC_TOP), hx(ACC_BOT)

def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m

def gradient(size):
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        t = y / (size - 1)
        # diagonal-ish blend
        r = int(TOP[0] + (BOT[0] - TOP[0]) * t)
        gg = int(TOP[1] + (BOT[1] - TOP[1]) * t)
        b = int(TOP[2] + (BOT[2] - TOP[2]) * t)
        for x in range(size):
            px[x, y] = (r, gg, b)
    return g

def render(size):
    S = size * 4  # supersample
    base = gradient(S)
    base.putalpha(rounded_mask(S, int(S * 0.24)))
    d = ImageDraw.Draw(base)
    cx, cy = S * 0.5, S * 0.5
    R = S * 0.27          # spoke length
    node = S * 0.085      # outer node radius
    hub = S * 0.11        # center hub radius
    lw = int(S * 0.055)   # spoke width
    white = (255, 255, 255, 255)
    # 3 outer nodes: top, bottom-left, bottom-right
    angles = [-90, 150, 30]
    pts = [(cx + R * math.cos(math.radians(a)), cy + R * math.sin(math.radians(a))) for a in angles]
    for (x, y) in pts:
        d.line([cx, cy, x, y], fill=(255, 255, 255, 235), width=lw)
    for (x, y) in pts:
        d.ellipse([x - node, y - node, x + node, y + node], fill=white)
    d.ellipse([cx - hub, cy - hub, cx + hub, cy + hub], fill=white)
    return base.resize((size, size), Image.LANCZOS)

for s in (16, 32, 48, 128):
    render(s).save(os.path.join(OUT, f"icon{s}.png"))
print("icons written to", OUT, "accent", ACC_TOP, "→", ACC_BOT)

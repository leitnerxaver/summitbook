"""Finding the best part of each Strava photo, so the cards show that part instead of the middle.

The website crops photos to 4:3. For each photo we look for the 4:3 window with the most detail
(people, summit crosses, ridges) rather than empty sky, and remember where it is ("focus")."""

import io
import os
import time
from urllib.request import Request, urlopen

ASPECT = 4 / 3  # how the website shows photos


def add_focus(store: dict) -> None:
    photos = [p for r in store["activities"].values() for p in r.get("photos") or [] if "focus" not in p]
    if not photos:
        return
    print(f"Finding the best part of {len(photos)} photos…", flush=True)
    deadline = time.time() + 60 * float(os.environ.get("SUMMITBOOK_PHOTO_MINUTES", 10))
    for photo in photos:
        if time.time() > deadline:
            break
        try:
            with urlopen(Request(photo["thumb"], headers={"User-Agent": "summitbook"}), timeout=30) as res:
                photo["focus"] = focus(res.read())
        except Exception:
            photo["focus"] = [50, 50]  # can't load it: keep the middle


def focus(data: bytes) -> list[int]:
    """Where to put the 4:3 crop, as CSS object-position percentages [x, y]."""
    from PIL import Image, ImageFilter  # (Pillow)

    image = Image.open(io.BytesIO(data)).convert("RGB")
    image.thumbnail((48, 48))
    width, height = image.size
    wide = width / height > ASPECT
    length, size = (width, round(height * ASPECT)) if wide else (height, round(width / ASPECT))
    if length - size < 2:
        return [50, 50]

    # What catches the eye: big shapes (not fine rock texture) and colors that stand out
    # from the rest of the picture (a red cross, jackets), more than plain sky or ground.
    edges = image.convert("L").filter(ImageFilter.GaussianBlur(1)).filter(ImageFilter.FIND_EDGES).load()
    rgb = image.load()
    pixels = [rgb[x, y] for y in range(height) for x in range(width)]
    mean = [sum(c[i] for c in pixels) / len(pixels) for i in range(3)]
    interest = [[edges[x, y] / 255 + sum((rgb[x, y][i] - mean[i]) ** 2 for i in range(3)) ** 0.5 / 220
                 for x in range(width)] for y in range(height)]
    lines = [sum(interest[y][x] for y in range(height)) for x in range(width)] if wide \
        else [sum(row) for row in interest]

    # Prefer the middle (on tall photos a bit above it, where summit photos have their subject).
    ideal = 0.5 if wide else 0.4
    best, best_score = 0, -1.0
    for start in range(length - size + 1):
        where = start / (length - size)
        score = sum(lines[start:start + size]) * (1 - 1.6 * (where - ideal) ** 2)
        if score > best_score:
            best, best_score = start, score
    position = round(100 * best / (length - size))
    return [position, 50] if wide else [50, position]

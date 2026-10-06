"""Geometry: shrinking GPS tracks and finding the summits a track reached."""

import math
from collections import defaultdict

M_PER_DEG = 111_320


class _Projection:
    """Turns lat/lon into meters on a flat plane, accurate enough for one tour."""

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = math.cos(math.radians(lat0)) * M_PER_DEG

    def __call__(self, lat: float, lon: float) -> tuple[float, float]:
        return (lon - self.lon0) * self.kx, (lat - self.lat0) * M_PER_DEG


def simplify(track: list[list], tolerance_m: float = 5.0) -> list[list]:
    """Drops points that lie within tolerance_m of the line between their neighbours
    (Douglas-Peucker in 3D, so summits and turning points are always kept)."""
    if len(track) < 3:
        return track
    proj = _Projection(track[0][0], track[0][1])
    pts = [(*proj(lat, lon), ele or 0.0) for lat, lon, ele in track]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    limit = tolerance_m**2
    while stack:
        a, b = stack.pop()
        (ax, ay, az), (bx, by, bz) = pts[a], pts[b]
        dx, dy, dz = bx - ax, by - ay, bz - az
        length2 = dx * dx + dy * dy + dz * dz
        worst, worst_i = limit, None
        for i in range(a + 1, b):
            px, py, pz = pts[i]
            t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / length2))
            d2 = (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2 + (az + t * dz - pz) ** 2
            if d2 > worst:
                worst, worst_i = d2, i
        if worst_i is not None:
            keep[worst_i] = True
            stack += [(a, worst_i), (worst_i, b)]
    return [[round(lat, 6), round(lon, 6), None if ele is None else round(ele, 1)]
            for (lat, lon, ele), k in zip(track, keep) if k]


def bounds(track: list[list], pad_m: float = 0) -> tuple[float, float, float, float]:
    lats = [p[0] for p in track]
    lons = [p[1] for p in track]
    pad_lat = pad_m / M_PER_DEG
    pad_lon = pad_m / (M_PER_DEG * math.cos(math.radians(lats[0])))
    return min(lats) - pad_lat, min(lons) - pad_lon, max(lats) + pad_lat, max(lons) + pad_lon


def high_point(track: list[list]) -> list | None:
    with_ele = [p for p in track if p[2] is not None]
    return max(with_ele, key=lambda p: p[2]) if with_ele else None


def find_summits(track: list[list], peaks: list[dict], radius_m: float, altitude_tolerance_m: float) -> list[dict]:
    """Named peaks the track came within radius_m of, in the order they were reached.
    If both heights are known, the track also has to get within altitude_tolerance_m of the
    peak's height there, so passing below a summit on a steep slope doesn't count."""
    if len(track) < 2 or not peaks:
        return []
    proj = _Projection(track[0][0], track[0][1])
    pts = [proj(lat, lon) for lat, lon, _ in track]

    # Index each track segment by the grid cells it touches, so each peak only checks nearby segments.
    cell = max(radius_m, 1.0)
    grid = defaultdict(list)
    for i in range(len(pts) - 1):
        (x1, y1), (x2, y2) = pts[i], pts[i + 1]
        for cx in range(math.floor(min(x1, x2) / cell), math.floor(max(x1, x2) / cell) + 1):
            for cy in range(math.floor(min(y1, y2) / cell), math.floor(max(y1, y2) / cell) + 1):
                grid[cx, cy].append(i)

    reached = []
    for peak in peaks:
        if not peak.get("name"):
            continue
        px, py = proj(peak["lat"], peak["lon"])
        cx, cy = math.floor(px / cell), math.floor(py / cell)
        segments = {i for dx in (-1, 0, 1) for dy in (-1, 0, 1) for i in grid.get((cx + dx, cy + dy), ())}
        first, top = None, None
        for i in sorted(segments):
            (x1, y1), (x2, y2) = pts[i], pts[i + 1]
            dx, dy = x2 - x1, y2 - y1
            length2 = dx * dx + dy * dy
            t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / length2))
            if (x1 + t * dx - px) ** 2 + (y1 + t * dy - py) ** 2 > radius_m**2:
                continue
            first = i if first is None else first
            e1, e2 = track[i][2], track[i + 1][2]
            if e1 is None or e2 is None:
                continue
            # Highest altitude near the peak: the closest point, plus segment ends that are also close.
            candidates = [e1 + t * (e2 - e1)]
            candidates += [e for (x, y), e in ((pts[i], e1), (pts[i + 1], e2)) if (x - px) ** 2 + (y - py) ** 2 <= radius_m**2]
            top = max(candidates) if top is None else max(top, *candidates)
        if first is None:
            continue
        if top is not None:
            if peak.get("ele") is not None:
                if top < peak["ele"] - altitude_tolerance_m:
                    continue
            elif top < _highest_nearby(track, pts, px, py, 400) - 15:
                continue  # height unknown: only count it if you were on top, not walking past a knoll
        reached.append((first, peak))

    reached.sort(key=lambda r: r[0])
    return [{k: p[k] for k in ("id", "name", "ele", "lat", "lon")} for _, p in reached]


def _highest_nearby(track: list[list], pts: list[tuple], px: float, py: float, radius_m: float) -> float:
    near = [p[2] for p, (x, y) in zip(track, pts) if p[2] is not None and (x - px) ** 2 + (y - py) ** 2 <= radius_m**2]
    return max(near, default=float("-inf"))

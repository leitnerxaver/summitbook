"""Mountain peaks, huts and towns from OpenStreetMap (via the free Overpass service), cached on disk."""

import json
import math
import re
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .config import CACHE_DIR

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "summitbook/0.1 (personal summit log)"
TILE_DEG = 0.25  # downloaded and cached in 0.25° x 0.25° squares (~28 x 19 km)


class PeakLookupError(Exception):
    pass


_failures_in_a_row = 0  # after a few, the server is down: stop asking for the rest of this run
deadline = float("inf")  # time.time() after which no more downloads are started (set by the caller)


def peaks_in(south: float, west: float, north: float, east: float) -> list[dict]:
    return _places_in("peaks", south, west, north, east)


def huts_in(south: float, west: float, north: float, east: float) -> list[dict]:
    return _places_in("huts", south, west, north, east)


def towns_in(south: float, west: float, north: float, east: float) -> list[dict]:
    return _places_in("towns", south, west, north, east)


def _places_in(kind: str, south: float, west: float, north: float, east: float) -> list[dict]:
    found = {}
    for ty in range(math.floor(south / TILE_DEG), math.floor(north / TILE_DEG) + 1):
        for tx in range(math.floor(west / TILE_DEG), math.floor(east / TILE_DEG) + 1):
            for place in _tile(ty, tx, kind)[kind]:
                if south <= place["lat"] <= north and west <= place["lon"] <= east:
                    found[place["id"]] = place
    return list(found.values())


def _tile(ty: int, tx: int, kind: str) -> dict:
    cached = CACHE_DIR / "osm" / f"{ty}_{tx}.json"
    if cached.exists():
        tile = json.loads(cached.read_text())
        if kind in tile:  # tiles saved by older versions may lack towns: download those again
            return tile
    s, w = ty * TILE_DEG, tx * TILE_DEG
    box = f"({s:.4f},{w:.4f},{s + TILE_DEG:.4f},{w + TILE_DEG:.4f})"
    query = (
        "[out:json][timeout:25];"
        f'(node["natural"~"^(peak|volcano)$"]{box};nwr["tourism"~"^(alpine_hut|wilderness_hut)$"]{box};'
        f'node["place"~"^(city|town|village)$"]{box};);'
        "out center;"
    )
    tile = {"peaks": [], "huts": [], "towns": []}
    for el in _overpass(query)["elements"]:
        tags = el.get("tags", {})
        lat, lon = (el["lat"], el["lon"]) if "lat" in el else (el["center"]["lat"], el["center"]["lon"])
        group = "peaks" if "natural" in tags else "huts" if "tourism" in tags else "towns"
        tile[group].append({"id": el["id"], "name": readable_name(tags), "ele": parse_ele(tags.get("ele")), "lat": lat, "lon": lon})
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(tile, ensure_ascii=False))
    return tile


def _overpass(query: str) -> dict:
    # The free server is often busy and answers "504"; trying again a little later usually works.
    global _failures_in_a_row
    if _failures_in_a_row >= 3 or time.time() > deadline:
        raise PeakLookupError("OpenStreetMap is not reachable right now")
    problem = ""
    for attempt in range(10):
        if time.time() > deadline:
            break
        req = Request(OVERPASS_URL, data=urlencode({"data": query}).encode(), headers={"User-Agent": USER_AGENT})
        try:
            with urlopen(req, timeout=45) as res:
                data = json.load(res)
            time.sleep(1)  # be polite to the free service
            _failures_in_a_row = 0
            return data
        except HTTPError as err:
            problem = f"HTTP {err.code}"
        except (OSError, ValueError) as err:
            problem = str(err)
        time.sleep(min(5 * (attempt + 1), 45))
    _failures_in_a_row += 1
    raise PeakLookupError(f"Could not reach OpenStreetMap ({problem})")


def readable_name(tags: dict) -> str | None:
    """The local name, unless it's in another script or two languages ("Mont Blanc / Monte
    Bianco"): then the German or English name, if there is one."""
    name = tags.get("name")
    if name and not needs_translation(name):
        return name
    return tags.get("name:de") or tags.get("name:en") or name


def needs_translation(name: str) -> bool:
    latin = all(ord(c) < 0x250 or not c.isalpha() for c in name)
    return not latin or " / " in name or " - " in name


def parse_ele(value: str | None) -> float | None:
    """OSM heights look like '3657', '3657 m' or '2345,5'."""
    if not value:
        return None
    match = re.match(r"\s*(-?\d+(?:[.,]\d+)?)", value)
    return float(match.group(1).replace(",", ".")) if match else None

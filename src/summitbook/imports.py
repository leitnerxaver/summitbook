"""Tours from GPX and FIT files (e.g. exported from the Suunto app), put into the imports/ folder.

Put each file into a folder named after the kind of tour, e.g. imports/ski-tour/Habicht.gpx.
The file name becomes the tour's name, unless it looks automatic (e.g. contains a date).
The files themselves stay on your computer; the tours are saved in data/imports.json."""

import hashlib
import json
import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime, timedelta

import fitdecode

from . import geo, trips
from .config import IMPORTS_DIR, ROOT, Config
from .sync import TRACKS_DIR

FOLDER_TYPES = {
    "ski-tour": "BackcountrySki",
    "hike": "Hike",
    "snowshoe": "Snowshoe",
    "climb": "RockClimbing",
    "bike": "Ride",
    "mtb": "MountainBikeRide",
    "gravel": "GravelRide",
    "e-bike": "EBikeRide",
}
# Used when the file has no name of its own; these count as automatic titles.
DEFAULT_NAMES = {
    "BackcountrySki": "Ski tour",
    "Hike": "Hike",
    "Snowshoe": "Snowshoeing",
    "RockClimbing": "Climbing",
    "Ride": "Ride",
    "MountainBikeRide": "Mountain biking",
    "GravelRide": "Gravel ride",
    "EBikeRide": "E-bike ride",
    "EMountainBikeRide": "E-MTB ride",
}
HIDE_NEAR_HOME_M = 500  # files have no Strava privacy zones: hide this much of a track around home
SEMICIRCLES = 180 / 2**31  # FIT stores positions in "semicircles"


def import_files(cfg: Config, store: dict) -> None:
    if not IMPORTS_DIR.exists():
        return  # e.g. on GitHub: imported tours are already saved in data/
    records = store["activities"]
    strava_starts = [_time(r["start_date"]) for r in records.values() if r.get("source") != "file" and r.get("start_date")]
    seen, added, problems = set(), 0, []

    for path in sorted(p for p in IMPORTS_DIR.rglob("*") if p.suffix.lower() in (".gpx", ".fit")):
        where = path.relative_to(ROOT).as_posix()
        activity_id = "f" + hashlib.sha1(path.read_bytes()).hexdigest()[:12]
        folder_type = FOLDER_TYPES.get(path.parent.name.lower())
        rec = records.get(activity_id)
        if rec is None:
            try:
                tour = _read_fit(path) if path.suffix.lower() == ".fit" else _read_gpx(path)
            except Exception as err:  # a broken or unusual file shouldn't stop the update
                problems.append(f"{where}: can't read it ({err})")
                continue
            kind = folder_type or tour["type"]
            if not kind:
                problems.append(f"{where}: unknown kind of tour, put it into a folder like imports/ski-tour/")
                continue
            if kind not in cfg.types:
                problems.append(f"{where}: a {kind} isn't part of the summit book")
                continue
            if len(tour["points"]) < 2 or tour["points"][0][3] is None:
                problems.append(f"{where}: no GPS track with times in it")
                continue
            start = tour["points"][0][3]
            if any(abs((start - s).total_seconds()) < 600 for s in strava_starts):
                problems.append(f"{where}: already on Strava, skipped")
                continue
            rec = _record(activity_id, tour, kind, cfg)
            if rec is None:
                problems.append(f"{where}: too short")
                continue
            records[activity_id] = rec
            added += 1
        # Renaming or moving a file only changes the tour's name and kind.
        kind = folder_type or rec["type_in_file"] or rec["sport_type"]
        if kind not in cfg.types:
            problems.append(f"{where}: a {kind} isn't part of the summit book")
            continue  # (its tour is removed below)
        rec["file"] = where
        rec["sport_type"] = kind
        rec["name"] = _name(path.stem, rec.get("name_in_file"), rec["sport_type"])
        seen.add(activity_id)

    for gone in [k for k, r in records.items() if r.get("source") == "file" and k not in seen]:
        del records[gone]  # the file was deleted
        (TRACKS_DIR / f"{gone}.json").unlink(missing_ok=True)

    if added:
        print(f"Imported {added} new {'tour' if added == 1 else 'tours'} from the imports folder.")
    for problem in problems[:10]:
        print(f"  Not imported: {problem}")
    if len(problems) > 10:
        print(f"  … and {len(problems) - 10} more files not imported.")


def _record(activity_id: str, tour: dict, kind: str, cfg: Config) -> dict | None:
    points = tour["points"]
    track = _hide_home([[lat, lon, ele] for lat, lon, ele, _ in points], cfg)
    if len(track) < 2:
        return None
    TRACKS_DIR.mkdir(parents=True, exist_ok=True)
    (TRACKS_DIR / f"{activity_id}.json").write_text(json.dumps(geo.simplify(track), separators=(",", ":")))

    start = points[0][3]
    offset = tour.get("utc_offset")
    if offset is None or abs(offset) > timedelta(hours=14):
        offset = timedelta(hours=round(points[0][1] / 15))  # rough local time from the longitude
    elevations = [p[2] for p in points if p[2] is not None]
    return {
        "source": "file",
        "name_in_file": tour.get("name"),
        "type_in_file": tour["type"],
        "sport_type": kind,
        "start_date": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "start_date_local": (start + offset).strftime("%Y-%m-%dT%H:%M:%SZ"),  # Strava's format
        "distance": tour.get("distance") or _distance(points),
        "total_elevation_gain": tour.get("gain") or _gain(elevations),
        "moving_time": round(tour.get("moving") or _moving_time(points)),
        "elev_high": max(elevations) if elevations else None,
        "total_photo_count": 0,
        "photos": [],
        "photos_for_count": 0,
        "has_track": True,
        "start_latlng": track[0][:2],
        "end_latlng": track[-1][:2],
    }


def _hide_home(track: list[list], cfg: Config) -> list[list]:
    """Cuts the first/last HIDE_NEAR_HOME_M of a track that starts/ends near home."""

    def cut_start(points: list[list]) -> list[list]:
        if not points or not cfg.near_home(points[0]):
            return points
        first_away = next((i for i, p in enumerate(points) if trips.distance_m(p, points[0]) > HIDE_NEAR_HOME_M), len(points))
        return points[first_away:]

    return cut_start(cut_start(track)[::-1])[::-1]


# --- Reading files ----------------------------------------------------------


def _read_gpx(path) -> dict:
    root = ET.parse(path).getroot()
    tag = lambda el: el.tag.rsplit("}", 1)[-1]  # noqa: E731 (drop the XML namespace)
    name = kind = None
    points = []
    for el in root.iter():
        if tag(el) == "trk":
            for child in el:
                if tag(child) == "name" and child.text and not name:
                    name = child.text.strip()
                elif tag(child) == "type" and child.text and not kind:
                    kind = child.text.strip()
        elif tag(el) == "trkpt":
            ele = time = None
            for child in el:
                if tag(child) == "ele" and child.text:
                    ele = float(child.text)
                elif tag(child) == "time" and child.text:
                    time = _time(child.text)
            points.append((float(el.get("lat")), float(el.get("lon")), ele, time))
    return {"name": name, "type": _type_from_text(kind or ""), "points": points}


def _read_fit(path) -> dict:
    tour = {"name": None, "points": []}
    sport = sub_sport = None
    with fitdecode.FitReader(path) as fit:
        for frame in fit:
            if frame.frame_type != fitdecode.FIT_FRAME_DATA:
                continue
            value = lambda field: frame.get_value(field, fallback=None)  # noqa: E731
            if frame.name == "record":
                lat, lon = value("position_lat"), value("position_long")
                if lat is None or lon is None:
                    continue
                ele = value("enhanced_altitude")
                ele = value("altitude") if ele is None else ele
                tour["points"].append((lat * SEMICIRCLES, lon * SEMICIRCLES, ele, value("timestamp")))
            elif frame.name in ("sport", "session"):
                sport, sub_sport = value("sport") or sport, value("sub_sport") or sub_sport
                if frame.name == "session":
                    tour.update(distance=value("total_distance"), gain=value("total_ascent"), moving=value("total_timer_time"))
            elif frame.name == "activity" and value("timestamp") and value("local_timestamp"):
                tour["utc_offset"] = value("local_timestamp") - value("timestamp")
    tour["type"] = _type_from_fit(str(sport or "").lower(), str(sub_sport or "").lower())
    return tour


def _type_from_fit(sport: str, sub_sport: str) -> str | None:
    if "backcountry" in sub_sport or sport == "ski_touring":
        return "BackcountrySki"
    if sport == "cycling":
        bikes = {"mountain": "MountainBikeRide", "gravel_cycling": "GravelRide", "e_bike_fitness": "EBikeRide",
                 "e_bike_mountain": "EMountainBikeRide"}
        return bikes.get(sub_sport, "Ride")
    return {"hiking": "Hike", "mountaineering": "Hike", "snowshoeing": "Snowshoe", "rock_climbing": "RockClimbing",
            "e_biking": "EBikeRide", "walking": "Walk", "running": "Run"}.get(sport)


def _type_from_text(text: str) -> str | None:
    text = text.lower()
    for words, kind in [
        (("ski tour", "skitour", "backcountry", "ski mountaineering"), "BackcountrySki"),
        (("snowshoe", "schneeschuh"), "Snowshoe"),
        (("climb", "kletter"), "RockClimbing"),
        (("mountain bik", "mtb"), "MountainBikeRide"),
        (("gravel",), "GravelRide"),
        (("cycl", "bik", "rad", "ride"), "Ride"),
        (("hik", "wander", "mountaineer", "bergsteig", "trek"), "Hike"),
        (("run", "lauf"), "Run"),
    ]:
        if any(w in text for w in words):
            return kind
    return None


def _name(stem: str, name_in_file: str | None, kind: str) -> str:
    for candidate in (stem.replace("_", " ").strip(), name_in_file):
        if candidate and not re.search(r"\d{4}|\d{1,2}[-.:]\d{2}|suunto|^\W*$", candidate, re.IGNORECASE):
            return candidate
    return DEFAULT_NAMES.get(kind, "Tour")


def _time(text) -> datetime:
    if isinstance(text, datetime):
        return text
    t = datetime.fromisoformat(text.strip())
    return t.replace(tzinfo=UTC) if t.tzinfo is None else t.astimezone(UTC)


# --- Stats when the file doesn't have them ------------------------------------


def _distance(points: list[tuple]) -> float:
    return sum(trips.distance_m(a, b) for a, b in zip(points, points[1:]))


def _gain(elevations: list[float], threshold: float = 4) -> float:
    """Total climb, ignoring GPS/barometer noise smaller than threshold."""
    if not elevations:
        return 0
    gain, ref = 0.0, elevations[0]
    for e in elevations[1:]:
        if e > ref + threshold:
            gain, ref = gain + e - ref, e
        elif e < ref - threshold:
            ref = e
    return gain


def _moving_time(points: list[tuple]) -> float:
    total = 0.0
    for a, b in zip(points, points[1:]):
        if a[3] and b[3]:
            seconds = (b[3] - a[3]).total_seconds()
            if 0 < seconds <= 120 and trips.distance_m(a, b) / seconds > 0.3:
                total += seconds
    return total

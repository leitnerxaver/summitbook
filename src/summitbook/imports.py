"""Tours from GPX and FIT files (e.g. exported from the Suunto app), from the import folders
in summitbook.toml (by default imports/).

FIT files know their sport. GPX files often don't: put them into a folder named after the kind
of tour, e.g. imports/ski-tour/Habicht.gpx. The file name becomes the tour's name, unless it
looks automatic (e.g. a date or a code). The files themselves stay on your computer; the tours
are saved in data/imports.json."""

import hashlib
import json
import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime, timedelta
from pathlib import Path

import fitdecode

from . import geo, trips
from .config import Config
from .privacy import hide_home
from .sync import TRACKS_DIR

FOLDER_TYPES = {
    "ski-tour": "BackcountrySki",
    "hike": "Hike",
    "trail-run": "TrailRun",
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
    "TrailRun": "Trail run",
}
SEMICIRCLES = 180 / 2**31  # FIT stores positions in "semicircles"


def import_files(cfg: Config, store: dict) -> None:
    folders = [f for f in cfg.import_folders if f.is_dir()]
    if not folders:
        return  # e.g. on GitHub: imported tours are already saved in data/
    records = store["activities"]
    strava_starts = [_time(r["start_date"]) for r in records.values() if r.get("source") != "file" and r.get("start_date")]
    seen, added, problems, in_cloud = set(), 0, [], 0

    files = [(f, p) for f in folders for p in sorted(f.rglob("*")) if p.is_file()]
    for folder, path in files:
        where = path.relative_to(folder).as_posix()
        # iCloud keeps some files only online ("Optimize Mac Storage"): keep their tours.
        if path.name.startswith(".") and path.name.endswith(".icloud"):
            original = path.with_name(path.name[1:-len(".icloud")]).relative_to(folder).as_posix()
            if original.lower().endswith((".gpx", ".fit")):
                seen.update(k for k, r in records.items() if r.get("folder") == _key(folder) and r.get("file") == original)
                in_cloud += 1
            continue
        if path.suffix.lower() not in (".gpx", ".fit"):
            continue
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
        rec["folder"], rec["file"] = _key(folder), where
        rec["sport_type"] = kind
        rec["name"] = _name(path.stem, rec.get("name_in_file"), rec["sport_type"])
        seen.add(activity_id)

    # Tours whose file was deleted (only for folders that are here: iCloud may be off).
    present = {_key(f) for f in folders}
    for gone in [k for k, r in records.items() if r.get("source") == "file" and r.get("folder") in present and k not in seen]:
        del records[gone]
        (TRACKS_DIR / f"{gone}.json").unlink(missing_ok=True)

    if added:
        print(f"Imported {added} new {'tour' if added == 1 else 'tours'} from the import folders.")
    if in_cloud:
        print(f"{in_cloud} files are only in iCloud right now. Open the folder in Finder to download them.")
    for problem in problems[:10]:
        print(f"  Not imported: {problem}")
    if len(problems) > 10:
        print(f"  … and {len(problems) - 10} more files not imported.")


def _key(folder: Path) -> str:
    """How a folder is remembered: "~/…" instead of your user folder's full path."""
    return f"~/{folder.relative_to(Path.home()).as_posix()}" if folder.is_relative_to(Path.home()) else folder.as_posix()


def _record(activity_id: str, tour: dict, kind: str, cfg: Config) -> dict | None:
    points = tour["points"]
    track = hide_home([[lat, lon, ele] for lat, lon, ele, _ in points], cfg)
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
    if sport == "running":
        return "TrailRun" if sub_sport == "trail" else "Run"
    return {"hiking": "Hike", "mountaineering": "Hike", "snowshoeing": "Snowshoe", "rock_climbing": "RockClimbing",
            "e_biking": "EBikeRide", "walking": "Walk"}.get(sport)


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
        (("trail", "berglauf"), "TrailRun"),
        (("run", "lauf"), "Run"),
    ]:
        if any(w in text for w in words):
            return kind
    return None


def _name(stem: str, name_in_file: str | None, kind: str) -> str:
    for candidate in (stem.replace("_", " ").strip(), name_in_file):
        # Skip automatic names: dates, Suunto's codes (5eac0e8400ca6879e895811f), …
        if candidate and not re.search(r"\d{4}|\d{1,2}[-.:]\d{2}|suunto|^[0-9a-f]{12,}$|^\W*$", candidate, re.IGNORECASE):
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

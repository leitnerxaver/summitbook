"""Writing the data the website shows (site/data/)."""

import json
import re
import shutil
from datetime import UTC, date, datetime

from . import geo, trips
from .config import SITE_DIR, Config
from .sync import TRACKS_DIR, load_track, trip_days

TYPE_LABELS = {
    "BackcountrySki": "Ski tour",
    "Hike": "Hike",
    "Snowshoe": "Snowshoe tour",
    "RockClimbing": "Climb",
    "Walk": "Walk",
    "AlpineSki": "Ski",
    "NordicSki": "Nordic ski",
    "Snowboard": "Snowboard",
    "TrailRun": "Trail run",
    "Run": "Run",
    "Ride": "Bike ride",
    "MountainBikeRide": "Mountain bike ride",
    "GravelRide": "Gravel ride",
    "EBikeRide": "E-bike ride",
    "EMountainBikeRide": "E-MTB ride",
}
# Map colors: on skis (blue), on foot (orange), by bike (aqua); anything else gray.
COLOR_GROUPS = [
    {"BackcountrySki", "AlpineSki", "NordicSki", "Snowboard"},
    {"Hike", "Walk", "Snowshoe", "RockClimbing"},
    {"Ride", "MountainBikeRide", "GravelRide", "EBikeRide", "EMountainBikeRide"},
]


def build(cfg: Config, store: dict) -> list[dict]:
    records = {k: rec for k, rec in store["activities"].items() if k not in cfg.hide}
    entries = []
    for group in trip_days(cfg, records):
        group = [_day(d["id"], records[d["id"]], d["start"], d["end"]) for d in group]
        if len({d["date"] for d in group}) > 1:
            entries.append(_entry(group, cfg, multi=True))  # multi-day trips are always shown
        else:
            for d in group:
                if d["type"] in cfg.always or (d["type"] in cfg.summit_only and d["summits"]):
                    entries.append(_entry([d], cfg, multi=False))
    entries.sort(key=lambda e: (e["date"], e["id"]), reverse=True)

    out = SITE_DIR / "data"
    tracks_out = out / "tracks"
    tracks_out.mkdir(parents=True, exist_ok=True)
    shown = {f"{d['id']}.json" for e in entries for d in e["days"] if d["track"]}
    for name in shown:
        shutil.copyfile(TRACKS_DIR / name, tracks_out / name)
    for old in tracks_out.glob("*.json"):
        if old.name not in shown:
            old.unlink()

    data = {
        "title": cfg.title,
        "subtitle": cfg.subtitle,
        "adventures_title": cfg.adventures_title,
        "updated": datetime.now(UTC).isoformat(timespec="minutes"),
        "types": [{"id": t, "label": _label(t), "color": _color_slot(t)} for t in cfg.types],
        "entries": entries,
    }
    (out / "summitbook.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))

    # A light version of every adventure's route for the overview map (the full tracks are big).
    routes = {
        e["id"]: [_preview(load_track(d["id"])) for d in e["days"] if d["track"]]
        for e in entries if e["category"] == "adventure"
    }
    (out / "adventures.json").write_text(json.dumps(routes, separators=(",", ":")))
    return entries


def _preview(track: list[list]) -> list[list]:
    flat = [[lat, lon, None] for lat, lon, _ in track]
    return [[round(lon, 4), round(lat, 4)] for lat, lon, _ in geo.simplify(flat, tolerance_m=60)]


def _day(activity_id: str, rec: dict, start, end) -> dict:
    has_track = bool(rec.get("has_track")) and (TRACKS_DIR / f"{activity_id}.json").exists()
    return {
        "id": activity_id,
        "source": rec.get("source", "strava"),
        "name": rec["name"],
        "type": rec["sport_type"],
        "date": rec["start_date_local"][:10],
        "time": rec["start_date_local"],
        "distance": round(rec.get("distance") or 0),
        "gain": round(rec.get("total_elevation_gain") or 0),
        "moving_time": rec.get("moving_time") or 0,
        "elev_high": rec.get("elev_high"),
        "summits": rec.get("summits") or [],
        "high_point": rec.get("high_point"),
        "photos": rec.get("photos") or [],
        "track": has_track,
        "start": start,
        "end": end,
    }


def _entry(days: list[dict], cfg: Config, multi: bool) -> dict:
    days = sorted(days, key=lambda d: d["time"])
    summits = list({s["id"]: s for d in days for s in d["summits"]}.values())  # each peak once, in order
    kind = trips.main_type(days, cfg.types)
    if multi:
        name = trips.title(days, summits, kind, _label(kind))
    else:
        name = days[0]["name"]
    highs = [d["high_point"] for d in days if d["high_point"]]
    elevs = [d["elev_high"] for d in days if d["elev_high"] is not None]
    first = date.fromisoformat(days[0]["date"])
    for d in days:
        d["day"] = (date.fromisoformat(d["date"]) - first).days + 1  # day 1, 2, … (rest days count)
    return {
        "id": days[0]["id"],
        "title": cfg.titles.get(days[0]["id"], name),
        "multi": multi,
        "titled": multi or days[0]["id"] in cfg.titles,  # show the title instead of the summit names
        "type": kind,
        "category": "adventure" if kind in cfg.multi_day_only else "summits",
        "date": days[0]["date"],
        "end_date": days[-1]["date"],
        "days_total": trips.span_days(days),
        "distance": sum(d["distance"] for d in days),
        "gain": sum(d["gain"] for d in days),
        "moving_time": sum(d["moving_time"] for d in days),
        "elev_high": max(elevs) if elevs else None,
        "summits": summits,
        "high_point": max(highs, key=lambda p: p[2]) if highs else None,
        "photos": [p for d in days for p in d["photos"]],
        "days": [{k: v for k, v in d.items() if k not in ("time", "start", "end")} for d in days],
    }


def _color_slot(sport_type: str) -> int:
    return next((i + 1 for i, types in enumerate(COLOR_GROUPS) if sport_type in types), 0)


def _label(sport_type: str) -> str:
    return TYPE_LABELS.get(sport_type) or re.sub(r"(?<!^)(?=[A-Z])", " ", sport_type).capitalize()

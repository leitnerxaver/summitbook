"""Writing the data the website shows (site/data/)."""

import json
import re
import shutil
from datetime import UTC, date, datetime

from . import geo, notes, plans, trips
from .config import DATA_DIR, SITE_DIR, Config
from .peaks import short_name
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
# Map colors: on skis (blue), on foot (orange), by bike (aqua), running (violet); anything else gray.
COLOR_GROUPS = [
    {"BackcountrySki", "AlpineSki", "NordicSki", "Snowboard"},
    {"Hike", "Walk", "Snowshoe", "RockClimbing"},
    {"Ride", "MountainBikeRide", "GravelRide", "EBikeRide", "EMountainBikeRide"},
    {"TrailRun"},
]


def build(cfg: Config, store: dict) -> list[dict]:
    records = {k: rec for k, rec in store["activities"].items() if k not in cfg.hide}
    entries = []
    for group in trip_days(cfg, records):
        group = [_day(d["id"], records[d["id"]], d["start"], d["end"], cfg) for d in group]
        if len({d["date"] for d in group}) > 1:
            entries.append(_entry(group, cfg, multi=True))  # multi-day trips are always shown
        else:
            for d in group:
                if d["type"] in cfg.always or (d["type"] in cfg.summit_only and d["summits"]):
                    entries.append(_entry([d], cfg, multi=False))
    entries.sort(key=lambda e: (e["date"], e["id"]), reverse=True)
    notes.attach(entries)

    out = SITE_DIR / "data"
    tracks_out = out / "tracks"
    tracks_out.mkdir(parents=True, exist_ok=True)
    shown = {f"{d['id']}.json" for e in entries for d in e["days"] if d["track"]}
    for name in shown:
        shutil.copyfile(TRACKS_DIR / name, tracks_out / name)
    for old in tracks_out.glob("*.json"):
        if old.name not in shown:
            old.unlink()

    # 3D map pictures (from `summitbook previews`) for tours without photos.
    pictures, pictures_out = DATA_DIR / "previews", out / "previews"
    pictures_out.mkdir(exist_ok=True)
    wanted = {f"{e['id']}.jpg" for e in entries if not e["photos"]}
    for picture in pictures.glob("*.jpg") if pictures.exists() else []:
        if picture.name not in wanted:
            picture.unlink()  # the tour got photos, or is gone
    for e in entries:
        if (pictures / f"{e['id']}.jpg").exists():
            shutil.copyfile(pictures / f"{e['id']}.jpg", pictures_out / f"{e['id']}.jpg")
            e["preview"] = f"data/previews/{e['id']}.jpg"
    for old in pictures_out.glob("*.jpg"):
        if old.name not in wanted:
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

    # A light version of every tour's track for the overview map (the full tracks are big).
    routes = {e["id"]: [_preview(load_track(d["id"])) for d in e["days"] if d["track"]] for e in entries}
    (out / "routes.json").write_text(json.dumps(routes, separators=(",", ":")))
    (out / "adventures.json").unlink(missing_ok=True)  # (older versions)
    (out / "plans.json").write_text(json.dumps(plans.read(), ensure_ascii=False, separators=(",", ":")))
    return entries


def _preview(track: list[list]) -> list[list]:
    flat = [[lat, lon, None] for lat, lon, _ in track]
    return [[round(lon, 4), round(lat, 4)] for lat, lon, _ in geo.simplify(flat, tolerance_m=40)]


def _day(activity_id: str, rec: dict, start, end, cfg: Config) -> dict:
    has_track = bool(rec.get("has_track")) and (TRACKS_DIR / f"{activity_id}.json").exists()
    summits = rec.get("summits") or []
    if has_track and cfg.extra_summits:
        known = {s["id"] for s in summits}
        extra = geo.find_summits(load_track(activity_id), _extra_summits(cfg), cfg.radius_m, cfg.altitude_tolerance_m)
        summits = summits + [s for s in extra if s["id"] not in known]
    summits = [{**s, "name": short_name(s["name"])} for s in summits]
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
        "summits": summits,
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
        "nights": _nights(days) if multi else [],
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


def _nights(days: list[dict]) -> list[dict]:
    """Where you slept on a multi-day trip: the end of each day that another day follows."""
    last_of_day = {}
    for d in days:  # (in time order: the last activity of each day wins)
        last_of_day[d["day"]] = d
    numbers = sorted(last_of_day)
    nights = []
    for day, next_day in zip(numbers, numbers[1:]):
        spot = last_of_day[day]["end"] or next((d["start"] for d in days if d["day"] == next_day), None)
        if spot:
            nights.append({
                "after_day": day, "count": next_day - day,  # (more than 1 with a rest day)
                "lat": round(spot[0], 5), "lon": round(spot[1], 5),
            })
    return nights


def _extra_summits(cfg: Config) -> list[dict]:
    """Your own summits from summitbook.toml, e.g. a hut: name = [lat, lon, height]."""
    return [
        {"id": "x-" + re.sub(r"\W+", "-", name.lower()).strip("-"), "name": name,
         "lat": spot[0], "lon": spot[1], "ele": spot[2] if len(spot) > 2 else None}
        for name, spot in cfg.extra_summits.items()
    ]


def _color_slot(sport_type: str) -> int:
    return next((i + 1 for i, types in enumerate(COLOR_GROUPS) if sport_type in types), 0)


def _label(sport_type: str) -> str:
    return TYPE_LABELS.get(sport_type) or re.sub(r"(?<!^)(?=[A-Z])", " ", sport_type).capitalize()

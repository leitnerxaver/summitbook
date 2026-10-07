"""Bringing new Strava activities into data/ and finding their summits."""

import json
import os
import time

from . import geo, peaks, trips
from .config import DATA_DIR, Config
from .peaks import PeakLookupError, needs_translation, peaks_in
from .privacy import blur, hide_home
from .strava import RateLimited, Strava

STORE_FILE = DATA_DIR / "activities.json"  # from Strava (the summit book's tours)
EVERYTHING_FILE = DATA_DIR / "everything.json"  # all your activities, for the map and the stats
IMPORTS_FILE = DATA_DIR / "imports.json"  # from GPX/FIT files in imports/
TRACKS_DIR = DATA_DIR / "tracks"
DETECTION_VERSION = 2
SUMMARY_FIELDS = (
    "name", "sport_type", "start_date", "start_date_local", "distance", "total_elevation_gain",
    "moving_time", "elev_high", "total_photo_count", "start_latlng", "end_latlng",
)


def load_store() -> dict:
    store = json.loads(STORE_FILE.read_text()) if STORE_FILE.exists() else {"detection": {}, "activities": {}}
    if IMPORTS_FILE.exists():
        store["activities"].update(json.loads(IMPORTS_FILE.read_text()))
    return store


def save_store(store: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    activities = store["activities"]
    strava = {k: r for k, r in activities.items() if r.get("source") != "file"}
    files = {k: r for k, r in activities.items() if r.get("source") == "file"}
    STORE_FILE.write_text(json.dumps({**store, "activities": strava}, indent=1, ensure_ascii=False))
    if files or IMPORTS_FILE.exists():
        IMPORTS_FILE.write_text(json.dumps(files, indent=1, ensure_ascii=False))


def save_everything(cfg: Config, activities: list[dict]) -> None:
    """All your activities (runs, rides, …): a short summary and a simplified route from
    Strava's activity list (no extra downloads), with the same privacy rules as the tracks."""
    everything = []
    for a in activities:
        if a["sport_type"].startswith("Virtual"):
            continue  # indoor
        line = geo.decode_polyline((a.get("map") or {}).get("summary_polyline") or "")
        line = hide_home([[lat, lon, None] for lat, lon in line], cfg)
        line = geo.simplify(line, tolerance_m=25) if len(line) >= 2 else []
        everything.append({
            "id": str(a["id"]), "name": a["name"], "type": a["sport_type"], "date": a["start_date_local"][:10],
            "distance": round(a.get("distance") or 0), "gain": round(a.get("total_elevation_gain") or 0),
            "moving_time": a.get("moving_time") or 0, "elev_high": a.get("elev_high"),
            "line": [[round(lon, 4), round(lat, 4)] for lat, lon, _ in line],
        })
    DATA_DIR.mkdir(exist_ok=True)
    EVERYTHING_FILE.write_text(json.dumps(everything, ensure_ascii=False, separators=(",", ":")))


def load_everything() -> list[dict]:
    return json.loads(EVERYTHING_FILE.read_text()) if EVERYTHING_FILE.exists() else []


def load_track(activity_id: str) -> list[list]:
    return json.loads((TRACKS_DIR / f"{activity_id}.json").read_text())


def endpoints(activity_id: str, rec: dict) -> tuple[list | None, list | None]:
    """Where an activity started and ended: from its GPS track, else from Strava's summary."""
    if rec.get("has_track") and (TRACKS_DIR / f"{activity_id}.json").exists():
        track = load_track(activity_id)
        return track[0][:2], track[-1][:2]
    return rec.get("start_latlng") or None, rec.get("end_latlng") or None


def trip_days(cfg: Config, records: dict) -> list[list[dict]]:
    """All activities grouped into trips (most groups are a single day)."""
    days = []
    for activity_id, rec in records.items():
        start, end = endpoints(activity_id, rec)
        days.append({
            "id": activity_id, "name": rec["name"], "type": rec["sport_type"],
            "date": rec["start_date_local"][:10], "time": rec["start_date_local"], "start": start, "end": end,
        })
    return trips.group(days, cfg.link_radius_m, cfg.homes, cfg.home_radius_km * 1000, set(cfg.single_day))




def download(cfg: Config, store: dict, wait: bool) -> None:
    client = Strava()
    print("Downloading your activity list from Strava…")
    activities = client.activities()
    visibility = {"everyone", "followers_only"} if cfg.include_followers_only else {"everyone"}
    save_everything(cfg, [a for a in activities if a.get("visibility") in visibility])
    wanted = [
        a for a in activities
        if a.get("sport_type") in cfg.types and a.get("visibility") in visibility
        # Rides from home back home (commutes, day rides) can never be part of a trip: skip them.
        and not (a["sport_type"] in cfg.multi_day_only
                 and cfg.near_home(a.get("start_latlng")) and cfg.near_home(a.get("end_latlng")))
    ]
    print(f"Found {len(activities)} activities on Strava; {len(wanted)} could go into your summit book.")

    # Forget activities that were deleted, made private or changed to another sport.
    records = store["activities"]
    keep = {str(a["id"]) for a in wanted}
    for gone in [k for k, r in records.items() if k not in keep and r.get("source") != "file"]:
        del records[gone]
        (TRACKS_DIR / f"{gone}.json").unlink(missing_ok=True)

    for a in wanted:
        rec = records.setdefault(str(a["id"]), {})
        rec.update({k: a.get(k) for k in SUMMARY_FIELDS})
        rec["start_latlng"], rec["end_latlng"] = blur(rec["start_latlng"], cfg), blur(rec["end_latlng"], cfg)
        if a.get("manual") or not (a.get("map") or {}).get("summary_polyline"):
            rec["has_track"] = False  # no GPS recorded, nothing to download

    # Rides only matter as part of a multi-day trip: only download their GPS track and photos then.
    on_trips = {d["id"] for g in trip_days(cfg, records) if len({d["date"] for d in g}) > 1 for d in g}
    todo = [
        a for a in wanted
        if (a["sport_type"] not in cfg.multi_day_only or str(a["id"]) in on_trips) and _needs_download(records[str(a["id"])])
    ]
    todo.sort(key=lambda a: a["start_date_local"], reverse=True)  # newest first
    for n, a in enumerate(todo, 1):
        rec = records[str(a["id"])]
        print(f"[{n}/{len(todo)}] {a['start_date_local'][:10]}  {a['name']}")
        while True:
            try:
                _download_one(client, a["id"], rec, cfg)
                save_store(store)
                break
            except RateLimited as limit:
                save_store(store)
                if limit.daily or not wait:
                    print(f"\n{limit}. The rest will be downloaded next time you run the update.")
                    return
                _wait_for_next_window()


def _needs_download(rec: dict) -> bool:
    return "has_track" not in rec or rec.get("photos_for_count", 0) != (rec.get("total_photo_count") or 0)


def _download_one(client: Strava, activity_id: int, rec: dict, cfg: Config) -> None:
    if "has_track" not in rec:
        raw = client.track(activity_id)
        track = hide_home(geo.simplify(raw), cfg) if raw else []
        if len(track) >= 2:
            TRACKS_DIR.mkdir(parents=True, exist_ok=True)
            (TRACKS_DIR / f"{activity_id}.json").write_text(json.dumps(track, separators=(",", ":")))
        rec["has_track"] = len(track) >= 2
        rec.pop("summits", None)
    count = rec.get("total_photo_count") or 0
    if rec.get("photos_for_count", 0) != count:
        rec["photos"] = client.photos(activity_id) if count else []
        rec["photos_for_count"] = count


def _wait_for_next_window() -> None:
    # Strava's 15-minute limits reset at :00, :15, :30 and :45.
    seconds = 900 - time.time() % 900 + 10
    print(f"\nStrava only allows a limited number of downloads every 15 minutes.")
    print(f"Waiting {round(seconds / 60)} minutes, then continuing. Leave this window open (Ctrl+C to stop).")
    time.sleep(seconds)


def detect_summits(cfg: Config, store: dict) -> None:
    settings = {"radius_m": cfg.radius_m, "altitude_tolerance_m": cfg.altitude_tolerance_m, "version": DETECTION_VERSION}
    if store.get("detection") != settings:
        for rec in store["activities"].values():
            rec.pop("summits", None)  # settings changed: check every track again
        store["detection"] = settings

    for rec in store["activities"].values():
        # Summit names in another script (from older versions): look them up once more.
        if not rec.get("renamed") and any(needs_translation(s["name"]) for s in rec.get("summits") or []):
            rec.pop("summits")
            rec["renamed"] = True

    todo = [(k, r) for k, r in store["activities"].items() if r.get("has_track") and "summits" not in r]
    for activity_id, rec in todo:
        if rec["sport_type"] in cfg.multi_day_only:
            # Bike rides cover huge areas and rarely end on a summit: don't search them.
            rec["summits"], rec["high_point"] = [], geo.high_point(load_track(activity_id))
    todo = [(k, r) for k, r in todo if "summits" not in r]
    if todo:
        print(f"Looking for summits on {len(todo)} tracks…", flush=True)
    # The free map server can be slow for hours: stop after a while, the rest is checked next time.
    peaks.deadline = time.time() + 60 * float(os.environ.get("SUMMITBOOK_SUMMIT_MINUTES", 20))
    for activity_id, rec in todo:
        track = load_track(activity_id)
        try:
            nearby = peaks_in(*geo.bounds(track, pad_m=cfg.radius_m))
        except PeakLookupError as err:
            if "not reachable" in str(err):
                break
            continue
        rec["summits"] = geo.find_summits(track, nearby, cfg.radius_m, cfg.altitude_tolerance_m)
        rec["high_point"] = geo.high_point(track)
        save_store(store)  # keep what's found so far, in case the update is stopped
        if rec["summits"]:
            names = ", ".join(f"{s['name']}" + (f" ({s['ele']:.0f} m)" if s["ele"] else "") for s in rec["summits"])
            print(f"  {rec['start_date_local'][:10]}  {rec['name']}  →  {names}", flush=True)
    save_store(store)
    left = sum(1 for r in store["activities"].values() if r.get("has_track") and "summits" not in r)
    if left:
        print(f"OpenStreetMap was too busy for {left} tracks. They'll be checked next time.")

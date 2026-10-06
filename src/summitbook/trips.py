"""Combining back-to-back days from the same base (a hut, a hotel) into one multi-day trip."""

import math
import re
from collections import Counter
from datetime import date

from .peaks import PeakLookupError, huts_in, short_name, towns_in

BIKE_TYPES = {"Ride", "MountainBikeRide", "GravelRide", "EBikeRide", "EMountainBikeRide"}
TRIP_WORDS = {
    "BackcountrySki": "ski tour",
    "Hike": "mountain tour",
    "Snowshoe": "snowshoe tour",
    "RockClimbing": "climbing trip",
    "Ride": "bike tour",
    "MountainBikeRide": "mountain bike tour",
    "GravelRide": "gravel tour",
    "EBikeRide": "e-bike tour",
    "EMountainBikeRide": "e-MTB tour",
}

# Strava's and Garmin's automatic titles: "Morning Hike", "Abendwanderung", "Neustift Ski Touring", …
_TIME_OF_DAY = re.compile(
    r"\b(morning|afternoon|evening|lunch|night|morgen|vormittag|mittag|nachmittag|abend|nacht"
    r"|morgendlich|mittäglich|nachmittäglich|abendlich|nächtlich)",
    re.IGNORECASE,
)
_ENDS_WITH_SPORT = re.compile(
    r"(backcountry ski(ing)?|ski tour(ing)?|skitour(en)?|hik(e|ing)|wander(n|ung)|walk(ing)?|spaziergang"
    r"|snowshoe(ing)?|schneeschuh\w*|mountaineering|bergsteigen|bergtour|hochtour|rock climbing|climb(ing)?"
    r"|klettern|ski(ing)?|skifahren|ride|cycling|biking|radfahrt|radfahren|radtour|mountainbike\w*|mtb"
    r"|gravel\w*|e-?bike\w*)$",
    re.IGNORECASE,
)
# "Tag 3", "Day 2", "Etappe 4", "Teil II", "(2/5)", or a plain " 2" at the end of a title
_DAY_SUFFIX = re.compile(
    r"[\s,:–-]*((tag|day|etappe|stage|teil|part)\s*(\d+|[ivx]+)|\(?\d+\s*/\s*\d+\)?|\(\d+\)|(?<=\s)\d+)\s*$", re.IGNORECASE
)
_TRAILING_SYMBOLS = re.compile(r"[^\w)\]]+$")  # emoji, flags, punctuation


def distance_m(a, b) -> float:
    dy = (a[0] - b[0]) * 111_320
    dx = (a[1] - b[1]) * 111_320 * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot(dx, dy)


# A trip continues across one rest day. Far from home you're travelling, so the next day may
# also start some distance from where you stopped (a transfer by train, bus or ferry).
MAX_GAP_DAYS = 2
FAR_FROM_HOME_KM = 100
FAR_TRANSFER_KM = 150
BIKE_LINK_KM = 20  # by bike, the next hotel is often a few km off the route
SAME_NAME_GAP_DAYS = 5  # "Georgien Tag 17" … "Georgien over and out" still belong together


def group(
    days: list[dict], link_radius_m: float, homes: list, home_radius_m: float, single_day: set[str] = frozenset()
) -> list[list[dict]]:
    """Groups days (dicts with id, name, type, date, time, start, end) into trips. A day joins a
    trip if it's at most a rest day later and starts within link_radius_m (bikes: BIKE_LINK_KM)
    of where a day of that trip started or ended. Places near a home never link days, and a day
    that ends at home ends the trip, so tours from home stay day trips; a trip may still start or
    end at home (a bike tour from your door)."""

    def home_km(p) -> float:
        return min((distance_m(p, h) / 1000 for h in homes), default=float("inf"))

    def at_home(p) -> bool:
        return bool(p) and home_km(p) * 1000 <= home_radius_m

    def far(p) -> bool:
        return bool(p) and home_km(p) > FAR_FROM_HOME_KM

    def continues(trip: list[dict], d: dict) -> bool:
        today, last = date.fromisoformat(d["date"]), trip[-1]
        gap = (today - date.fromisoformat(last["date"])).days
        if gap < 0 or last["id"] in single_day:
            return False
        if gap > 0 and at_home(last["end"]):
            return False  # slept at home: that trip is over
        if gap <= SAME_NAME_GAP_DAYS and (title := _trip_name(trip)) and d["name"].lower().startswith(title.lower()):
            return True
        if gap > MAX_GAP_DAYS:
            return False
        radius = BIKE_LINK_KM * 1000 if d["type"] in BIKE_TYPES else link_radius_m
        recent = [x for x in trip if (today - date.fromisoformat(x["date"])).days <= MAX_GAP_DAYS]
        if any(p and not at_home(p) and distance_m(d["start"], p) <= radius for x in recent for p in (x["start"], x["end"])):
            return True
        return far(last["end"]) and far(d["start"]) and distance_m(d["start"], last["end"]) <= FAR_TRANSFER_KM * 1000

    trips: list[list[dict]] = []
    for d in sorted(days, key=lambda d: d["time"]):
        if d["start"] is not None and d["id"] not in single_day:
            trip = next((t for t in reversed(trips[-20:]) if continues(t, d)), None)
            if trip:
                trip.append(d)
                continue
        trips.append([d])
    return trips


def _trip_name(trip: list[dict]) -> str | None:
    """Your own title shared by several days of the trip ("Georgien Tag 1", "Georgien Tag 2")."""
    names = [base_title(d["name"]) for d in trip if not is_automatic_title(d["name"])]
    return next((n for n in names if n and sum(m.lower() == n.lower() for m in names) > 1), None)


def base_title(name: str) -> str:
    """The title without day numbers: "Georgien Tag 14 (2)" -> "Georgien"."""
    name = _TRAILING_SYMBOLS.sub("", name.strip())
    while (shorter := _DAY_SUFFIX.sub("", name).strip()) != name:
        name = shorter
    return name


def span_days(days: list[dict]) -> int:
    """Calendar days from the first to the last day, rest days included."""
    dates = sorted(date.fromisoformat(d["date"]) for d in days)
    return (dates[-1] - dates[0]).days + 1


def is_automatic_title(name: str) -> bool:
    name = name.strip()
    return bool(_TIME_OF_DAY.search(name)) or (bool(_ENDS_WITH_SPORT.search(name)) and len(name.split()) <= 5)


def main_type(days: list[dict], type_order: list[str]) -> str:
    counts = Counter(d["type"] for d in days)
    return max(counts, key=lambda t: (counts[t], -type_order.index(t) if t in type_order else -99))


def title(days: list[dict], summits: list[dict], kind: str, type_label: str) -> str:
    n = span_days(days)
    word = TRIP_WORDS.get(kind, type_label.lower())

    # 1. Your own Strava title: one that repeats over several days ("Georgien Tag 1", "Georgien
    #    Tag 2", …), or on a short trip the only one you wrote (longer trips have day notes).
    own = [base_title(d["name"]) for d in days if not is_automatic_title(d["name"])]
    own = [t for t in own if t]
    repeated = [t for t in dict.fromkeys(own) if sum(o.lower() == t.lower() for o in own) > 1]
    if repeated:
        return repeated[0]
    if len({t.lower() for t in own}) == 1 and n <= 3:
        return own[0]

    # 2. Bike trips: where they started and ended.
    if kind in BIKE_TYPES:
        try:
            start, end = _town_near(days[0]["start"]), _town_near(days[-1]["end"])
        except PeakLookupError:
            return f"{n}-day {word}"  # town names are looked up again on the next update
        if start and end and start != end:
            return f"{n}-day {word} from {start} to {end}"
        if start or end:
            return f"{n}-day {word} around {start or end}"
        return f"{n}-day {word}"

    # 3. Mountain trips: the summit, or the hut.
    if len(summits) == 1:
        return f"{n}-day {word} on the {summits[0]['name']}"
    if hut := _base_hut(days):
        return f"{n}-day {word} from the {hut}"
    if summits:
        highest = max(summits, key=lambda s: s["ele"] or 0)
        return f"{n}-day {word} around the {highest['name']}"
    return f"{n}-day {word}"


def _nearest(points: list, lookup, radius_m: float) -> str | None:
    """Name of the closest place (from lookup) within radius_m of any of the points."""
    points = [p for p in points if p]
    if not points:
        return None
    pad_lat = radius_m / 111_320
    pad_lon = pad_lat / math.cos(math.radians(points[0][0]))
    lats, lons = [p[0] for p in points], [p[1] for p in points]
    places = lookup(min(lats) - pad_lat, min(lons) - pad_lon, max(lats) + pad_lat, max(lons) + pad_lon)
    best = min(
        ((min(distance_m(p, (x["lat"], x["lon"])) for p in points), x["name"]) for x in places if x.get("name")),
        default=None,
    )
    return short_name(best[1]) if best and best[0] <= radius_m else None


def _base_hut(days: list[dict]) -> str | None:
    """The hut where the days start (from day 2 on, you start at the base)."""
    try:
        return _nearest([d["start"] for d in days[1:]], huts_in, 400)
    except PeakLookupError:
        return None


def _town_near(point) -> str | None:
    return _nearest([point], towns_in, 8000)

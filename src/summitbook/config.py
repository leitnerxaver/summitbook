"""Where files live, and the settings from summitbook.toml."""

import tomllib
from dataclasses import dataclass, field
from pathlib import Path


def _find_root() -> Path:
    here = Path.cwd()
    for folder in (here, *here.parents):
        if (folder / "summitbook.toml").exists():
            return folder
    return here


ROOT = _find_root()
CONFIG_FILE = ROOT / "summitbook.toml"
SECRETS_FILE = ROOT / ".strava.json"  # your Strava login, never published
CACHE_DIR = ROOT / ".cache"  # OpenStreetMap peaks, safe to delete
DATA_DIR = ROOT / "data"  # everything downloaded from Strava
SITE_DIR = ROOT / "site"  # the website itself
IMPORTS_DIR = ROOT / "imports"  # GPX/FIT files, e.g. from Suunto (stay on this computer)


@dataclass
class Config:
    title: str = "Summit Book"
    subtitle: str = ""
    adventures_title: str = "Bike adventures"
    always: list[str] = field(default_factory=lambda: ["BackcountrySki"])
    summit_only: list[str] = field(default_factory=lambda: ["Hike", "Snowshoe", "RockClimbing"])
    multi_day_only: list[str] = field(
        default_factory=lambda: ["Ride", "MountainBikeRide", "GravelRide", "EBikeRide", "EMountainBikeRide"]
    )
    include_followers_only: bool = False
    radius_m: float = 80
    altitude_tolerance_m: float = 50
    # Activity ids as text: Strava's numbers, or "f…" for imported files
    hide: list[str] = field(default_factory=list)
    single_day: list[str] = field(default_factory=list)
    titles: dict[str, str] = field(default_factory=dict)
    link_radius_m: float = 500
    homes: list[list[float]] = field(default_factory=lambda: [[47.2655, 11.3925]])
    home_radius_km: float = 7

    def near_home(self, point) -> bool:
        from .trips import distance_m  # (avoids a circular import)

        return bool(point) and any(distance_m(point, h) <= self.home_radius_km * 1000 for h in self.homes)

    @property
    def types(self) -> list[str]:
        return list(dict.fromkeys(self.always + self.summit_only + self.multi_day_only))


def load_config() -> Config:
    if not CONFIG_FILE.exists():
        return Config()
    raw = tomllib.loads(CONFIG_FILE.read_text())
    site, acts, summits, multi, fixes = (raw.get(k, {}) for k in ("site", "activities", "summits", "multi_day", "fixes"))
    default = Config()
    return Config(
        title=site.get("title", default.title),
        subtitle=site.get("subtitle", default.subtitle),
        adventures_title=site.get("adventures_title", default.adventures_title),
        always=acts.get("always", default.always),
        summit_only=acts.get("summit_only", default.summit_only),
        multi_day_only=acts.get("multi_day_only", default.multi_day_only),
        include_followers_only=acts.get("include_followers_only", default.include_followers_only),
        radius_m=summits.get("radius_m", default.radius_m),
        altitude_tolerance_m=summits.get("altitude_tolerance_m", default.altitude_tolerance_m),
        hide=[str(i) for i in fixes.get("hide", [])],
        single_day=[str(i) for i in fixes.get("single_day", [])],
        titles={str(k): v for k, v in raw.get("titles", {}).items()},
        link_radius_m=multi.get("link_radius_m", default.link_radius_m),
        homes=multi.get("homes", [multi["home"]] if "home" in multi else default.homes),
        home_radius_km=multi.get("home_radius_km", default.home_radius_km),
    )

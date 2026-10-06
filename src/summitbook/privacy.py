"""Keeping your homes private: tracks that start or end near a home lose their first/last
kilometer, no track point comes within a kilometer of a home, and start/end points near a home
are blurred to about 1 km."""

from .config import Config
from .trips import distance_m

HIDE_NEAR_HOME_M = 1000
AT_HOME_M = 2500  # a track starting this close to a home starts at your door (not at a trailhead)


def at_home(point, cfg: Config) -> bool:
    return bool(point) and any(distance_m(point, h) <= AT_HOME_M for h in cfg.homes)


def hide_home(track: list[list], cfg: Config) -> list[list]:
    """Cuts the first/last HIDE_NEAR_HOME_M of a track that starts/ends near a home, and every
    point within HIDE_NEAR_HOME_M of a home (e.g. a ride passing by)."""

    def cut_start(points: list[list]) -> list[list]:
        if not points or not at_home(points[0], cfg):
            return points
        first_away = next((i for i, p in enumerate(points) if distance_m(p, points[0]) > HIDE_NEAR_HOME_M), len(points))
        return points[first_away:]

    track = cut_start(cut_start(track)[::-1])[::-1]
    return [p for p in track if all(distance_m(p, h) > HIDE_NEAR_HOME_M for h in cfg.homes)]


def blur(point, cfg: Config):
    """A point near a home, rounded to about 1 km (still near home for the trip rules)."""
    return [round(point[0], 2), round(point[1], 2)] if at_home(point, cfg) else point

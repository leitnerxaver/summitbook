"""Your words about tours, from notes.md (shown on the tour page and in the logbook, only for
tours you wrote about).

Start each note with "## " and the tour's date ("## 2025-03-14" or "## 14.3.2025"), optionally
followed by anything that helps you find it ("## 2025-03-14 Habicht"). For two tours on the same
day, use the tour's number from its web address instead (…/#/tour/12345678901). On a multi-day
trip, any of its dates works."""

import re

from . import plans
from .config import ROOT

NOTES_FILE = ROOT / "notes.md"


def attach(entries: list[dict]) -> None:
    """Adds your notes to the tours (entry["note"], as HTML)."""
    if not NOTES_FILE.exists():
        return
    text = re.sub(r"<!--.*?-->", "", NOTES_FILE.read_text(), flags=re.S)  # comments are for you only
    for block in re.split(r"^## ", text, flags=re.M)[1:]:
        head, _, body = block.partition("\n")
        html = plans.to_html(body)
        if not head.strip() or not html:
            continue
        key = _key(head.split()[0])
        matches = [
            e for e in entries
            if key in (e["id"], *(d["id"] for d in e["days"])) or e["date"] <= key <= e["end_date"]
        ]
        if not matches:
            print(f"  notes.md: no tour found for \"## {head.strip()}\"")
        for e in matches:
            e["note"] = e.get("note", "") + html


def _key(token: str) -> str:
    """A date as YYYY-MM-DD (from "2025-03-14" or "14.3.2025"), or a tour number."""
    if m := re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", token):
        return f"{m[1]}-{int(m[2]):02d}-{int(m[3]):02d}"
    if m := re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", token):
        return f"{m[3]}-{int(m[2]):02d}-{int(m[1]):02d}"
    return token

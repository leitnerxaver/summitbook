"""Your notes for future tours, from plans.md (shown on the website's Plans page).

Each plan starts with a "## " line (its title); the lines below are the note. Lines starting
with "- " become a list, **bold** is bold, and [text](link) is a link."""

import html
import re

from .config import ROOT

PLANS_FILE = ROOT / "plans.md"


def read() -> list[dict]:
    if not PLANS_FILE.exists():
        return []
    text = re.sub(r"<!--.*?-->", "", PLANS_FILE.read_text(), flags=re.S)  # comments are for you only
    plans = []
    for block in re.split(r"^## ", text, flags=re.M)[1:]:
        title, _, body = block.partition("\n")
        plans.append({"title": title.strip(), "html": to_html(body)})
    return plans


def to_html(text: str) -> str:
    parts, items = [], []
    for line in text.strip().splitlines() + [""]:
        line = line.strip()
        if line.startswith(("- ", "* ")):
            items.append(f"<li>{_inline(line[2:])}</li>")
            continue
        if items:
            parts.append(f"<ul>{''.join(items)}</ul>")
            items = []
        if line:
            parts.append(f"<p>{_inline(line)}</p>")
    return "".join(parts)


def _inline(text: str) -> str:
    text = html.escape(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    return re.sub(r"\[(.+?)\]\((https?://[^)\s]+)\)", r'<a href="\2" target="_blank" rel="noopener">\1</a>', text)

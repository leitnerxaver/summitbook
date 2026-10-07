"""Your own pages, written as simple text files: plans.md (Plans), gear.md (Gear) and
about.md (About me). They're turned into the website's pages when it's built.

Formatting: "## " starts a section (a plan, a gear list), "### " a smaller heading, lines
starting with "- " make a list, **bold** is bold, [text](link) is a link and ![text](photo.jpg)
shows a photo (put the photo into the site/ folder). Text inside <!-- … --> is never shown."""

import html
import re

from .config import ROOT

def plans() -> list[dict]:
    return _sections(ROOT / "plans.md")


def gear() -> list[dict]:
    """Your gear lists, in the order of gear.md (delete a "## " section to remove a list)."""
    return _sections(ROOT / "gear.md")


def about() -> str:
    path = ROOT / "about.md"
    return to_html(_text(path)) if path.exists() else ""


def _text(path) -> str:
    return re.sub(r"<!--.*?-->", "", path.read_text(), flags=re.S)  # comments are for you only


def _sections(path) -> list[dict]:
    if not path.exists():
        return []
    sections = []
    for block in re.split(r"^## ", _text(path), flags=re.M)[1:]:
        title, _, body = block.partition("\n")
        sections.append({"title": title.strip(), "html": to_html(body)})
    return sections


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
        if line.startswith("### ") or line.startswith("# "):  # (one # is forgiven as a small heading)
            parts.append(f"<h3>{_inline(line.lstrip('#').strip())}</h3>")
        elif line.startswith("## "):
            parts.append(f"<h2>{_inline(line[3:])}</h2>")
        elif line:
            parts.append(f"<p>{_inline(line)}</p>")
    return "".join(parts)


def _inline(text: str) -> str:
    text = html.escape(text)
    # Photos: a web address, or a file in the site/ folder (no folders above it)
    text = re.sub(
        r"!\[(.*?)\]\((https?://[^)\s]+|[\w][\w.-]*(?:/[\w][\w.-]*)*)\)",
        r'<img src="\2" alt="\1" loading="lazy">', text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    return re.sub(r"(?<!!)\[(.+?)\]\((https?://[^)\s]+)\)", r'<a href="\2" target="_blank" rel="noopener">\1</a>', text)

"""3D map pictures for tours without photos, made by a browser without a screen.

Runs on GitHub every day (it needs: uv run --extra previews summitbook previews). Each picture
is made once and saved in data/previews/; the website shows it instead of the mountain icon."""

import os
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from .config import DATA_DIR, SITE_DIR

PREVIEWS_DIR = DATA_DIR / "previews"
SIZE = {"width": 640, "height": 480}
MIN_BYTES = 25_000  # smaller pictures are mostly empty: the map didn't load


def needs_preview(entry: dict) -> bool:
    return not entry["photos"] and any(d["track"] for d in entry["days"])


def make_previews(entries: list[dict], limit: int | None = None) -> int:
    from playwright.sync_api import sync_playwright  # only installed where pictures are made

    todo = [e for e in entries if needs_preview(e) and not (PREVIEWS_DIR / f"{e['id']}.jpg").exists()]
    if limit is not None:
        todo = todo[:limit]
    if not todo:
        return 0
    PREVIEWS_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Making 3D pictures for {len(todo)} tours without photos…", flush=True)
    deadline = time.time() + 60 * float(os.environ.get("SUMMITBOOK_PREVIEW_MINUTES", 15))

    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    made = 0
    with ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=str(SITE_DIR))) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with sync_playwright() as p:
            # The 3D map needs WebGL; without a graphics card it is drawn in software.
            args = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
            try:
                browser = p.chromium.launch(channel="chrome", args=args)  # Chrome, if installed
            except Exception:
                browser = p.chromium.launch(args=args)  # Playwright's own browser
            for entry in todo:
                if time.time() > deadline:
                    print("Time's up for pictures; the rest are made next time.")
                    break
                page = browser.new_page(viewport=SIZE)
                try:
                    page.goto(f"http://127.0.0.1:{server.server_port}/#/preview/{entry['id']}")
                    page.wait_for_function("window.summitbookPreviewReady || window.summitbookPreviewFailed", timeout=90_000)
                    if page.evaluate("window.summitbookPreviewFailed === true"):
                        raise RuntimeError("the map didn't load completely, trying again next time")
                    picture = page.screenshot(type="jpeg", quality=78)
                    if len(picture) < MIN_BYTES:
                        raise RuntimeError("the picture came out empty, trying again next time")
                    (PREVIEWS_DIR / f"{entry['id']}.jpg").write_bytes(picture)
                    made += 1
                except Exception as err:  # one difficult tour shouldn't stop the others
                    print(f"  No picture for {entry['date']} {entry['title']}: {err}")
                finally:
                    page.close()
            browser.close()
        server.shutdown()
    print(f"Made {made} pictures.")
    return made

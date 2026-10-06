"""The `summitbook` command: uv run summitbook <login|update|build|serve>."""

import argparse
import re
import subprocess
import sys
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from . import imports, site, strava, sync
from .config import ROOT, SITE_DIR, load_config


def main() -> None:
    parser = argparse.ArgumentParser(prog="summitbook", description="Your summit book, built from Strava.")
    commands = parser.add_subparsers(dest="command", metavar="<command>")

    login = commands.add_parser("login", help="connect to your Strava account (once)")
    login.add_argument("--client-id")
    login.add_argument("--client-secret")

    update = commands.add_parser("update", help="download new activities from Strava and rebuild the website")
    update.add_argument("--no-wait", action="store_true", help="stop instead of waiting when Strava's limit is reached")

    commands.add_parser("build", help="rebuild the website from already downloaded data (e.g. after editing summitbook.toml)")

    commands.add_parser("publish", help="put your changes online (imported files, settings)")

    previews = commands.add_parser("previews", help="make 3D map pictures for tours without photos (runs on GitHub)")
    previews.add_argument("--limit", type=int, help="make at most this many pictures")

    serve = commands.add_parser("serve", help="open the website on your computer")
    serve.add_argument("--port", type=int, default=8000)

    args = parser.parse_args()
    try:
        match args.command:
            case "login":
                strava.login(args.client_id, args.client_secret)
            case "update":
                run_update(download=True, wait=not args.no_wait)
            case "build":
                run_update(download=False, wait=False)
            case "publish":
                run_publish()
            case "previews":
                run_previews(args.limit)
            case "serve":
                run_server(args.port)
            case _:
                parser.print_help()
    except strava.StravaError as err:
        sys.exit(f"\n{err}")
    except KeyboardInterrupt:
        sys.exit("\nStopped.")


def run_update(download: bool, wait: bool) -> None:
    cfg = load_config()
    store = sync.load_store()
    if download:
        sync.download(cfg, store, wait)
    imports.import_files(cfg, store)
    sync.detect_summits(cfg, store)
    entries = site.build(cfg, store)
    summits = sum(len(e["summits"]) for e in entries)
    print(f"\nDone! Your summit book has {_count(len(entries), 'tour')} with {_count(summits, 'summit')}.")
    print("To look at it, run: uv run summitbook serve")


def run_previews(limit: int | None) -> None:
    from .previews import make_previews

    cfg = load_config()
    store = sync.load_store()
    entries = site.build(cfg, store)  # the pictures are taken from the current website
    if make_previews(entries, limit):
        site.build(cfg, store)  # now with the pictures


def run_publish() -> None:
    """Gets the newest data from GitHub (it updates from Strava every day), adds your imported
    files and settings, and uploads everything. GitHub then publishes the website."""

    def git(*args: str) -> int:
        return subprocess.run(["git", *args], cwd=ROOT).returncode

    print("Getting the newest version from GitHub…")
    if git("pull", "--rebase", "--autostash", "--quiet") != 0:
        sys.exit("\nCouldn't get the newest version from GitHub (see above). Nothing was uploaded.")
    run_update(download=False, wait=False)
    git("add", "--all")
    if git("diff", "--cached", "--quiet") == 0:
        print("\nNothing new to publish.")
        return
    if git("commit", "--quiet", "--message", "Update summit book") != 0 or git("push", "--quiet") != 0:
        sys.exit("\nUploading to GitHub failed (see above).")
    remote = subprocess.run(["git", "remote", "get-url", "origin"], cwd=ROOT, capture_output=True, text=True).stdout
    if match := re.search(r"github\.com[:/]([^/]+)/([^/.\s]+)", remote):
        print(f"\nPublished! The website updates in a few minutes: https://{match[1]}.github.io/{match[2]}/")


def _count(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


class _QuietHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


def run_server(port: int) -> None:
    handler = partial(_QuietHandler, directory=str(SITE_DIR))
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        url = f"http://localhost:{port}/"
        print(f"Your summit book is open at {url}\nPress Ctrl+C to stop.")
        webbrowser.open(url)
        server.serve_forever()

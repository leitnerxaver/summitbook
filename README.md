# Summit Book

A website of your ski tours and summits, built from your Strava activities.

- **Ski tours** always appear, even without a summit (a couloir, a powder run).
- **Hikes, snowshoe tours and climbs** only appear when you reached a summit.
- **Bike rides** (road, mountain bike, gravel, e-bike) only appear as part of a multi-day trip, in their own section: **Bike adventures**.
- **Runs, trail runs and everything else** never appear.
- **Summits are found automatically** by comparing your GPS track with the mountain peaks in OpenStreetMap.
- **Back-to-back days from the same base** (a hut, a hotel), or each starting where the day before ended, become one multi-day entry, with each day in its own color on the map. Tours from home stay day trips.
- Every tour has a **3D map** with your route, your **Strava photos**, and a link back to Strava.
- **Tours that aren't on Strava** (e.g. from Suunto) can be added as GPX or FIT files.

## One-time setup

You need [uv](https://docs.astral.sh/uv/) (already installed) and a free Strava "API application", which is what lets this program read your activities.

1. Go to <https://www.strava.com/settings/api> and create an application:
   - **Application Name:** Summit Book
   - **Category:** Visualizer
   - **Website:** `http://localhost`
   - **Authorization Callback Domain:** `localhost`
   - If it asks for an icon, upload any picture.
2. Keep that page open: you need the **Client ID** and **Client Secret** in the next step.
3. Open the **Terminal** app and type:

   ```sh
   cd ~/Programmierisierung/site
   uv run summitbook login
   ```

   Paste the Client ID and Client Secret when asked. Your browser opens Strava: click **Authorize**.
   Your login is saved in `.strava.json` (it stays on your computer and is never published).

## Everyday use

```sh
uv run summitbook update   # download new activities from Strava and rebuild the website
uv run summitbook serve    # open the website on your computer (Ctrl+C to stop)
```

The first `update` can take a while: Strava only allows about 100 downloads every 15 minutes,
so with many tours it pauses and continues by itself. Just leave the window open.
After that, each update only downloads what's new.

## Adding tours from Suunto (or any GPX/FIT file)

1. In the Suunto app, open a workout and export it as a GPX or FIT file.
2. Put the file into a folder inside `imports/` named after the kind of tour:

   | Folder | Kind of tour |
   |---|---|
   | `imports/ski-tour/` | ski tour |
   | `imports/hike/` | hike or mountaineering |
   | `imports/snowshoe/` | snowshoe tour |
   | `imports/climb/` | climb |
   | `imports/bike/`, `imports/mtb/`, `imports/gravel/`, `imports/e-bike/` | bike rides |

   FIT files usually know their sport, so those also work directly in `imports/`.
3. Optionally rename the file to give the tour a title, e.g. `Lawinenkurs Tag 1.gpx`
   (names with dates in them, like Suunto's, are ignored).
4. Run `uv run summitbook publish` to put them online.

Imported tours get summits, multi-day trips and the 3D map like Strava tours, but no photos.
Tours already on Strava are skipped. The files themselves stay on your computer (only the
processed track is published), and a track that starts or ends at home has its first and last
500 m hidden. Delete a file to remove its tour.

## Online

The website is published with GitHub Pages. Every day at about 5 a.m. GitHub runs
`.github/workflows/update.yml`: it downloads new activities from Strava, saves them in `data/`,
and publishes the website. To update right away: on GitHub open **Actions → Update summit book →
Run workflow**.

After changing `summitbook.toml` or adding files to `imports/`, put it online with:

```sh
uv run summitbook publish
```

It gets the newest data from GitHub first, rebuilds, and uploads your changes.

GitHub logs in to Strava with three repository secrets (Settings → Secrets and variables →
Actions): `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` and `STRAVA_REFRESH_TOKEN`, copied from
`.strava.json`. Your homes are the fourth secret, `SUMMITBOOK_HOMES` (the list from
`private.toml`, e.g. `[[47.27, 11.39], [48.0, 13.6]]`).

## Your homes stay private

Your homes (where tours from home stay day trips) are in **`private.toml`**, which is never
uploaded. Tracks that start or end near a home lose their first and last kilometer, and start
points near a home are blurred to about 1 km, both on the website and in the published data.
If you change `private.toml`, also update the `SUMMITBOOK_HOMES` secret on GitHub.

Note: the repository is public, so `data/` (everything downloaded from Strava and imported,
also hikes without a summit) can be seen there. It only contains activities that are public on Strava anyway.
Strava's API terms say apps may only show your data to you, so a public summit book is
against those terms; Strava could switch off your API application.

## Settings

Everything you might want to change is in **`summitbook.toml`**: the title, which activity types
appear, how strict the summit detection is, the multi-day rules, your homes, activities to
hide or keep as day trips, and your own titles for entries. After editing it, run:

```sh
uv run summitbook build    # rebuild the website without downloading anything
```

### How things are decided

- **Summit:** your track came within 80 m of a named peak, and near it you were at most 50 m
  below the peak's height. Peaks without a known height only count if you were on top.
- **Multi-day trip:** activities on the same or the next day (one rest day in between is fine)
  that start within 500 m of where another day of the trip started or ended; by bike within
  20 km. More than 100 km from home, a day may start up to 150 km from where the day before
  ended (a transfer by train or bus), and a day whose title starts like the trip's title
  ("Georgien over and out" after "Georgien Tag 17") joins it after up to 5 days. Places within
  7 km of one of your homes never link days, and a day ending at home ends the trip, so tours
  from home stay day trips, but a trip may start or end at home (a bike tour from your door).
  Rides from home back home (commutes) aren't even downloaded.
- **Trip title:**
  1. your own Strava title: one that repeats on several days ("Georgien Tag 1", "Georgien
     Tag 2" → "Georgien"), or on trips of up to 3 days the only one you wrote (e.g.
     "Skihochtouren Übungsleiter"); automatic titles like "Morning Backcountry Ski" don't count;
  2. otherwise "2-day ski tour on the Großvenediger" if there was exactly one summit;
  3. otherwise "3-day ski tour from the Franz-Senn-Hütte", named after the hut you started from;
  4. bike trips: "4-day bike tour from Innsbruck to Trento", or "around Riva del Garda" for loops.
- **Privacy:** only activities visible to "Everyone" on Strava are used, and Strava leaves out
  your privacy zones.

## Where things are

| Path | What it is |
|---|---|
| `summitbook.toml` | your settings |
| `private.toml` | your homes (never uploaded) |
| `site/` | the website (`index.html`, `style.css`, `app.js`) |
| `site/data/` | the data the website shows (made by `update`/`build`) |
| `data/` | everything downloaded from Strava (`activities.json`) and imported (`imports.json`), with the GPS tracks |
| `imports/` | your GPX/FIT files (stay on your computer) |
| `.cache/` | mountain peaks and huts from OpenStreetMap (safe to delete) |
| `src/summitbook/` | the program |

## Credits

Activities from [Strava](https://www.strava.com). Peaks and huts © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors. Terrain from [Mapterhorn](https://mapterhorn.com/attribution). Maps by
[OpenTopoMap](https://opentopomap.org), Esri, and [MapLibre](https://maplibre.org).

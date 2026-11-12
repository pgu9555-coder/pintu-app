# Pintu NYC

The fair place to meet in New York. Everyone adds where they're coming from;
Pintu finds the subway stop where nobody's trip is long, the group swipes on
places nearby, and the bill gets split with NYC tax, tip and Venmo links.

Plain HTML/CSS/JS — no build step. Open it from any static web server.

## What's here

| Path | What it is |
|---|---|
| `index.html`, `css/app.css`, `js/app.js` | The app |
| `js/subway.js` | Travel-time engine: walk + wait + ride + transfers, fairest-stop ranking |
| `js/split.js` | Bill math in integer cents (always adds up exactly) |
| `js/places.js` | Free address search (Nominatim) and nearby places (Overpass), both OpenStreetMap |
| `js/store.js` | Supabase real-time rooms, or local mode when no keys are set |
| `js/config.js` | Your Supabase URL and anon key |
| `data/subway.json` | Station graph built from MTA schedules (57 KB) |
| `data/venues.json` | Places to eat within ~10 min of each station (NYC DOHMH data) |
| `scripts/build_venues.py` | Rebuilds `data/venues.json` from NYC Open Data |
| `tests/run.js` | Travel-time, ranking and bill-split tests: `node nyc/tests/run.js` |
| `scripts/build_subway.py` | Rebuilds `data/subway.json` from the MTA GTFS feed |
| `supabase/schema.sql` | Tables, access policies and realtime setup |
| `vendor/` | Leaflet 1.9.4 and supabase-js 2.45.4 (so nothing loads from a CDN) |

## Run it locally

```bash
cd nyc
python3 -m http.server 8000
# open http://localhost:8000
```

With `js/config.js` empty it runs in **local mode**: rooms live in that one
browser, and tabs of it sync live — fine for a demo.

## Turn on real-time rooms (Supabase)

1. Create a free project at supabase.com.
2. SQL Editor → New query → paste `supabase/schema.sql` → Run.
3. Project Settings → API → copy the **Project URL** and the **anon public** key
   into `js/config.js`.

Rooms work like a shared link: anyone with the 6-character code can read and
edit that room, without signing in. That's the same trade-off as the Chinese
version's open `rooms` collection; add Supabase Auth later if you need more.

## Deploy

Any static host works. Fastest: drag the `nyc` folder onto
https://app.netlify.com/drop. Vercel, Cloudflare Pages and GitHub Pages also work.

## Refresh the subway data

MTA publishes new schedules a few times a year (current data is valid through
the date shown in the app footer).

```bash
curl -O https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip
unzip gtfs_subway.zip -d gtfs
python3 nyc/scripts/build_subway.py gtfs nyc/data/subway.json
```

## How "fair" is calculated

For each person, Pintu finds the fastest trip to every station: walk to a
nearby station, wait (half the line's midday headway plus a minute), ride,
and transfer (MTA transfer walking time plus the next line's wait). Short
trips may be walked instead.

Then Pintu looks for stops that are fair **and** worth going to:

1. Find the fairest possible stop (shortest longest-trip in the group).
2. Keep stops whose longest trip is within 5 minutes of that (widening to
   10, 15, 25 if needed) and that have at least 40 places to eat nearby.
3. Rank those by liveliness — more places is better, but past 150 a stop
   is "lively enough" — minus about one step per 7 extra minutes.
4. Keep the top three at least 900 m apart so they're different neighborhoods.

So two friends in LIC and Forest Hills get Jackson Heights, not a quiet
stop that happens to be a minute fairer, and not Midtown. Without
`data/venues.json` the app falls back to time-only ranking. Times are
schedule-based estimates, not live service.

## Refresh the restaurant counts

```bash
python3 nyc/scripts/build_venues.py nyc/data/subway.json nyc/data/venues.json
```

Needs network access to data.cityofnewyork.us.

## Data and credits

- Subway schedules: MTA GTFS (public).
- Restaurant counts: NYC DOHMH Restaurant Inspection Results (NYC Open Data).
- Map tiles: © OpenStreetMap contributors © CARTO.
- Addresses and places: OpenStreetMap via Nominatim and Overpass. Both are
  free, rate-limited public services; switch to a paid provider (or your own
  instance) before heavy traffic.

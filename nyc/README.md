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
trips may be walked instead. Stations are ranked by the **longest** trip in
the group, then by total time, and the top three are kept at least 900 m
apart so they're different neighborhoods. Times are schedule-based
estimates, not live service.

## Data and credits

- Subway schedules: MTA GTFS (public).
- Map tiles: © OpenStreetMap contributors © CARTO.
- Addresses and places: OpenStreetMap via Nominatim and Overpass. Both are
  free, rate-limited public services; switch to a paid provider (or your own
  instance) before heavy traffic.

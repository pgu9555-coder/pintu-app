#!/usr/bin/env python3
"""Build nyc/data/venues.json: how many places to eat are near each station.

Source: NYC DOHMH Restaurant Inspection Results (NYC Open Data, dataset
43nn-pn8j), which lists every food service establishment the city
inspects — restaurants, cafés, bars that serve food — with coordinates
and cuisine. Only places inspected in the last ~3 years are counted, as a
proxy for "still open".

Usage:
    python3 nyc/scripts/build_venues.py nyc/data/subway.json nyc/data/venues.json
    python3 nyc/scripts/build_venues.py nyc/data/subway.json nyc/data/venues.json --from-file rows.json

Output:
  { "source": ..., "generated": "YYYY-MM-DD", "radiusM": 600, "count": N,
    "stations": { "<GTFS station id>": [places, cuisines, ["Top", "cuisine", "list"]] } }

Only the Python standard library is needed.
"""
import datetime
import json
import math
import os
import sys
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

DATASET = "https://data.cityofnewyork.us/resource/43nn-pn8j.json"
RADIUS_M = 600          # ~10 minutes' walk on the street grid
SINCE_YEARS = 3
PAGE = 50000
# Not meaningful as "a place to hang out".
SKIP_CUISINES = {"Bottled Beverages", "Not Listed/Not Applicable", ""}


def fetch_rows():
    since = (datetime.date.today() - datetime.timedelta(days=365 * SINCE_YEARS)).isoformat()
    rows, offset = [], 0
    while True:
        params = {
            "$select": "camis,dba,cuisine_description,latitude,longitude,max(inspection_date) as last",
            "$where": f"latitude > 40 AND longitude < -73 AND inspection_date > '{since}'",
            "$group": "camis,dba,cuisine_description,latitude,longitude",
            "$order": "camis",
            "$limit": str(PAGE),
            "$offset": str(offset),
        }
        url = DATASET + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "pintu-nyc-build"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            page = json.load(resp)
        rows.extend(page)
        print(f"  fetched {len(rows)} rows", file=sys.stderr)
        if len(page) < PAGE:
            return rows
        offset += PAGE


def haversine_m(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = (math.sin((lat2 - lat1) * r / 2) ** 2 +
         math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(a))


def clean(rows):
    """One entry per establishment (camis), with float coordinates."""
    seen = {}
    for r in rows:
        try:
            lat, lon = float(r["latitude"]), float(r["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        cuisine = (r.get("cuisine_description") or "").strip()
        if not (40.4 < lat < 41.0 and -74.3 < lon < -73.6) or cuisine in SKIP_CUISINES:
            continue
        seen[r["camis"]] = (lat, lon, cuisine)
    return list(seen.values())


def build(stations, places):
    # Bucket places on a ~0.01° grid so each station only checks its neighbors.
    grid = defaultdict(list)
    for p in places:
        grid[(int(p[0] * 100), int(p[1] * 100))].append(p)
    out = {}
    for sid, _name, lat, lon in stations:
        gi, gj = int(lat * 100), int(lon * 100)
        near = [p for di in (-1, 0, 1) for dj in (-1, 0, 1) for p in grid[(gi + di, gj + dj)]
                if haversine_m(lat, lon, p[0], p[1]) <= RADIUS_M]
        cuisines = Counter(p[2] for p in near)
        top = [c for c, _ in cuisines.most_common(6) if c not in ("American", "Coffee/Tea")][:3]
        out[sid] = [len(near), len(cuisines), top]
    return out


def main(argv):
    if len(argv) not in (3, 5) or (len(argv) == 5 and argv[3] != "--from-file"):
        sys.exit(__doc__)
    subway_path, out_path = argv[1], argv[2]
    with open(subway_path, encoding="utf-8") as f:
        stations = json.load(f)["stations"]
    if len(argv) == 5:
        with open(argv[4], encoding="utf-8") as f:
            rows = json.load(f)
    else:
        rows = fetch_rows()
    places = clean(rows)
    if len(places) < 1000 and len(argv) == 3:
        sys.exit(f"Only {len(places)} places came back — the dataset or query probably changed. Not writing output.")
    data = {
        "source": "NYC DOHMH Restaurant Inspection Results (NYC Open Data 43nn-pn8j)",
        "generated": datetime.date.today().isoformat(),
        "radiusM": RADIUS_M,
        "count": len(places),
        "stations": build(stations, places),
    }
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
    counts = sorted(v[0] for v in data["stations"].values())
    print(f"places={len(places)} stations={len(counts)} median_nearby={counts[len(counts)//2]} "
          f"max_nearby={counts[-1]} -> {out_path} ({os.path.getsize(out_path)//1024} KB)")


if __name__ == "__main__":
    main(sys.argv)

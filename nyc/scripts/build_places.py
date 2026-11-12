#!/usr/bin/env python3
"""Build nyc/data/places/<station id>.json: the places to eat near each stop.

The food swipe screen reads these files from our own domain, so it never
depends on a public OpenStreetMap Overpass server being up.

Source: NYC DOHMH Restaurant Inspection Results (NYC Open Data, dataset
43nn-pn8j). Only places inspected in the last ~2 years are kept, as a proxy
for "still open"; each keeps its most recent letter grade.

Usage:
    python3 nyc/scripts/build_places.py nyc/data/subway.json nyc/data/places

Each file: {"s": "<station id>", "g": "YYYY-MM-DD",
            "p": [[camis, name, cuisine, address, grade, lat, lon, meters], ...]}
nearest first, at most MAX_PER_STOP places within RADIUS_M.
Only the Python standard library is needed.
"""
import datetime
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict

DATASET = "https://data.cityofnewyork.us/resource/43nn-pn8j.json"
RADIUS_M = 600
MAX_PER_STOP = 80
SINCE_YEARS = 2
PAGE = 50000
# The swipe deck is for sitting down together, so skip drink/snack counters,
# big fast-food chains and venues whose kitchen isn't the point.
SKIP_CUISINES = {"Bottled Beverages", "Not Listed/Not Applicable", "", "Coffee/Tea",
                 "Juice, Smoothies, Fruit Salads", "Donuts", "Frozen Desserts", "Nuts/Confectionary",
                 "Hotdogs/Pretzels", "Fruits/Vegetables"}
SKIP_NAME = re.compile(r"\b(starbucks|dunkin|mcdonald|subway|burger king|wendy'?s|popeyes|kfc|kentucky fried|"
                       r"domino'?s|papa john|pizza hut|taco bell|white castle|7-eleven|duane reade|cvs|"
                       r"theat(er|re)|cinema|stadium|regal|amc|hospital|school|university|college|"
                       r"hotel|airport|church|catering|cafeteria|employee|gym|club house)\b", re.I)
SMALL = {"and", "of", "the", "de", "la", "del", "a", "on", "at", "in"}


def query(params):
    rows, offset = [], 0
    while True:
        p = dict(params, **{"$limit": str(PAGE), "$offset": str(offset), "$order": "camis"})
        url = DATASET + "?" + urllib.parse.urlencode(p)
        req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "pintu-nyc-build"})
        for attempt in range(4):  # the open data API sometimes answers 503
            try:
                with urllib.request.urlopen(req, timeout=180) as resp:
                    page = json.load(resp)
                break
            except urllib.error.HTTPError as e:
                if e.code < 500 or attempt == 3:
                    raise
                time.sleep(5 * (attempt + 1))
        rows.extend(page)
        print(f"  fetched {len(rows)} rows", file=sys.stderr)
        if len(page) < PAGE:
            return rows
        offset += PAGE


def title(s):
    """DOHMH names and streets are ALL CAPS; make them readable."""
    s = re.sub(r"\s+", " ", (s or "").strip())
    if not s:
        return s
    if s != s.upper():
        return s
    words = []
    for i, w in enumerate(s.lower().split(" ")):
        if i and w in SMALL:
            words.append(w)
        elif re.fullmatch(r"\d+(st|nd|rd|th)", w):
            words.append(w)
        else:
            words.append(w.upper() if re.fullmatch(r"(ii|iii|iv|vi|vii|nyc|bbq|usa)", w) else "-".join(x[:1].upper() + x[1:] for x in w.split("-")))
    out = " ".join(words)
    out = re.sub(r"'S\b", "'s", out)
    return re.sub(r"\bMc([a-z])", lambda m: "Mc" + m.group(1).upper(), out)


def haversine_m(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = (math.sin((lat2 - lat1) * r / 2) ** 2 +
         math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(a))


def main(argv):
    if len(argv) != 3:
        sys.exit(__doc__)
    with open(argv[1], encoding="utf-8") as f:
        stations = json.load(f)["stations"]
    out_dir = argv[2]
    since = (datetime.date.today() - datetime.timedelta(days=365 * SINCE_YEARS)).isoformat()
    where = f"latitude > 40 AND longitude < -73 AND inspection_date > '{since}'"
    rows = query({
        "$select": "camis,dba,cuisine_description,building,street,latitude,longitude,max(inspection_date) as last",
        "$where": where,
        "$group": "camis,dba,cuisine_description,building,street,latitude,longitude",
    })
    grades = query({
        "$select": "camis,grade,max(grade_date) as gd",
        "$where": where + " AND grade IN ('A','B','C')",
        "$group": "camis,grade",
    })
    latest = {}
    for g in grades:
        if g["camis"] not in latest or g["gd"] > latest[g["camis"]][1]:
            latest[g["camis"]] = (g["grade"], g["gd"])

    places = {}
    for r in rows:
        try:
            lat, lon = float(r["latitude"]), float(r["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        cuisine = (r.get("cuisine_description") or "").strip()
        if not (40.4 < lat < 41.0 and -74.3 < lon < -73.6) or cuisine in SKIP_CUISINES or not r.get("dba") \
                or SKIP_NAME.search(r["dba"]):
            continue
        prev = places.get(r["camis"])
        if prev and prev["last"] >= r["last"]:
            continue
        addr = " ".join(x for x in (r.get("building", "").strip(), title(r.get("street"))) if x)
        places[r["camis"]] = {"last": r["last"], "row": [int(r["camis"]), title(r["dba"]), cuisine, addr,
                                                         latest.get(r["camis"], ("",))[0], round(lat, 5), round(lon, 5)]}
    places = [p["row"] for p in places.values()]
    if len(places) < 4000:
        sys.exit(f"Only {len(places)} places came back; the dataset or query probably changed. Not writing output.")

    grid = defaultdict(list)
    for p in places:
        grid[(int(p[5] * 100), int(p[6] * 100))].append(p)
    os.makedirs(out_dir, exist_ok=True)
    today = datetime.date.today().isoformat()
    sizes = []
    for sid, _name, lat, lon in stations:
        gi, gj = int(lat * 100), int(lon * 100)
        near = []
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for p in grid[(gi + di, gj + dj)]:
                    m = haversine_m(lat, lon, p[5], p[6])
                    if m <= RADIUS_M:
                        near.append(p + [round(m)])
        near.sort(key=lambda p: p[7])
        path = os.path.join(out_dir, f"{sid}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"s": sid, "g": today, "p": near[:MAX_PER_STOP]}, f, separators=(",", ":"), ensure_ascii=False)
        sizes.append(len(near))
    sizes.sort()
    print(f"places={len(places)} stops={len(sizes)} median_nearby={sizes[len(sizes)//2]} -> {out_dir}")


if __name__ == "__main__":
    main(sys.argv)

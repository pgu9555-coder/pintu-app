#!/usr/bin/env python3
"""Build nyc/data/fun/<station id>.json: things to do near each stop after dinner.

Source: OpenStreetMap (Overpass) - bars, karaoke, bowling, billiards,
arcades, escape rooms, mini golf, comedy clubs, live music and cinemas -
plus each place's own share photo and booking link from its website
(same checks as build_extras.py). Needs open internet, so it runs in
GitHub Actions (.github/workflows/places-data.yml).

Rows use the same 12 fields as data/places, with the activity type in the
cuisine slot and the OSM id in the first slot:
  [osmid, name, type, address, "", lat, lon, meters, hours, website, image, bookUrl]

Usage:
    python3 nyc/scripts/build_fun.py nyc/data/subway.json nyc/data/fun
"""
import concurrent.futures as cf
import datetime
import re
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_extras import OVERPASS, NYC_BBOX, UA, BOOKING, clean_url, haversine_m, log, norm_key, site_info  # noqa: E402
from build_places import title  # noqa: E402

RADIUS_M = 800          # a little farther than food: people walk further for a night out
PER_TYPE = 15

# (type shown in the app, Overpass filter). Order matters: first match wins.
TYPES = [
    ("Karaoke", '["amenity"="karaoke_box"]'),
    ("Karaoke", '["karaoke"="yes"]["amenity"~"^(bar|pub|nightclub|restaurant)$"]'),
    ("Escape room", '["leisure"="escape_game"]'),
    ("Bowling", '["leisure"="bowling_alley"]'),
    ("Billiards", '["sport"="billiards"]'),
    ("Arcade", '["leisure"="amusement_arcade"]'),
    ("Mini golf", '["leisure"="miniature_golf"]'),
    ("Comedy", '["amenity"~"^(theatre|nightclub|bar)$"]["theatre:genre"="comedy"]'),
    ("Comedy", '["amenity"="comedy_club"]'),
    ("Live music", '["amenity"="music_venue"]'),
    ("Live music", '["live_music"="yes"]["amenity"~"^(bar|pub|nightclub)$"]'),
    ("Cinema", '["amenity"="cinema"]'),
    ("Club", '["amenity"="nightclub"]'),
    ("Bar", '["amenity"~"^(bar|pub|biergarten)$"]'),
]


def overpass_fun():
    parts = "".join(f"nwr{f}[\"name\"]({NYC_BBOX});" for _, f in TYPES)
    q = f"[out:json][timeout:300];({parts});out center tags;"
    body = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for attempt in range(3):
        for url in OVERPASS:
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=360) as r:
                    els = json.load(r)["elements"]
                if len(els) > 1000:
                    log(f"overpass: {len(els)} fun places from {url}")
                    return els
                last = f"only {len(els)} elements"
            except Exception as e:  # noqa: BLE001
                last = e
                log(f"overpass {url} failed: {e}")
        time.sleep(30)
    sys.exit(f"Overpass unavailable: {last}")


# Names that say what a place is, for places tagged only as a bar or restaurant.
NAME_TYPES = [
    (re.compile(r"karaoke|\bktv\b|noraebang|sing ?sing", re.I), "Karaoke"),
    (re.compile(r"escape (room|game)s?|\bescape\b.*\broom", re.I), "Escape room"),
    (re.compile(r"comedy", re.I), "Comedy"),
    (re.compile(r"bowling|bowlero|bowlmor|brooklyn bowl|lucky strike|frames bowl", re.I), "Bowling"),
    (re.compile(r"billiard|pool hall|pool room", re.I), "Billiards"),
    (re.compile(r"barcade|dave ?& ?buster|round ?1\b|\barcade\b(?!.*(bakery|cafe|kitchen|restaurant|deli|pizza))", re.I), "Arcade"),
    (re.compile(r"mini ?golf|\bputt(-| )?(putt|shack)\b", re.I), "Mini golf"),
]


def type_from_name(name):
    for rx, kind in NAME_TYPES:
        if rx.search(name or ""):
            return kind
    return ""


def dohmh_fun():
    """Karaoke bars, comedy clubs, bowling alleys... that serve food, so the city inspects them."""
    since = (datetime.date.today() - datetime.timedelta(days=730)).isoformat()
    like = " OR ".join(f"upper(dba) like '%{k}%'" for k in
                       ("KARAOKE", "KTV", "COMEDY", "BOWLING", "BOWLERO", "BOWLMOR", "BROOKLYN BOWL", "LUCKY STRIKE",
                        "BILLIARD", "POOL HALL", "BARCADE", "ARCADE", "DAVE & BUSTER", "ESCAPE", "MINI GOLF", "PUTT"))
    params = {"$select": "camis,dba,building,street,latitude,longitude",
              "$where": f"({like}) AND latitude > 40 AND inspection_date > '{since}'",
              "$group": "camis,dba,building,street,latitude,longitude", "$limit": "5000"}
    url = "https://data.cityofnewyork.us/resource/43nn-pn8j.json?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            log(f"DOHMH fun query failed: {e}")
            time.sleep(10 * (attempt + 1))
    return []


def type_of(t):
    named = type_from_name(t.get("name"))
    if named:
        return named
    a, leisure = t.get("amenity", ""), t.get("leisure", "")
    if a == "karaoke_box" or (t.get("karaoke") == "yes" and a in ("bar", "pub", "nightclub", "restaurant")):
        return "Karaoke"
    if leisure == "escape_game":
        return "Escape room"
    if leisure == "bowling_alley":
        return "Bowling"
    if t.get("sport") == "billiards":
        return "Billiards"
    if leisure == "amusement_arcade":
        return "Arcade"
    if leisure == "miniature_golf":
        return "Mini golf"
    if t.get("theatre:genre") == "comedy" or a == "comedy_club":
        return "Comedy"
    if a == "music_venue" or (t.get("live_music") == "yes" and a in ("bar", "pub", "nightclub")):
        return "Live music"
    if a == "cinema":
        return "Cinema"
    if a == "nightclub":
        return "Club"
    if a in ("bar", "pub", "biergarten"):
        return "Bar"
    return ""


def address(t):
    return " ".join(x for x in (t.get("addr:housenumber", ""), t.get("addr:street", "")) if x)


def main(argv):
    if len(argv) != 3:
        sys.exit(__doc__)
    with open(argv[1], encoding="utf-8") as f:
        stations = json.load(f)["stations"]
    out_dir = argv[2]
    places, seen = [], set()
    for e in overpass_fun():
        t = e.get("tags", {})
        lat = e.get("lat") or (e.get("center") or {}).get("lat")
        lon = e.get("lon") or (e.get("center") or {}).get("lon")
        kind = type_of(t)
        if lat is None or not kind or not t.get("name"):
            continue
        key = (norm_key(t["name"]), round(lat, 3), round(lon, 3))
        if key in seen:
            continue
        seen.add(key)
        site = clean_url(t.get("website") or t.get("contact:website") or t.get("url"))
        book = clean_url(t.get("reservation:url") or "")
        if not book and BOOKING.search(site):
            book = site
        places.append([e["type"][0] + str(e["id"]), t["name"].strip(), kind, address(t), "", round(lat, 5), round(lon, 5),
                       0, (t.get("opening_hours") or "").strip()[:200], site, "", book])
    # Add city-inspected venues OpenStreetMap is missing (same name within ~100 m = same place).
    added = 0
    for r in dohmh_fun():
        kind = type_from_name(r.get("dba"))
        try:
            lat, lon = float(r["latitude"]), float(r["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        if not kind or not (40.4 < lat < 41.0):
            continue
        name = title(r["dba"])
        if any(norm_key(p[1]) == norm_key(name) and haversine_m(lat, lon, p[5], p[6]) < 100 for p in places):
            continue
        addr = " ".join(x for x in (r.get("building", "").strip(), title(r.get("street"))) if x)
        places.append(["d" + r["camis"], name, kind, addr, "", round(lat, 5), round(lon, 5), 0, "", "", "", ""])
        added += 1
    log(f"added {added} venues from NYC inspection data")
    log(f"{len(places)} fun places; by type: " +
        ", ".join(f"{k}={sum(1 for p in places if p[2] == k)}" for k in dict.fromkeys(k for k, _ in TYPES)))
    if len(places) < 800:
        sys.exit("Too few places came back; the query probably failed. Not writing output.")

    sites = sorted({p[9] for p in places if p[9]})
    info = {}
    with cf.ThreadPoolExecutor(max_workers=32) as pool:
        for site, got in zip(sites, pool.map(site_info, sites)):
            info[site] = got
    owners = defaultdict(set)
    for p in places:
        img = info.get(p[9], ("", ""))[0]
        if img:
            owners[img.split("?")[0]].add(norm_key(p[1]))
    for p in places:
        img, book = info.get(p[9], ("", ""))
        p[10] = img if img and len(owners[img.split("?")[0]]) < 3 else ""
        p[11] = p[11] or book

    grid = defaultdict(list)
    for p in places:
        grid[(int(p[5] * 100), int(p[6] * 100))].append(p)
    os.makedirs(out_dir, exist_ok=True)
    for sid, _name, lat, lon in stations:
        gi, gj = int(lat * 100), int(lon * 100)
        near = []
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for p in grid[(gi + di, gj + dj)]:
                    m = haversine_m(lat, lon, p[5], p[6])
                    if m <= RADIUS_M:
                        near.append(p[:7] + [round(m)] + p[8:])
        near.sort(key=lambda p: p[7])
        kept, per = [], defaultdict(int)
        for p in near:
            if per[p[2]] < PER_TYPE:
                per[p[2]] += 1
                kept.append(p)
        with open(os.path.join(out_dir, f"{sid}.json"), "w", encoding="utf-8") as f:
            json.dump({"s": sid, "p": kept}, f, separators=(",", ":"), ensure_ascii=False)
    print(json.dumps({"fun": len(places), "photo": sum(1 for p in places if p[10]),
                      "hours": sum(1 for p in places if p[8])}))


if __name__ == "__main__":
    main(sys.argv)

#!/usr/bin/env python3
"""Build nyc/data/subway.json from the MTA subway GTFS feed.

Usage:
    curl -O https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip
    unzip gtfs_subway.zip -d gtfs
    python3 nyc/scripts/build_subway.py gtfs nyc/data/subway.json

The output is a compact graph the browser uses to compute door-to-door
subway times between any two stations:

  stations  [[id, name, lat, lon], ...]
  routes    [[id, label, color, textColor, waitSec], ...]
  edges     [[fromStation, toStation, route, seconds], ...]   one ride hop
  transfers [[fromStation, toStation, seconds], ...]          walking between
            lines (same station: line change; different stations: passageway)

Times are medians of weekday trips that depart between 06:00 and 22:00.
waitSec is the expected wait when boarding: half the typical midday
(10:00-16:00) headway of the line plus one minute, between 2 and 15 min.
Only the Python standard library is needed.
"""
import csv
import json
import os
import statistics
import sys
from collections import defaultdict

# Express / shuttle variants that riders treat as the same line.
ROUTE_ALIAS = {"FX": "F", "6X": "6", "7X": "7"}
SERVICE = "Weekday"
RIDE_WINDOW = (6 * 3600, 22 * 3600)
HEADWAY_WINDOW = (10 * 3600, 16 * 3600)
MAX_WAIT = 15 * 60
WAIT_BUFFER = 60
WAIT_FLOOR = 120
DEFAULT_TRANSFER = 180

# The Staten Island Ferry is not in the subway feed but is the only way
# off Staten Island by transit, so add it by hand (25 min ride, boats
# every 30 min at midday -> ~15 min expected wait).
FERRY = {"id": "FERRY", "label": "Ferry", "color": "F7A51E", "text": "1A1A1A",
         "wait": 15 * 60, "ride": 25 * 60,
         "links": [("S31", "142"), ("S31", "R27")]}


def secs(hms):
    h, m, s = (int(x) for x in hms.split(":"))
    return h * 3600 + m * 60 + s


def read(gtfs, name):
    with open(os.path.join(gtfs, name), newline="", encoding="utf-8-sig") as f:
        yield from csv.DictReader(f)


def main(gtfs, out_path):
    # --- stations (parent stops) -------------------------------------
    parent_of, stations = {}, {}
    for r in read(gtfs, "stops.txt"):
        if r["location_type"] == "1":
            stations[r["stop_id"]] = (r["stop_name"], float(r["stop_lat"]), float(r["stop_lon"]))
            parent_of[r["stop_id"]] = r["stop_id"]
        elif r["parent_station"]:
            parent_of[r["stop_id"]] = r["parent_station"]

    # --- routes ------------------------------------------------------
    route_meta = {}
    for r in read(gtfs, "routes.txt"):
        rid = ROUTE_ALIAS.get(r["route_id"], r["route_id"])
        if rid in route_meta:
            continue
        label = r["route_short_name"] or rid
        route_meta[rid] = (label, r["route_color"] or "808183", r["route_text_color"] or "FFFFFF")

    trip_route, trip_dir = {}, {}
    for r in read(gtfs, "trips.txt"):
        if r["service_id"] == SERVICE:
            trip_route[r["trip_id"]] = ROUTE_ALIAS.get(r["route_id"], r["route_id"])
            trip_dir[r["trip_id"]] = r["direction_id"]

    # --- stop_times: ride hops and headways ---------------------------
    hop_times = defaultdict(list)                 # (route, a, b) -> [sec]
    deps = defaultdict(int)                       # (route, dir, stop) -> count in headway window
    cur_trip, prev = None, None
    for r in read(gtfs, "stop_times.txt"):
        tid = r["trip_id"]
        if tid not in trip_route:
            continue
        if tid != cur_trip:
            cur_trip, prev = tid, None
        st = parent_of.get(r["stop_id"])
        arr, dep = secs(r["arrival_time"]), secs(r["departure_time"])
        route = trip_route[tid]
        if HEADWAY_WINDOW[0] <= dep < HEADWAY_WINDOW[1]:
            deps[(route, trip_dir[tid], st)] += 1
        if prev and prev[0] != st and RIDE_WINDOW[0] <= prev[1] < RIDE_WINDOW[1]:
            hop_times[(route, prev[0], st)].append(max(30, arr - prev[1]))
        prev = (st, dep)

    # Headway per route: busiest stop per direction, averaged over directions.
    best = defaultdict(int)
    for (route, d, _st), n in deps.items():
        best[(route, d)] = max(best[(route, d)], n)
    per_route = defaultdict(list)
    for (route, _d), n in best.items():
        per_route[route].append(n)
    wait = {}
    window = HEADWAY_WINDOW[1] - HEADWAY_WINDOW[0]
    for route in route_meta:
        counts = per_route.get(route)
        if counts:
            headway = window / (sum(counts) / len(counts))
            # Half the scheduled headway, plus a minute for real-world
            # irregularity; never less than two minutes.
            wait[route] = int(min(MAX_WAIT, max(WAIT_FLOOR, headway / 2 + WAIT_BUFFER)))
        else:
            wait[route] = MAX_WAIT  # no midday weekday service (e.g. rush-only)

    # --- assemble ------------------------------------------------------
    used = sorted({k[1] for k in hop_times} | {k[2] for k in hop_times})
    for a, b in FERRY["links"]:
        used += [s for s in (a, b) if s not in used]
    sidx = {s: i for i, s in enumerate(used)}

    route_ids = sorted({k[0] for k in hop_times}) + [FERRY["id"]]
    ridx = {r: i for i, r in enumerate(route_ids)}

    routes_out = []
    for rid in route_ids:
        if rid == FERRY["id"]:
            routes_out.append([rid, FERRY["label"], FERRY["color"], FERRY["text"], FERRY["wait"]])
        else:
            label, color, text = route_meta[rid]
            routes_out.append([rid, label, color, text, wait[rid]])

    edges = [[sidx[a], sidx[b], ridx[r], int(statistics.median(t))]
             for (r, a, b), t in sorted(hop_times.items())]
    for a, b in FERRY["links"]:
        edges.append([sidx[a], sidx[b], ridx[FERRY["id"]], FERRY["ride"]])
        edges.append([sidx[b], sidx[a], ridx[FERRY["id"]], FERRY["ride"]])

    transfers = {}
    for r in read(gtfs, "transfers.txt"):
        a, b = r["from_stop_id"], r["to_stop_id"]
        if a in sidx and b in sidx:
            t = int(r["min_transfer_time"] or DEFAULT_TRANSFER)
            transfers[(sidx[a], sidx[b])] = t
    for s in used:  # every station allows changing lines in place
        transfers.setdefault((sidx[s], sidx[s]), DEFAULT_TRANSFER)
    for a, b in FERRY["links"]:  # terminal walk
        transfers.setdefault((sidx[a], sidx[a]), DEFAULT_TRANSFER)

    stations_out = [[s, stations[s][0], round(stations[s][1], 6), round(stations[s][2], 6)] for s in used]

    feed = next(read(gtfs, "calendar.txt"))
    out = {
        "source": "MTA NYCT subway GTFS (rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip)",
        "validFrom": feed["start_date"],
        "validTo": feed["end_date"],
        "stations": stations_out,
        "routes": routes_out,
        "edges": edges,
        "transfers": [[a, b, t] for (a, b), t in sorted(transfers.items())],
    }
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    print(f"stations={len(stations_out)} routes={len(routes_out)} edges={len(edges)} "
          f"transfers={len(out['transfers'])} -> {out_path} ({os.path.getsize(out_path)//1024} KB)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])

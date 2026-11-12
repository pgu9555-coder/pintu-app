#!/usr/bin/env python3
"""Build nyc/data/subway.json from the MTA subway GTFS feed.

Usage:
    curl -O https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip
    unzip gtfs_subway.zip -d gtfs
    python3 nyc/scripts/build_subway.py gtfs nyc/data/subway.json

The output is a compact graph the browser uses to compute door-to-door
subway times between any two stations:

  stations  [[id, name, lat, lon], ...]
  routes    [[id, label, color, textColor], ...]
  edges     [[fromStation, toStation, route], ...]           one ride hop
  transfers [[fromStation, toStation, seconds], ...]          walking between
            lines (same station: line change; different stations: passageway)
  periods   [{id, label, wait: [sec per route], sec: [sec per edge]}, ...]
            per time period (weekday/Saturday/Sunday day and evening, late
            night). wait = expected wait when boarding (half the headway in
            that period plus a minute, 2-20 min); 0 = line not running.
            sec = median ride time of the hop; 0 = no service in that period.
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

# Time periods riders can pick. Each uses one GTFS service and a window of
# departure times (seconds after midnight; GTFS times can exceed 24:00 for
# trips after midnight, so the night window covers both 00-05 and 24-29).
PERIODS = [
    # id,          label,                service,    windows
    ("wkday_day", "Weekday daytime",     "Weekday",  [(7, 19)]),
    ("wkday_eve", "Weekday evening",     "Weekday",  [(19, 24)]),
    ("sat_day",   "Saturday daytime",    "Saturday", [(9, 19)]),
    ("sat_eve",   "Saturday evening",    "Saturday", [(19, 24)]),
    ("sun_day",   "Sunday daytime",      "Sunday",   [(9, 19)]),
    ("sun_eve",   "Sunday evening",      "Sunday",   [(19, 24)]),
    ("night",     "Late night",          "Weekday",  [(0, 5), (24, 29)]),
]
DEFAULT_PERIOD = "wkday_day"
MAX_WAIT = 20 * 60
WAIT_BUFFER = 60
WAIT_FLOOR = 120
DEFAULT_TRANSFER = 180

# The Staten Island Ferry is not in the subway feed but is the only way
# off Staten Island by transit, so add it by hand: 25 min ride, boats
# every 30 min (hourly late at night).
FERRY = {"id": "FERRY", "label": "Ferry", "color": "F7A51E", "text": "1A1A1A", "ride": 25 * 60,
         "wait": {"night": 30 * 60}, "default_wait": 15 * 60,
         "links": [("S31", "142"), ("S31", "R27")]}


def secs(hms):
    h, m, s = (int(x) for x in hms.split(":"))
    return h * 3600 + m * 60 + s


def in_windows(t, windows):
    return any(a * 3600 <= t < b * 3600 for a, b in windows)


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
        if rid not in route_meta:
            route_meta[rid] = (r["route_short_name"] or rid, r["route_color"] or "808183", r["route_text_color"] or "FFFFFF")

    services = {p[2] for p in PERIODS}
    trip_info = {}
    for r in read(gtfs, "trips.txt"):
        if r["service_id"] in services:
            trip_info[r["trip_id"]] = (ROUTE_ALIAS.get(r["route_id"], r["route_id"]), r["direction_id"], r["service_id"])

    period_by_service = defaultdict(list)
    for pid, _label, service, windows in PERIODS:
        period_by_service[service].append((pid, windows))

    # --- stop_times: ride hops and departures per period -------------
    hop_times = defaultdict(list)   # (period, route, a, b) -> [sec]
    deps = defaultdict(int)         # (period, route, dir, stop) -> departures in window
    cur_trip, prev = None, None
    for r in read(gtfs, "stop_times.txt"):
        tid = r["trip_id"]
        info = trip_info.get(tid)
        if not info:
            continue
        if tid != cur_trip:
            cur_trip, prev = tid, None
        route, direction, service = info
        st = parent_of.get(r["stop_id"])
        arr, dep = secs(r["arrival_time"]), secs(r["departure_time"])
        for pid, windows in period_by_service[service]:
            if in_windows(dep, windows):
                deps[(pid, route, direction, st)] += 1
            if prev and prev[0] != st and in_windows(prev[1], windows):
                hop_times[(pid, route, prev[0], st)].append(max(30, arr - prev[1]))
        prev = (st, dep)

    # Expected wait per (period, route): busiest stop per direction, averaged.
    best = defaultdict(int)
    for (pid, route, d, _st), n in deps.items():
        best[(pid, route, d)] = max(best[(pid, route, d)], n)
    per = defaultdict(list)
    for (pid, route, _d), n in best.items():
        per[(pid, route)].append(n)

    def wait_for(pid, route, windows):
        counts = per.get((pid, route))
        if not counts or sum(counts) / len(counts) < 2:
            return 0  # not running (or a handful of trips) in this period
        length = sum(b - a for a, b in windows) * 3600
        if pid == "night":
            length /= 2  # the two night windows describe the same 5 hours
        headway = length / (sum(counts) / len(counts))
        return int(min(MAX_WAIT, max(WAIT_FLOOR, headway / 2 + WAIT_BUFFER)))

    # --- assemble ------------------------------------------------------
    edge_keys = sorted({(r, a, b) for (_p, r, a, b) in hop_times})
    used = sorted({k[1] for k in edge_keys} | {k[2] for k in edge_keys})
    for a, b in FERRY["links"]:
        used += [s for s in (a, b) if s not in used]
    sidx = {s: i for i, s in enumerate(used)}
    route_ids = sorted({k[0] for k in edge_keys}) + [FERRY["id"]]
    ridx = {r: i for i, r in enumerate(route_ids)}

    routes_out = []
    for rid in route_ids:
        if rid == FERRY["id"]:
            routes_out.append([rid, FERRY["label"], FERRY["color"], FERRY["text"]])
        else:
            label, color, text = route_meta[rid]
            routes_out.append([rid, label, color, text])

    ferry_edges = []
    for a, b in FERRY["links"]:
        ferry_edges += [(FERRY["id"], a, b), (FERRY["id"], b, a)]
    all_edges = edge_keys + ferry_edges
    edges_out = [[sidx[a], sidx[b], ridx[r]] for (r, a, b) in all_edges]

    periods_out = []
    for pid, label, _service, windows in PERIODS:
        waits = []
        for rid in route_ids:
            if rid == FERRY["id"]:
                waits.append(FERRY["wait"].get(pid, FERRY["default_wait"]))
            else:
                waits.append(wait_for(pid, rid, windows))
        sec = []
        for (r, a, b) in all_edges:
            if r == FERRY["id"]:
                sec.append(FERRY["ride"])
                continue
            t = hop_times.get((pid, r, a, b))
            # A hop only counts if its line runs in this period.
            sec.append(int(statistics.median(t)) if t and waits[ridx[r]] else 0)
        periods_out.append({"id": pid, "label": label, "wait": waits, "sec": sec})

    transfers = {}
    for r in read(gtfs, "transfers.txt"):
        a, b = r["from_stop_id"], r["to_stop_id"]
        if a in sidx and b in sidx:
            transfers[(sidx[a], sidx[b])] = int(r["min_transfer_time"] or DEFAULT_TRANSFER)
    for s in used:  # every station allows changing lines in place
        transfers.setdefault((sidx[s], sidx[s]), DEFAULT_TRANSFER)

    stations_out = [[s, stations[s][0], round(stations[s][1], 6), round(stations[s][2], 6)] for s in used]
    feed = next(read(gtfs, "calendar.txt"))
    out = {
        "source": "MTA NYCT subway GTFS (rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip)",
        "validFrom": feed["start_date"],
        "validTo": feed["end_date"],
        "defaultPeriod": DEFAULT_PERIOD,
        "stations": stations_out,
        "routes": routes_out,
        "edges": edges_out,
        "transfers": [[a, b, t] for (a, b), t in sorted(transfers.items())],
        "periods": periods_out,
    }
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    print(f"stations={len(stations_out)} routes={len(routes_out)} edges={len(edges_out)} "
          f"transfers={len(out['transfers'])} periods={len(periods_out)} -> {out_path} "
          f"({os.path.getsize(out_path)//1024} KB)")
    for p in periods_out:
        running = [routes_out[i][1] for i, w in enumerate(p["wait"]) if w]
        stopped = [routes_out[i][1] for i, w in enumerate(p["wait"]) if not w]
        print(f"  {p['id']:10s} lines={len(running):2d} not running: {' '.join(stopped) or '-'}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])

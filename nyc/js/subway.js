/* Pintu NYC — subway travel-time engine.
 *
 * Loads data/subway.json (built by scripts/build_subway.py) and answers:
 *   - how long does each person take to reach every station?
 *   - which stations are the fairest place to meet?
 *
 * The graph state is (station, line), so line changes cost a transfer
 * walk plus the expected wait for the next line. Boarding at the start
 * costs the walk to the station plus the expected wait.
 *
 * Works in the browser (window.PintuSubway) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  var WALK_M_PER_MIN = 80;   // ~4.8 km/h
  var STREET_FACTOR = 1.3;   // Manhattan grid: real walk vs straight line
  var MAX_ACCESS_MIN = 20;   // stations considered "walkable" from an address
  var MAX_DIRECT_WALK_MIN = 25;
  var START = 0, RIDE = 1, TRANSFER = 2;  // how a state was reached

  function haversineM(lat1, lon1, lat2, lon2) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function walkSec(meters) {
    return Math.round(meters * STREET_FACTOR / WALK_M_PER_MIN * 60);
  }

  // Minimal binary heap of [cost, node].
  function Heap() { this.a = []; }
  Heap.prototype.push = function (c, n) {
    var a = this.a, i = a.length; a.push([c, n]);
    while (i > 0) { var p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; var t = a[p]; a[p] = a[i]; a[i] = t; i = p; }
  };
  Heap.prototype.pop = function () {
    var a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; var i = 0, n = a.length;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < n && a[l][0] < a[m][0]) m = l;
        if (r < n && a[r][0] < a[m][0]) m = r;
        if (m === i) break; var t = a[m]; a[m] = a[i]; a[i] = t; i = m;
      }
    }
    return top;
  };

  function Subway(data) {
    this.stations = data.stations.map(function (s, i) {
      return { idx: i, id: s[0], name: s[1], lat: s[2], lon: s[3], routes: [] };
    });
    this.routes = data.routes.map(function (r, i) {
      return { idx: i, id: r[0], label: r[1], color: '#' + r[2], text: '#' + r[3] };
    });
    this.validTo = data.validTo;
    this.periods = data.periods.map(function (p) { return { id: p.id, label: p.label }; });
    this.defaultPeriod = data.defaultPeriod || data.periods[0].id;
    this._data = data;
    this._graphs = {};

    // Lines serving each station in any period (for display).
    var self = this, seen = {};
    data.edges.forEach(function (e) {
      [e[0], e[1]].forEach(function (s) {
        var k = s + ':' + e[2];
        if (!seen[k]) { seen[k] = 1; self.stations[s].routes.push(e[2]); }
      });
    });
    this.stations.forEach(function (st) {
      st.routes.sort(function (x, y) { return self.routes[x].label < self.routes[y].label ? -1 : 1; });
    });
  }

  /** Period id for a moment in New York time ({dow: 0=Sun..6, min: minutes after midnight}). */
  Subway.periodFor = function (when) {
    var dow = when.dow, m = when.min;
    if (m < 5 * 60) return 'night';
    var evening = m >= 19 * 60;
    if (dow === 6) return evening ? 'sat_eve' : 'sat_day';
    if (dow === 0) return evening ? 'sun_eve' : 'sun_day';
    return evening ? 'wkday_eve' : 'wkday_day';
  };

  /** Lines running at a station in a period. */
  Subway.prototype.routesAt = function (stationIdx, period) {
    return this._graph(period).stationRoutes[stationIdx] || [];
  };

  // Graph for one period, built on first use. State = (station, line).
  Subway.prototype._graph = function (period) {
    period = period || this.defaultPeriod;
    if (this._graphs[period]) return this._graphs[period];
    var data = this._data, self = this;
    var p = data.periods.find(function (x) { return x.id === period; }) || data.periods[0];
    var NR = this.routes.length, stateOf = {}, states = [], stationRoutes = [];
    function state(s, r) {
      var k = s * NR + r;
      if (stateOf[k] === undefined) {
        stateOf[k] = states.length;
        states.push({ s: s, r: r, adj: [] });
        (stationRoutes[s] = stationRoutes[s] || []).push(r);
      }
      return stateOf[k];
    }
    // adj entries: [toState, cost, kind, walkSec]; kind RIDE or TRANSFER.
    data.edges.forEach(function (e, i) {
      var sec = p.sec[i];
      if (!sec || !p.wait[e[2]]) return;  // no service on this hop in this period
      states[state(e[0], e[2])].adj.push([state(e[1], e[2]), sec, RIDE, 0]);
    });
    data.transfers.forEach(function (t) {
      var from = stationRoutes[t[0]] || [], to = stationRoutes[t[1]] || [];
      from.forEach(function (r1) {
        to.forEach(function (r2) {
          if (t[0] === t[1] && r1 === r2) return;
          states[stateOf[t[0] * NR + r1]].adj.push(
            [stateOf[t[1] * NR + r2], t[2] + p.wait[r2], TRANSFER, t[2]]);
        });
      });
    });
    var g = { id: p.id, wait: p.wait, states: states, stateOf: stateOf, stationRoutes: stationRoutes, NR: NR };
    this._graphs[period] = g;
    return g;
  };

  /** Stations within walking range of a point, nearest first (at least 3). */
  Subway.prototype.nearbyStations = function (lat, lon) {
    var list = this.stations.map(function (st) {
      var m = haversineM(lat, lon, st.lat, st.lon);
      return { station: st.idx, meters: m, walk: walkSec(m) };
    }).sort(function (a, b) { return a.meters - b.meters; });
    var out = list.filter(function (x) { return x.walk <= MAX_ACCESS_MIN * 60; });
    return out.length >= 3 ? out : list.slice(0, 3);
  };

  /**
   * Door-to-station times for one person.
   * origin: {lat, lon} (an address) or {station: idx} (a chosen station).
   * period: a period id (see Subway.periodFor); defaults to weekday daytime.
   * Returns {time: Float64Array per station (sec), path: function(stationIdx)}.
   */
  Subway.prototype.timesFrom = function (origin, period) {
    var g = this._graph(period), states = g.states, NR = g.NR, self = this;
    var nS = this.stations.length;
    var dist = new Float64Array(states.length).fill(Infinity);
    var prev = new Int32Array(states.length).fill(-1);
    var via = new Uint8Array(states.length);
    var heap = new Heap();

    // time[s]: arrival at station s; best[s]: last ridden state (-1 = walked).
    var time = new Float64Array(nS).fill(Infinity);
    var best = new Int32Array(nS).fill(-1);

    var starts = origin.station !== undefined
      ? [{ station: origin.station, walk: 0 }]
      : this.nearbyStations(origin.lat, origin.lon);
    starts.forEach(function (st) {
      if (st.walk < time[st.station]) time[st.station] = st.walk;
      (g.stationRoutes[st.station] || []).forEach(function (r) {
        var id = g.stateOf[st.station * NR + r];
        var c = st.walk + g.wait[r];  // walk in, then wait for the train
        if (c < dist[id]) { dist[id] = c; via[id] = START; heap.push(c, id); }
      });
    });

    while (heap.a.length) {
      var top = heap.pop(), c = top[0], u = top[1];
      if (c > dist[u]) continue;
      var adj = states[u].adj;
      for (var i = 0; i < adj.length; i++) {
        var v = adj[i][0], nc = c + adj[i][1];
        if (nc < dist[v]) { dist[v] = nc; prev[v] = u; via[v] = adj[i][2]; heap.push(nc, v); }
      }
    }

    // A station is reached by riding into it, or by walking a passageway
    // from a station we rode into. Boarding states (start / transfer) only
    // count as "being there" without their wait, which the loop above adds.
    for (var k = 0; k < states.length; k++) {
      if (via[k] !== RIDE || dist[k] === Infinity) continue;
      var s = states[k].s;
      if (dist[k] < time[s]) { time[s] = dist[k]; best[s] = k; }
      var adjk = states[k].adj;
      for (var j = 0; j < adjk.length; j++) {
        if (adjk[j][2] !== TRANSFER) continue;
        var b = states[adjk[j][0]].s;
        if (b === s) continue;
        var arrive = dist[k] + adjk[j][3];
        if (arrive < time[b]) { time[b] = arrive; best[b] = k; }
      }
    }
    // Walking straight there can beat the subway for nearby stations.
    if (origin.lat !== undefined) {
      this.stations.forEach(function (st) {
        var w = walkSec(haversineM(origin.lat, origin.lon, st.lat, st.lon));
        if (w <= MAX_DIRECT_WALK_MIN * 60 && w <= time[st.idx]) { time[st.idx] = w; best[st.idx] = -1; }
      });
    } else {
      time[origin.station] = 0; best[origin.station] = -1;
    }

    return {
      time: time,
      /** Lines ridden to reach a station, e.g. [{route, from, to}, ...]; [] = walk. */
      path: function (stationIdx) {
        if (best[stationIdx] < 0) return [];
        var legs = [], k = best[stationIdx];
        while (k >= 0) {
          var st = states[k];
          if (!legs.length || legs[0].route !== st.r) legs.unshift({ route: st.r, from: st.s, to: st.s });
          else legs[0].from = st.s;
          k = prev[k];
        }
        // Collapse the "to" of each leg to where the next leg starts.
        for (var i = 0; i < legs.length; i++) legs[i].to = i + 1 < legs.length ? legs[i + 1].from : stationIdx;
        return legs;
      },
    };
  };

  /**
   * Attach place counts from data/venues.json so meetup ranking can prefer
   * stops with plenty to eat. Optional: without it, ranking is time-only.
   */
  Subway.prototype.setPlaces = function (venues) {
    var by = (venues && venues.stations) || {};
    this.stations.forEach(function (st) {
      var v = by[st.id];
      st.places = v ? { count: v[0], cuisines: v[1], top: v[2] || [] } : { count: 0, cuisines: 0, top: [] };
    });
    this.hasPlaces = true;
  };

  /**
   * Meeting stops for a group: fair first, then good for a hangout.
   * people: [{lat, lon} | {station}], at least 2. period: optional period id.
   * Returns up to `limit` options in different neighborhoods:
   *   [{station, times: [sec per person], max, total, extra, paths: [legs per person]}]
   * `max` is the longest trip in the group; `extra` is how much longer that
   * is than the fairest possible stop.
   *
   * Without place data: ranked by longest trip, then total time.
   * With place data: among stops whose longest trip is within a few minutes
   * of the fairest one (5, widening to 25 if needed) and that have at least
   * MIN_PLACES places to eat nearby, prefer livelier ones (see value()).
   */
  var MIN_PLACES = 40;
  var PLACES_ENOUGH = 150;
  var MINUTES_PER_STEP = 7;
  var BANDS_MIN = [5, 10, 15, 25];
  var MIN_APART_M = 900;

  Subway.prototype.fairMeet = function (people, limit, period) {
    limit = limit || 3;
    var self = this;
    var results = people.map(function (p) { return self.timesFrom(p, period); });
    var scored = this.stations.map(function (st) {
      var times = results.map(function (r) { return r.time[st.idx]; });
      var max = Math.max.apply(null, times), total = times.reduce(function (a, b) { return a + b; }, 0);
      return { station: st.idx, times: times, max: max, total: total };
    }).filter(function (x) { return isFinite(x.max); });
    // Round the max to the minute so near-ties are decided by total time.
    scored.sort(function (a, b) {
      return Math.round(a.max / 60) - Math.round(b.max / 60) || a.total - b.total;
    });
    if (!scored.length) return [];
    var bestMax = scored[0].max;

    function pickApart(list, picked) {
      for (var i = 0; i < list.length && picked.length < limit; i++) {
        var cand = self.stations[list[i].station];
        if (picked.some(function (p) { return p.station === list[i].station; })) continue;
        var tooClose = picked.some(function (p) {
          var o = self.stations[p.station];
          return haversineM(cand.lat, cand.lon, o.lat, o.lon) < MIN_APART_M;
        });
        if (!tooClose) picked.push(list[i]);
      }
      return picked;
    }

    // More places help, with diminishing returns: past PLACES_ENOUGH a stop
    // is "lively enough" and fairness decides. Each extra MINUTES_PER_STEP on
    // the longest trip costs about one step of liveliness.
    function value(x) {
      var n = Math.min(self.stations[x.station].places.count, PLACES_ENOUGH);
      return Math.log(1 + n) - (x.max - bestMax) / (MINUTES_PER_STEP * 60);
    }

    var picked = [];
    if (this.hasPlaces) {
      for (var b = 0; b < BANDS_MIN.length && picked.length < limit; b++) {
        var band = BANDS_MIN[b] * 60;
        var pool = scored.filter(function (x) {
          return x.max <= bestMax + band && self.stations[x.station].places.count >= MIN_PLACES;
        });
        pool.sort(function (x, y) { return value(y) - value(x) || x.max - y.max || x.total - y.total; });
        picked = pickApart(pool, picked.slice());
      }
    }
    picked = pickApart(scored, picked);  // top up time-only if place data is thin

    picked.forEach(function (p) {
      p.extra = p.max - bestMax;
      p.paths = results.map(function (r) { return r.path(p.station); });
    });
    return picked;
  };

  Subway.prototype.searchStations = function (query, limit) {
    var q = (query || '').toLowerCase().trim();
    if (!q) return [];
    var self = this;
    return this.stations
      .filter(function (st) { return st.name.toLowerCase().indexOf(q) !== -1; })
      .sort(function (a, b) {
        var ai = a.name.toLowerCase().indexOf(q), bi = b.name.toLowerCase().indexOf(q);
        return ai - bi || b.routes.length - a.routes.length;
      })
      .slice(0, limit || 8)
      .map(function (st) { return { station: st.idx, name: st.name, routes: st.routes.map(function (r) { return self.routes[r]; }) }; });
  };

  var api = { Subway: Subway, haversineM: haversineM, walkSec: walkSec };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PintuSubway = api;
})(typeof window !== 'undefined' ? window : this);

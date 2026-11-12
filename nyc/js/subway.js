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
      return { idx: i, id: r[0], label: r[1], color: '#' + r[2], text: '#' + r[3], wait: r[4] };
    });
    this.validTo = data.validTo;

    var NR = this.routes.length, self = this;
    var stateOf = {}, states = [];  // state = station*NR + route
    function state(s, r) {
      var k = s * NR + r;
      if (stateOf[k] === undefined) {
        stateOf[k] = states.length;
        states.push({ s: s, r: r, adj: [] });
        self.stations[s].routes.push(r);
      }
      return stateOf[k];
    }
    // adj entries: [toState, cost, kind, walkSec]; kind RIDE or TRANSFER.
    data.edges.forEach(function (e) {
      var a = state(e[0], e[2]), b = state(e[1], e[2]);
      states[a].adj.push([b, e[3], RIDE, 0]);
    });
    data.transfers.forEach(function (t) {
      var from = self.stations[t[0]].routes, to = self.stations[t[1]].routes;
      from.forEach(function (r1) {
        to.forEach(function (r2) {
          if (t[0] === t[1] && r1 === r2) return;
          states[stateOf[t[0] * NR + r1]].adj.push(
            [stateOf[t[1] * NR + r2], t[2] + self.routes[r2].wait, TRANSFER, t[2]]);
        });
      });
    });
    this.stations.forEach(function (st) {
      st.routes.sort(function (x, y) { return self.routes[x].label < self.routes[y].label ? -1 : 1; });
    });
    this._states = states;
    this._stateOf = stateOf;
    this._NR = NR;
  }

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
   * Returns {time: Float64Array per station (sec), path: function(stationIdx)}.
   */
  Subway.prototype.timesFrom = function (origin) {
    var states = this._states, NR = this._NR, self = this;
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
      self.stations[st.station].routes.forEach(function (r) {
        var id = self._stateOf[st.station * NR + r];
        var c = st.walk + self.routes[r].wait;  // walk in, then wait for the train
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
   * Fairest meeting stations for a group.
   * people: [{lat, lon} | {station}], at least 2.
   * Returns up to `limit` options in different neighborhoods:
   *   [{station, times: [sec per person], max, total, paths: [legs per person]}]
   * Ranked by the longest trip in the group (minimax), then by total time.
   */
  Subway.prototype.fairMeet = function (people, limit) {
    limit = limit || 3;
    var self = this;
    var results = people.map(function (p) { return self.timesFrom(p); });
    var scored = this.stations.map(function (st) {
      var times = results.map(function (r) { return r.time[st.idx]; });
      var max = Math.max.apply(null, times), total = times.reduce(function (a, b) { return a + b; }, 0);
      return { station: st.idx, times: times, max: max, total: total };
    }).filter(function (x) { return isFinite(x.max); });
    // Round the max to the minute so near-ties are decided by total time.
    scored.sort(function (a, b) {
      return Math.round(a.max / 60) - Math.round(b.max / 60) || a.total - b.total;
    });

    var picked = [];
    for (var i = 0; i < scored.length && picked.length < limit; i++) {
      var cand = self.stations[scored[i].station];
      var tooClose = picked.some(function (p) {
        var o = self.stations[p.station];
        return haversineM(cand.lat, cand.lon, o.lat, o.lon) < 900;
      });
      if (!tooClose) picked.push(scored[i]);
    }
    picked.forEach(function (p) {
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

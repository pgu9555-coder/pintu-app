/* Pintu NYC — free place data.
 *   geocode():  addresses -> coordinates (OpenStreetMap Nominatim)
 *   venues():   restaurants / bars / cafés near a point (OpenStreetMap Overpass)
 * Both services are free and keyless but rate-limited, so calls are made
 * only on explicit user actions and results are cached per session.
 */
(function (root) {
  'use strict';

  // Bounding box around the five boroughs.
  var NYC_VIEWBOX = '-74.2591,40.9176,-73.7004,40.4774';
  var NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  // Public Overpass mirrors, tried in order. Each gets a short time limit so a
  // stalled server falls through to the next instead of spinning forever.
  var OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  var OVERPASS_WAIT_MS = 8000;
  var cache = {};

  async function geocode(query) {
    var q = (query || '').trim();
    if (!q) return [];
    if (cache['g:' + q]) return cache['g:' + q];
    var url = NOMINATIM + '?format=jsonv2&addressdetails=1&limit=5&countrycodes=us&bounded=1' +
      '&viewbox=' + NYC_VIEWBOX + '&q=' + encodeURIComponent(q);
    var res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('Address search is busy, try again in a moment.');
    var list = (await res.json()).map(function (r) {
      var a = r.address || {};
      var street = [a.house_number, a.road].filter(Boolean).join(' ');
      var area = a.neighbourhood || a.suburb || a.city_district || a.borough || a.city || '';
      return {
        label: [street || r.name || r.display_name.split(',')[0], area].filter(Boolean).join(', '),
        full: r.display_name,
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
      };
    });
    cache['g:' + q] = list;
    return list;
  }

  var KINDS = {
    food: ['restaurant', 'fast_food', 'food_court'],
    drinks: ['bar', 'pub', 'biergarten'],
    coffee: ['cafe', 'ice_cream'],
  };

  function cleanCuisine(c) {
    if (!c) return '';
    return c.split(';').slice(0, 2).map(function (x) {
      x = x.replace(/_/g, ' ').trim();
      return x.charAt(0).toUpperCase() + x.slice(1);
    }).join(' · ');
  }

  // Places near a subway stop, prebuilt from NYC health inspection data
  // (scripts/build_places.py) and served from this site, so the food deck
  // works even when every public Overpass server is down.
  async function stopPlaces(stationId) {
    var key = 's:' + stationId;
    if (cache[key]) return cache[key];
    var res = await fetch('data/places/' + encodeURIComponent(stationId) + '.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var d = await res.json();
    var list = (d.p || []).map(function (r) {
      return { id: 'n' + r[0], name: r[1], kind: 'restaurant', cuisine: r[2], address: r[3], grade: r[4],
        hours: '', website: '', lat: r[5], lon: r[6], meters: r[7], src: 'nyc' };
    });
    cache[key] = list;
    return list;
  }

  async function venues(lat, lon, kind, radius, stationId) {
    if (stationId && (kind || 'food') === 'food') {
      try {
        var local = await stopPlaces(stationId);
        if (local.length) return local;
      } catch (e) { /* fall back to Overpass below */ }
    }
    return overpassVenues(lat, lon, kind, radius);
  }

  async function overpassVenues(lat, lon, kind, radius) {
    var key = ['v', lat.toFixed(4), lon.toFixed(4), kind, radius].join(':');
    if (cache[key]) return cache[key];
    var amen = (KINDS[kind] || KINDS.food).join('|');
    var q = '[out:json][timeout:8];nwr["amenity"~"^(' + amen + ')$"]["name"](around:' + (radius || 600) + ',' +
      lat + ',' + lon + ');out center tags 80;';
    var lastErr;
    for (var i = 0; i < OVERPASS.length; i++) {
      try {
        var ctrl = root.AbortController ? new AbortController() : null;
        var timer = ctrl && setTimeout(function () { ctrl.abort(); }, OVERPASS_WAIT_MS);
        var data;
        try {
          var res = await fetch(OVERPASS[i], { method: 'POST', body: 'data=' + encodeURIComponent(q),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl && ctrl.signal });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          data = await res.json();
        } finally { if (timer) clearTimeout(timer); }
        if (!data || !data.elements) throw new Error('bad response');
        var list = data.elements.map(function (el) {
          var t = el.tags || {}, vlat = el.lat || (el.center && el.center.lat), vlon = el.lon || (el.center && el.center.lon);
          return {
            id: el.type[0] + el.id,
            name: t.name,
            kind: t.amenity,
            cuisine: cleanCuisine(t.cuisine),
            hours: t.opening_hours || '',
            website: t.website || t['contact:website'] || '',
            lat: vlat, lon: vlon,
            meters: Math.round(root.PintuSubway.haversineM(lat, lon, vlat, vlon)),
          };
        }).filter(function (v) { return v.name && v.lat; })
          .sort(function (a, b) { return a.meters - b.meters; });
        cache[key] = list;
        return list;
      } catch (e) { lastErr = e.name === 'AbortError' ? new Error('timed out') : e; }
    }
    throw new Error('Couldn\'t load places nearby (' + (lastErr && lastErr.message) + '). Try again in a moment.');
  }

  function googleMapsLink(v) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(v.address ? v.name + ', ' + v.address + ', New York' : v.name + ' ' + v.lat + ',' + v.lon);
  }

  root.PintuPlaces = { geocode: geocode, venues: venues, googleMapsLink: googleMapsLink, KINDS: KINDS };
})(window);

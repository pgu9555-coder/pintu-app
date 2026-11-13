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
    // ?v= skips copies phones cached under the old one-day cache rule.
    var res = await fetch('data/places/' + encodeURIComponent(stationId) + '.json?v=3');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var d = await res.json();
    var list = (d.p || []).map(function (r) {
      return { id: 'n' + r[0], name: r[1], kind: 'restaurant', cuisine: r[2], address: r[3], grade: r[4],
        lat: r[5], lon: r[6], meters: r[7], src: 'nyc',
        // Added by build_extras.py from OpenStreetMap and the place's own website.
        hours: r[8] || '', website: r[9] || '', image: r[10] || '', book: r[11] || '', group: groupOf(r[2]) };
    });
    // Places with a photo, then with hours, come first so the deck opens on
    // the richest cards; distance order is kept within each group.
    var rank = function (v) { return v.image ? 0 : v.hours ? 1 : 2; };
    list = list.map(function (v, i) { return [v, i]; })
      .sort(function (a, b) { return rank(a[0]) - rank(b[0]) || a[1] - b[1]; })
      .map(function (x) { return x[0]; });
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
            group: groupOf(t.cuisine || '', t.amenity),
          };
        }).filter(function (v) { return v.name && v.lat; })
          .sort(function (a, b) { return a.meters - b.meters; });
        cache[key] = list;
        return list;
      } catch (e) { lastErr = e.name === 'AbortError' ? new Error('timed out') : e; }
    }
    throw new Error('Couldn\'t load places nearby (' + (lastErr && lastErr.message) + '). Try again in a moment.');
  }

  // Food groups for the filter chips. GROUP_OF mirrors GROUPS in
  // scripts/build_places.py (DOHMH cuisine names); OSM cuisines fall back to keywords.
  var GROUPS = [
    { id: 'asian', label: 'Asian', subs: ['chinese', 'japanese', 'korean', 'sea', 'asianfusion'] },
    { id: 'pizza', label: 'Pizza & Italian' }, { id: 'american', label: 'American' }, { id: 'latin', label: 'Latin' },
    { id: 'mideast', label: 'Middle Eastern' }, { id: 'indian', label: 'Indian' }, { id: 'european', label: 'European' },
    { id: 'seafood', label: 'Seafood' }, { id: 'healthy', label: 'Healthy & Veggie' },
    { id: 'cafe', label: 'Café & Brunch' }, { id: 'dessert', label: 'Dessert' },
  ];
  var SUB_LABEL = { chinese: 'Chinese', japanese: 'Japanese', korean: 'Korean', sea: 'Thai & SE Asian', asianfusion: 'Asian Fusion' };
  var NOT_MEALS = { cafe: true, dessert: true };   // only shown when picked
  var GROUP_CUISINES = {
    chinese: ['Chinese', 'Chinese/Cuban'], japanese: ['Japanese', 'Chinese/Japanese'], korean: ['Korean'],
    sea: ['Thai', 'Southeast Asian', 'Filipino', 'Indonesian'], asianfusion: ['Asian/Asian Fusion'],
    pizza: ['Pizza', 'Italian'],
    american: ['American', 'New American', 'Hamburgers', 'Chicken', 'Barbecue', 'Steakhouse', 'Soul Food', 'Hotdogs',
      'Hotdogs/Pretzels', 'Californian', 'Southwestern', 'Cajun', 'Creole', 'Creole/Cajun'],
    latin: ['Mexican', 'Tex-Mex', 'Latin American', 'Caribbean', 'Peruvian', 'Brazilian', 'Spanish', 'Chilean', 'Chimichurri'],
    mideast: ['Middle Eastern', 'Mediterranean', 'Greek', 'Turkish', 'Lebanese', 'Moroccan', 'Egyptian', 'Iranian', 'Afghan', 'Armenian'],
    indian: ['Indian', 'Bangladeshi', 'Pakistani'],
    european: ['French', 'New French', 'Tapas', 'Basque', 'Irish', 'German', 'Eastern European', 'Russian', 'Polish', 'Czech',
      'Portuguese', 'English', 'Scandinavian', 'Continental', 'Haute Cuisine', 'Australian'],
    seafood: ['Seafood'],
    healthy: ['Salads', 'Vegan', 'Vegetarian', 'Hawaiian', 'Polynesian', 'Juice, Smoothies, Fruit Salads',
      'Soups/Salads/Sandwiches', 'Sandwiches/Salads/Mixed Buffet', 'Soups'],
    cafe: ['Coffee/Tea', 'Bagels/Pretzels', 'Sandwiches', 'Pancakes/Waffles'],
    dessert: ['Bakery Products/Desserts', 'Frozen Desserts', 'Donuts', 'Nuts/Confectionary'],
  };
  var GROUP_OF = {};
  Object.keys(GROUP_CUISINES).forEach(function (g) { GROUP_CUISINES[g].forEach(function (c) { GROUP_OF[c] = g; }); });
  var KEYWORDS = [
    [/chinese|dim sum|szechuan|sichuan|cantonese|hot ?pot/i, 'chinese'], [/japanese|sushi|ramen|izakaya/i, 'japanese'],
    [/korean/i, 'korean'], [/thai|vietnam|pho|filipino|malaysian|indonesian/i, 'sea'], [/asian/i, 'asianfusion'],
    [/pizza|italian/i, 'pizza'], [/mexican|taco|latin|caribbean|peruvian|brazil|spanish|cuban/i, 'latin'],
    [/burger|american|chicken|bbq|barbecue|steak|diner|wings/i, 'american'],
    [/greek|turkish|lebanese|middle.?eastern|mediterranean|falafel|kebab/i, 'mideast'],
    [/indian|pakistan|bangladesh|nepal/i, 'indian'], [/french|german|irish|polish|russian|tapas|european/i, 'european'],
    [/seafood|fish|oyster/i, 'seafood'], [/salad|vegan|vegetarian|poke|juice/i, 'healthy'],
    [/coffee|cafe|bagel|sandwich|brunch|breakfast/i, 'cafe'], [/ice.?cream|dessert|bakery|donut|cake|gelato/i, 'dessert'],
  ];
  function groupOf(cuisine, kind) {
    if (GROUP_OF[cuisine]) return GROUP_OF[cuisine];
    if (kind === 'cafe') return 'cafe';
    if (kind === 'ice_cream') return 'dessert';
    for (var i = 0; i < KEYWORDS.length; i++) if (KEYWORDS[i][0].test(cuisine || '')) return KEYWORDS[i][1];
    return 'other';
  }
  function topGroup(leaf) { return SUB_LABEL[leaf] ? 'asian' : leaf; }

  function googleMapsLink(v) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(v.address ? v.name + ', ' + v.address + ', New York' : v.name + ' ' + v.lat + ',' + v.lon);
  }

  root.PintuPlaces = { geocode: geocode, venues: venues, googleMapsLink: googleMapsLink, KINDS: KINDS,
    GROUPS: GROUPS, SUB_LABEL: SUB_LABEL, NOT_MEALS: NOT_MEALS, GROUP_OF: GROUP_OF, groupOf: groupOf, topGroup: topGroup };
})(window);

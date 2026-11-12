// Pintu NYC tests. Run: node nyc/tests/run.js
const assert = require('assert');
const path = require('path');
const { Subway } = require('../js/subway.js');
const Split = require('../js/split.js');
const data = require('../data/subway.json');
const venues = require('../data/venues.json');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
}

const sw = new Subway(data);
sw.setPlaces(venues);
const name = (i) => sw.stations[i].name;
const station = (q) => sw.searchStations(q)[0].station;
const minutes = (a, b) => sw.timesFrom({ station: station(a) }).time[station(b)] / 60;
const top = (people) => sw.fairMeet(people, 3).map((o) => name(o.station));

const LIC = { lat: 40.7447, lon: -73.9485 };

// --- travel times stay realistic -------------------------------------------
test('Times Sq to Union Sq is under 12 min', () => assert(minutes('Times Sq', '14 St-Union Sq') < 12));
test('Bedford Av to Times Sq is 15-30 min', () => { const m = minutes('Bedford Av', 'Times Sq'); assert(m > 15 && m < 30, m); });
test('St George reaches Manhattan via the ferry', () => {
  const r = sw.timesFrom({ station: station('St George') });
  const legs = r.path(station('Wall St'));
  assert(legs.some((l) => sw.routes[l.route].id === 'FERRY'), JSON.stringify(legs));
});
test('arriving at a transfer station does not add a phantom ride', () => {
  const r = sw.timesFrom({ lat: 40.6993, lon: -73.9115 });
  const legs = r.path(station('14 St-Union Sq'));
  assert(legs.every((l) => l.from !== l.to), JSON.stringify(legs));
});

// --- meetup ranking: fair, and somewhere worth going ------------------------
test('Bushwick + UWS + Astoria -> Union Sq first', () =>
  assert.strictEqual(top([{ lat: 40.6993, lon: -73.9115 }, { lat: 40.7784, lon: -73.9819 }, { lat: 40.7701, lon: -73.9180 }])[0], '14 St-Union Sq'));
test('LIC + Forest Hills stays in Queens, Jackson Hts first', () =>
  assert.strictEqual(top([LIC, { lat: 40.7196, lon: -73.8448 }])[0], 'Jackson Hts-Roosevelt Av'));
test('LIC + Astoria -> Steinway St first (not Midtown)', () =>
  assert.strictEqual(top([LIC, { lat: 40.7644, lon: -73.9235 }])[0], 'Steinway St'));
test('every suggestion has enough places to eat', () => {
  for (const o of sw.fairMeet([LIC, { lat: 40.7596, lon: -73.8303 }], 3)) assert(sw.stations[o.station].places.count >= 40, name(o.station));
});
test('suggestions are in different neighborhoods (>= 900 m apart)', () => {
  const o = sw.fairMeet([LIC, { lat: 40.7023, lon: -73.8008 }], 3).map((x) => sw.stations[x.station]);
  for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++)
    assert(require('../js/subway.js').haversineM(o[i].lat, o[i].lon, o[j].lat, o[j].lon) >= 900);
});
test('works without place data (time-only)', () => {
  const plain = new Subway(data);
  assert.strictEqual(plain.fairMeet([LIC, { lat: 40.7196, lon: -73.8448 }], 3).length, 3);
});

// --- bill split --------------------------------------------------------------
test('$120, NYC tax, 20% tip, 3 ways = $51.55 each, adds up', () => {
  const r = Split.compute({ subtotal: 12000, taxPct: 8.875, tipPct: 20, payerId: 'a', shares: { a: 1, b: 1, c: 1 } });
  assert.strictEqual(r.total, 15465);
  assert.deepStrictEqual(Object.values(r.perPerson), [5155, 5155, 5155]);
});
test('uneven cents and extras always add up to the total', () => {
  for (let sub = 1; sub < 3000; sub += 37) {
    const r = Split.compute({ subtotal: sub, shares: { a: 1, b: 1, c: 1 }, extra: { c: Math.floor(sub / 3) } });
    assert.strictEqual(Object.values(r.perPerson).reduce((x, y) => x + y, 0), r.total, 'subtotal ' + sub);
  }
});
test('Venmo link strips @ and formats amount', () =>
  assert.strictEqual(Split.venmoLink('@alex', 4321, 'x'), 'https://venmo.com/alex?txn=pay&amount=43.21&note=x'));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

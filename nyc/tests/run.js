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

// --- time periods -------------------------------------------------------------
test('late night is slower than weekday daytime', () => {
  const o = { lat: 40.6993, lon: -73.9115 }, d = station('14 St-Union Sq');
  const day = sw.timesFrom(o, 'wkday_day').time[d], night = sw.timesFrom(o, 'night').time[d];
  assert(night > day + 5 * 60, `day ${day / 60} night ${night / 60}`);
});
test('no B or W trains on Saturday', () => {
  const r = sw.timesFrom({ station: station('Coney Island') }, 'sat_day');
  const legs = r.path(station('Times Sq'));
  assert(legs.every((l) => !['B', 'W'].includes(sw.routes[l.route].label)), JSON.stringify(legs));
});
test('periodFor maps NYC day/time to periods', () => {
  const P = Subway.periodFor;
  assert.strictEqual(P({ dow: 3, min: 12 * 60 }), 'wkday_day');
  assert.strictEqual(P({ dow: 5, min: 20 * 60 }), 'wkday_eve');
  assert.strictEqual(P({ dow: 6, min: 20 * 60 }), 'sat_eve');
  assert.strictEqual(P({ dow: 0, min: 13 * 60 }), 'sun_day');
  assert.strictEqual(P({ dow: 6, min: 2 * 60 }), 'night');
});
test('every period gives three options', () => {
  for (const p of sw.periods) assert.strictEqual(sw.fairMeet([LIC, { lat: 40.7196, lon: -73.8448 }], 3, p.id).length, 3, p.id);
});

// --- meetup ranking: fair, and somewhere worth going ------------------------
test('Bushwick + UWS + Astoria -> Union Sq first', () =>
  assert.strictEqual(top([{ lat: 40.6993, lon: -73.9115 }, { lat: 40.7784, lon: -73.9819 }, { lat: 40.7701, lon: -73.9180 }])[0], '14 St-Union Sq'));
test('LIC + Forest Hills stays in Queens, Jackson Hts first', () =>
  assert.strictEqual(top([LIC, { lat: 40.7196, lon: -73.8448 }])[0], 'Jackson Hts-Roosevelt Av'));
test('LIC + Astoria stays in Queens (not Midtown)', () => {
  const o = sw.fairMeet([LIC, { lat: 40.7644, lon: -73.9235 }], 3)[0];
  const st = sw.stations[o.station];
  assert(st.lon > -73.945 && st.lat > 40.74, st.name);  // east of the East River, north of Brooklyn
});
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

// --- opening hours ----------------------------------------------------------
const Hours = require('../js/hours.js');
const MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6, SUN = 0;
const at = (h, dow, hh, mm = 0) => Hours.isOpenAt(h, dow, hh * 60 + mm);

test('hours: 24/7 is always open', () => {
  assert.strictEqual(at('24/7', SUN, 3), true);
  assert.strictEqual(at('24/7', WED, 23, 59), true);
  assert.strictEqual(Hours.describe('24/7', WED, 600), 'Open 24 hours');
});
test('hours: day ranges and lists', () => {
  const h = 'Mo-Fr 11:00-22:00; Sa,Su 10:00-23:00';
  assert.strictEqual(at(h, TUE, 12), true);
  assert.strictEqual(at(h, MON, 23), false);
  assert.strictEqual(at(h, SAT, 22, 30), true);
  assert.strictEqual(at(h, SAT, 23, 30), false);
  assert.strictEqual(at(h, SUN, 9), false);
});
test('hours: past midnight counts toward the next day (Fri 18:00-02:00)', () => {
  const h = 'Fr 18:00-02:00';
  assert.strictEqual(at(h, FRI, 19), true);
  assert.strictEqual(at(h, SAT, 1), true);
  assert.strictEqual(at(h, SAT, 3), false);
  assert.strictEqual(at(h, SAT, 19), false);
  assert.strictEqual(Hours.describe(h, SAT, 60), 'Open until 2 AM');
});
test('hours: "Su off" closes Sunday only', () => {
  const h = 'Mo-Sa 10:00-20:00; Su off';
  assert.strictEqual(at(h, SUN, 12), false);
  assert.strictEqual(Hours.describe(h, SUN, 12 * 60), 'Closed that day');
  assert.strictEqual(at(h, MON, 12), true);
  assert.strictEqual(at(h, SAT, 12), true);
});
test('hours: wrap-around day range Fr-Mo covers Fri, Sat, Sun, Mon', () => {
  const h = 'Fr-Mo 12:00-14:00';
  for (const d of [FRI, SAT, SUN, MON]) assert.strictEqual(at(h, d, 13), true, 'day ' + d);
  for (const d of [TUE, WED, THU]) assert.strictEqual(at(h, d, 13), false, 'day ' + d);
});
test('hours: several ranges in one day', () => {
  const h = 'Mo-Su 11:30-15:00,17:00-22:00';
  assert.strictEqual(at(h, MON, 14), true);
  assert.strictEqual(at(h, MON, 16), false);
  assert.strictEqual(at(h, MON, 17, 30), true);
  assert.strictEqual(Hours.describe(h, MON, 16 * 60), 'Closed then · opens 5 PM');
});
test('hours: a rule with only times applies to every day; later rules override', () => {
  assert.strictEqual(at('11:00-22:00', WED, 12), true);
  assert.strictEqual(at('11:00-22:00', SUN, 12), true);
  const h = 'Mo-Fr 09:00-17:00; Mo 10:00-12:00';
  assert.strictEqual(at(h, MON, 9, 30), false);
  assert.strictEqual(at(h, MON, 10, 30), true);
  assert.strictEqual(at(h, TUE, 9, 30), true);
});
test('hours: PH and SH rules are ignored', () => {
  const h = 'Mo-Fr 11:00-22:00; PH off; SH 12:00-15:00';
  assert.strictEqual(at(h, TUE, 12), true);
  assert.strictEqual(at(h, TUE, 23), false);
});
test('hours: "off", "closed" and quoted comments', () => {
  assert.strictEqual(at('Mo-Su off', WED, 12), false);
  assert.strictEqual(at('Mo-Sa 11:00-22:00 "kitchen closes 21:30"', WED, 12), true);
});
test('hours: describe reads well for open, closed-then and closed-all-day', () => {
  const h = 'Mo-Fr 11:00-22:00';
  assert.strictEqual(Hours.describe(h, TUE, 20 * 60), 'Open until 10 PM');
  assert.strictEqual(Hours.describe(h, TUE, 10 * 60), 'Closed then · opens 11 AM');
  assert.strictEqual(Hours.describe(h, TUE, 22 * 60 + 30), 'Closed then');  // done for the night, not closed all day
  assert.strictEqual(Hours.describe(h, SAT, 12 * 60), 'Closed that day');
});
test('hours: empty, garbage and unsupported input gives null and never throws', () => {
  for (const bad of ['', '   ', 'sunrise-sunset', 'Mo-Fr', 'Mo-Fr 11am-10pm', 'Xy 10:00-11:00',
    '11:00-22:00 sunrise', 'Mo-Fr 25:00-26:00x', null, undefined, 42, '{"a":1}']) {
    assert.strictEqual(Hours.isOpenAt(bad, TUE, 600), null, JSON.stringify(bad));
    assert.strictEqual(Hours.describe(bad, TUE, 600), null, JSON.stringify(bad));
  }
  assert.strictEqual(Hours.isOpenAt('Mo-Fr 11:00-22:00', 9, 600), null, 'bad day');
  assert.strictEqual(Hours.isOpenAt('Mo-Fr 11:00-22:00', TUE, 5000), null, 'bad minutes');
});

// --- trip ledger settlement ------------------------------------------------------
const M = 'M', D = 'D', A = 'A', L = 'L';
const trip = [
  { id: 'dinner', cents: 18640, payerId: M, among: [M, D, A, L] },
  { id: 'uber', cents: 4800, payerId: D, among: [M, D, A, L] },
  { id: 'drinks', cents: 3600, payerId: A, among: [A, M, L] },
];
test('settle: spec example gives L->M 7060, A->M 3460, D->M 1060', () => {
  const r = Split.settle(trip, [M, D, A, L]);
  const t = r.transfers.map((x) => `${x.from}>${x.to}:${x.cents}`).sort();
  assert.deepStrictEqual(t, ['A>M:3460', 'D>M:1060', 'L>M:7060'], JSON.stringify(r.transfers));
  assert.strictEqual(r.total, 18640 + 4800 + 3600);
  assert.deepStrictEqual(r.balances, { M: 11580, D: -1060, A: -3460, L: -7060 });
});
test('settle: balances sum to exactly zero and transfers clear them', () => {
  const r = Split.settle(trip, [M, D, A, L]);
  assert.strictEqual(Object.values(r.balances).reduce((a, b) => a + b, 0), 0);
  const net = {};
  r.transfers.forEach((x) => { net[x.from] = (net[x.from] || 0) - x.cents; net[x.to] = (net[x.to] || 0) + x.cents; });
  for (const id of [M, D, A, L]) assert.strictEqual(net[id] || 0, r.balances[id], id);
});
test('settle: uneven cents still add up exactly', () => {
  const odd = [{ id: 'x', cents: 1000, payerId: M, among: [M, D, A] }, { id: 'y', cents: 1, payerId: D, among: [M, D, A] }];
  const r = Split.settle(odd, [M, D, A]);
  assert.strictEqual(r.total, 1001);
  assert.strictEqual(Object.values(r.balances).reduce((a, b) => a + b, 0), 0);
  const paid = r.transfers.reduce((a, t) => a + t.cents, 0);
  assert.strictEqual(paid, Object.values(r.balances).filter((v) => v > 0).reduce((a, b) => a + b, 0));
});
test('settle: tax and tip add on top of the entered subtotal', () => {
  const e = { cents: 10000, payerId: M, among: [M, D], taxTip: true, tipPct: 20 };
  assert.strictEqual(Split.expenseTotal(e), 10000 + 888 + 2000);
  const r = Split.settle([e], [M, D]);
  assert.strictEqual(r.total, 12888);
  assert.deepStrictEqual(r.transfers, [{ from: D, to: M, cents: 6444 }]);
});
test('settle: no expenses means nothing owed', () => {
  const r = Split.settle([], [M, D]);
  assert.strictEqual(r.total, 0);
  assert.deepStrictEqual(r.transfers, []);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

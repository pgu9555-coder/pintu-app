const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..', 'miniprogram-shell');
const backup = require(path.join(root, 'utils/ledger-backup'));
const math = require(path.join(root, 'utils/ledger'));
const plain = (value) => JSON.parse(JSON.stringify(value));
const fixture = { name: '周末见', ownerUid: 'never-export', members: [{ id: 'a', name: '联调甲', uid: 'private', color: '#20594f' }, { id: 'b', name: '联调乙' }], expenses: [{ id: 'private-id', desc: '咖啡', amountCents: 1001, payerId: 'a', splitIds: ['a', 'b'], updatedBy: 'private' }], membershipEpoch: 'never-export', sourceRoomDocId: 'never-export' };

function makeStorage() {
  const data = new Map(); let writes = 0; let fail = false;
  const sandbox = { module: { exports: {} }, require(name) { assert.equal(name, './ledger-backup'); return backup; }, wx: {
    getStorageSync(key) { return data.get(key); },
    setStorageSync(key, value) { if (fail) throw new Error('full'); data.set(key, plain(value)); writes += 1; },
    removeStorageSync(key) { data.delete(key); }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/storage.js'), 'utf8'), sandbox);
  return { api: sandbox.module.exports, data, writes: () => writes, fail(value) { fail = value; } };
}
const store = makeStorage(); const storage = store.api;
assert.equal(storage.localScopeToken(), 'guest');
assert.equal(storage.setScoped('private-outbox', {}), false);
assert.equal(storage.setLocal('private-outbox', {}), false);
assert.equal(storage.setLocal(backup.LOCAL_KEY, { trips: [{ tripId: 'guest', ledger: fixture }] }), true);
assert.equal(storage.getLocal(backup.LOCAL_KEY).trips[0].tripId, 'guest');
assert.equal(storage.cacheLedgerSnapshot('room1', fixture), false);
const scopeA = 'a'.repeat(64); const scopeB = 'b'.repeat(64);
storage.setAccountScope(scopeA);
assert.equal(storage.getLocal(backup.LOCAL_KEY, null), null, 'login must not merge guest books');
storage.setLocal(backup.LOCAL_KEY, { trips: [{ tripId: 'account-a', ledger: fixture }] });
assert.equal(storage.cacheLedgerSnapshot('room1', fixture), true);
const writes = store.writes();
assert.equal(storage.cacheLedgerSnapshot('room1', fixture), true);
assert.equal(store.writes(), writes, 'unchanged two-second polls must not write the snapshot again');
for (let i = 0; i < 25; i += 1) storage.cacheLedgerSnapshot(`room${i}`, fixture);
assert.equal(storage.getLedgerBackupCache().length, 20);
assert.equal(JSON.stringify(storage.getLedgerBackupCache()).includes('never-export'), false);
storage.setAccountScope(scopeB);
assert.equal(storage.getLocal(backup.LOCAL_KEY, null), null);
assert.deepEqual(plain(storage.getLedgerBackupCache()), []);
storage.clearAccountScope();
assert.equal(storage.getLocal(backup.LOCAL_KEY).trips[0].tripId, 'guest');
assert.deepEqual(plain(storage.getLedgerBackupCache()), []);
storage.setAccountScope(scopeA);
assert.equal(storage.getLocal(backup.LOCAL_KEY).trips[0].tripId, 'account-a');

assert.equal(backup.byteLength('见面☕😀'), Buffer.byteLength('见面☕😀'));
const exported = backup.createBackup([{ ledger: fixture, sourceRoomDocId: 'room1' }], [{ docId: 'room1', ledger: fixture }], 0);
assert.equal(exported.data.trips.length, 1, 'a retained room copy must not duplicate its cached snapshot');
const newer = plain(fixture); newer.expenses.push({ id: 'new', desc: '午饭', amountCents: 500, payerId: 'b', splitIds: ['a', 'b'] });
const distinct = backup.createBackup([{ ledger: fixture, sourceRoomDocId: 'room1' }], [{ docId: 'room1', ledger: newer }], 0);
assert.equal(distinct.data.trips.length, 2, 'a changed shared snapshot must not be dropped in favor of an older local copy');
assert.equal(distinct.data.trips[1].expenses.length, 2);
assert.match(distinct.data.trips[1].name, /共享快照/);
assert.equal(exported.data.exportedAt, '1970-01-01T00:00:00.000Z');
for (const secret of ['never-export', 'ownerUid', 'membershipEpoch', 'updatedBy', 'private-id', 'uid']) assert.equal(exported.text.includes(secret), false, secret);
const parsed = backup.parseBackup(exported.text);
assert.equal(parsed[0].expenses[0].amountCents, 1001);
assert.equal(backup.parseBackup('\uFEFF' + exported.text).length, 1);
const unchanged = JSON.stringify(storage.getLocal(backup.LOCAL_KEY));
assert.throws(() => backup.importTrips(storage, [fixture, { members: [], expenses: [{ amountCents: 0 }] }]));
assert.equal(JSON.stringify(storage.getLocal(backup.LOCAL_KEY)), unchanged, 'invalid batches must be atomic');
assert.equal(backup.importTrips(storage, parsed, { now: 100, random: () => 0.25 }), 1);
assert.equal(backup.importTrips(storage, parsed, { now: 100, random: () => 0.25 }), 1);
const imported = storage.getLocal(backup.LOCAL_KEY).trips.slice(-2);
assert.notEqual(imported[0].tripId, imported[1].tripId);
assert.deepEqual(math.balances(imported[0].ledger).map((entry) => entry.cents), math.balances(fixture).map((entry) => entry.cents));
assert.equal(imported[0].ledger.members.some((member) => 'uid' in member), false);
assert.equal(imported[0].sourceRoomDocId, undefined);
const beforeFailure = JSON.stringify(storage.getLocal(backup.LOCAL_KEY));
store.fail(true);
assert.throws(() => backup.importTrips(storage, parsed), /保存失败/);
assert.equal(JSON.stringify(storage.getLocal(backup.LOCAL_KEY)), beforeFailure);
store.fail(false);
for (const id of ['__proto__', 'constructor', 'prototype', 'bad.id']) {
  const bad = plain(fixture); bad.members[0].id = id;
  assert.throws(() => backup.portableTrip(bad));
}
for (const change of [
  (t) => t.members.push(t.members[0]),
  (t) => { t.expenses[0].amountCents = 1.1; },
  (t) => { t.expenses[0].amountCents = -1; },
  (t) => { t.expenses[0].splitIds = ['a', 'a']; },
  (t) => { t.expenses[0].payerId = 'missing'; },
  (t) => { t.expenses[0].splitIds = ['missing']; }
]) { const bad = plain(fixture); change(bad); assert.throws(() => backup.portableTrip(bad)); }
assert.throws(() => backup.parseBackup('a'.repeat(backup.MAX_BYTES + 1)), /5MB/);
assert.throws(() => backup.validateBackup({ format: backup.FORMAT, version: 2, trips: [] }));
assert.throws(() => backup.validateBackup({ format: backup.FORMAT, version: 1, trips: Array(101).fill(fixture) }));

const webSource = fs.readFileSync(path.join(root, '..', 'launch-support.js'), 'utf8');
const webSandbox = {};
vm.runInNewContext(webSource.slice(webSource.indexOf('  function backupTrip('), webSource.indexOf('  window.pintuBackupTrip')) + '\nthis.portable = backupTrip;', webSandbox);
assert.deepEqual(plain(webSandbox.portable(exported.data.trips[0])), plain(parsed[0]), 'the actual web importer must accept a native export');
const webExport = { format: backup.FORMAT, version: 1, trips: [plain(webSandbox.portable(fixture))] };
assert.deepEqual(backup.parseBackup(JSON.stringify(webExport)), parsed, 'the native importer must accept an actual web portable ledger');

const pageSource = fs.readFileSync(path.join(root, 'pages/data-tools/index.js'), 'utf8');
function makePage(wx) {
  let definition;
  vm.runInNewContext(pageSource, { require(name) { return /storage$/.test(name) ? storage : backup; }, Page(value) { definition = value; }, wx });
  const page = Object.assign({}, definition, { data: plain(definition.data), setData(values) { Object.assign(this.data, values); } });
  return page;
}
let selected = 0; let readCallback; let shareCount = 0; let removed = 0;
const fileWx = { env: { USER_DATA_PATH: '/private' }, chooseMessageFile(options) { selected += 1; options.success({ tempFiles: [{ path: '/file.json', size: 1024 }] }); }, getFileSystemManager() { return {
  readFile(options) { readCallback = options.success; },
  writeFile(options) { assert.equal(JSON.stringify(JSON.parse(options.data)).includes('never-export'), false); options.success(); },
  unlink() { removed += 1; }
}; }, shareFileMessage(options) { shareCount += 1; options.fail({ errMsg: 'cancel' }); options.complete(); } };
const page = makePage(fileWx);
page.importBackup(); page.importBackup(); assert.equal(selected, 1, 'busy import must ignore a second tap');
storage.setAccountScope(scopeB);
readCallback({ data: exported.text });
assert.match(page.data.status, /空间已切换/);
assert.equal(storage.getLocal(backup.LOCAL_KEY, null), null);
storage.setAccountScope(scopeA);
page.importBackup(); readCallback({ data: exported.text }); assert.match(page.data.status, /已新增 1 个/);
page.exportBackup(); assert.equal(shareCount, 1); assert.equal(removed, 1); assert.match(page.data.status, /已取消分享/);
assert.equal(page.data.busy, false);
console.log('Native backup checks passed (web round-trip, atomic import, guest/account isolation, cache bounds, file flow).');

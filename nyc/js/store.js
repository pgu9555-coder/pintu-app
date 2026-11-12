/* Pintu NYC — data store.
 *
 * Cloud mode (Supabase, realtime across devices) when js/config.js has a
 * URL and anon key; otherwise local mode (localStorage, synced live across
 * tabs of the same browser) so the app always works for a demo.
 *
 * Shape of a loaded room:
 *   { room:   {code, name, meet, bill, created_at},
 *     people: [{id, room_code, name, origin, venmo, created_at}],
 *     votes:  [{room_code, person_id, venue_id, venue, vote}] }
 */
(function (root) {
  'use strict';

  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  // Prefixed so they can share a Supabase project with other apps' tables.
  var T = { rooms: 'meet_rooms', people: 'meet_people', votes: 'meet_votes' };

  function newCode() {
    var bytes = new Uint8Array(6), s = '';
    (root.crypto || window.crypto).getRandomValues(bytes);
    for (var i = 0; i < 6; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
    return s;
  }

  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }

  // ---------------------------------------------------------------- cloud
  function CloudStore(url, key) {
    this.mode = 'cloud';
    this.db = root.supabase.createClient(url, key, { auth: { persistSession: false } });
  }
  CloudStore.prototype._check = function (res) {
    if (res.error) throw new Error(res.error.message);
    return res.data;
  };
  CloudStore.prototype.createRoom = async function (name) {
    for (var attempt = 0; attempt < 5; attempt++) {
      var code = newCode();
      var res = await this.db.from(T.rooms).insert({ code: code, name: name });
      if (!res.error) return code;
      if (res.error.code !== '23505') throw new Error(res.error.message); // 23505 = taken
    }
    throw new Error('Could not create a room code, please try again.');
  };
  CloudStore.prototype.load = async function (code) {
    var r = await Promise.all([
      this.db.from(T.rooms).select('*').eq('code', code).maybeSingle(),
      this.db.from(T.people).select('*').eq('room_code', code).order('created_at'),
      this.db.from(T.votes).select('*').eq('room_code', code),
    ]);
    var room = this._check(r[0]);
    if (!room) return null;
    return { room: room, people: this._check(r[1]), votes: this._check(r[2]) };
  };
  CloudStore.prototype.addPerson = async function (code, p) {
    var row = { id: uuid(), room_code: code, name: p.name, origin: p.origin || null, venmo: p.venmo || null };
    this._check(await this.db.from(T.people).insert(row));
    return row;
  };
  CloudStore.prototype.updatePerson = async function (id, patch) {
    this._check(await this.db.from(T.people).update(patch).eq('id', id));
  };
  CloudStore.prototype.removePerson = async function (id) {
    this._check(await this.db.from(T.people).delete().eq('id', id));
  };
  CloudStore.prototype.updateRoom = async function (code, patch) {
    this._check(await this.db.from(T.rooms).update(patch).eq('code', code));
  };
  CloudStore.prototype.vote = async function (code, personId, venue, vote) {
    this._check(await this.db.from(T.votes).upsert(
      { room_code: code, person_id: personId, venue_id: venue.id, venue: venue, vote: vote },
      { onConflict: 'person_id,venue_id' }));
  };
  CloudStore.prototype.subscribe = function (code, onChange) {
    var ch = this.db.channel('room-' + code);
    ['rooms', 'people', 'votes'].forEach(function (kind) {
      ch.on('postgres_changes',
        { event: '*', schema: 'public', table: T[kind], filter: (kind === 'rooms' ? 'code' : 'room_code') + '=eq.' + code },
        function () { onChange(); });
    });
    ch.subscribe();
    var db = this.db;
    return function () { db.removeChannel(ch); };
  };

  // ---------------------------------------------------------------- local
  var KEY = 'pintu_nyc_rooms_v1';
  function LocalStore() {
    this.mode = 'local';
    this.bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pintu-nyc') : null;
  }
  LocalStore.prototype._all = function () {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
  };
  LocalStore.prototype._save = function (all, code) {
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) { /* private mode: in-memory only */ }
    if (this.bc) this.bc.postMessage(code);
    this._emit(code);
  };
  LocalStore.prototype._emit = function (code) {
    (this._subs || []).forEach(function (s) { if (s.code === code) s.fn(); });
  };
  LocalStore.prototype._room = function (code) {
    var all = this._all();
    if (!all[code]) throw new Error('Room not found');
    return all;
  };
  LocalStore.prototype.createRoom = async function (name) {
    var all = this._all(), code = newCode();
    while (all[code]) code = newCode();
    all[code] = { room: { code: code, name: name, meet: null, bill: null, created_at: new Date().toISOString() }, people: [], votes: [] };
    this._save(all, code);
    return code;
  };
  LocalStore.prototype.load = async function (code) {
    var r = this._all()[code];
    return r ? JSON.parse(JSON.stringify(r)) : null;
  };
  LocalStore.prototype.addPerson = async function (code, p) {
    var all = this._room(code);
    var row = { id: uuid(), room_code: code, name: p.name, origin: p.origin || null, venmo: p.venmo || null, created_at: new Date().toISOString() };
    all[code].people.push(row);
    this._save(all, code);
    return row;
  };
  LocalStore.prototype._findPerson = function (all, id) {
    for (var code in all) {
      var i = all[code].people.findIndex(function (p) { return p.id === id; });
      if (i >= 0) return { code: code, i: i };
    }
    return null;
  };
  LocalStore.prototype.updatePerson = async function (id, patch) {
    var all = this._all(), f = this._findPerson(all, id);
    if (!f) return;
    Object.assign(all[f.code].people[f.i], patch);
    this._save(all, f.code);
  };
  LocalStore.prototype.removePerson = async function (id) {
    var all = this._all(), f = this._findPerson(all, id);
    if (!f) return;
    all[f.code].people.splice(f.i, 1);
    all[f.code].votes = all[f.code].votes.filter(function (v) { return v.person_id !== id; });
    this._save(all, f.code);
  };
  LocalStore.prototype.updateRoom = async function (code, patch) {
    var all = this._room(code);
    Object.assign(all[code].room, patch);
    this._save(all, code);
  };
  LocalStore.prototype.vote = async function (code, personId, venue, vote) {
    var all = this._room(code), votes = all[code].votes;
    var i = votes.findIndex(function (v) { return v.person_id === personId && v.venue_id === venue.id; });
    var row = { room_code: code, person_id: personId, venue_id: venue.id, venue: venue, vote: vote };
    if (i >= 0) votes[i] = row; else votes.push(row);
    this._save(all, code);
  };
  LocalStore.prototype.subscribe = function (code, onChange) {
    var self = this, sub = { code: code, fn: onChange };
    this._subs = (this._subs || []).concat(sub);
    var onMsg = function (e) { if (e.data === code) onChange(); };
    var onStorage = function (e) { if (e.key === KEY) onChange(); };
    if (this.bc) this.bc.addEventListener('message', onMsg);
    window.addEventListener('storage', onStorage);
    return function () {
      self._subs = self._subs.filter(function (s) { return s !== sub; });
      if (self.bc) self.bc.removeEventListener('message', onMsg);
      window.removeEventListener('storage', onStorage);
    };
  };

  function createStore(config) {
    if (config && config.SUPABASE_URL && config.SUPABASE_ANON_KEY && root.supabase) {
      return new CloudStore(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
    }
    return new LocalStore();
  }

  root.PintuStore = { createStore: createStore, newCode: newCode };
})(window);

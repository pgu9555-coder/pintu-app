/* Pintu NYC — app UI.
 * Hash routes (one screen each, see design/v1):
 *   #/                 Home                 #/meet            Create or join a meetup room
 *   #/r/CODE           Where everyone starts #/r/CODE/spots  Meetup spots (ranked stops)
 *   #/r/CODE/food      Food blind box        #/r/CODE/room   Room code and members
 *   #/r/CODE/ledger    Trip ledger           #/ledger        Start a ledger
 *   #/spin             Who pays · Spinner    #/trips         My trips
 */
(function () {
  'use strict';

  var CFG = window.PINTU_CONFIG || {};
  var store = window.PintuStore.createStore(CFG);
  var Split = window.PintuSplit, Places = window.PintuPlaces;
  var $app = document.getElementById('app');

  var subway = null, stationIdx = {};
  // Avatar slots cycle through the four accents; the same index drives the
  // avatar, the name colour on Results, and the map pin.
  var SLOT = ['c0', 'c1', 'c2', 'c3'];
  var SLOT_HEX = ['#E89A7E', '#5E8A6E', '#3E6E8E', '#B8842A'];
  var SLOT_INK = ['#C05B3C', '#3F6E52', '#3E6E8E', '#8F6418'];

  // Screen state. Room data (S.data) is reloaded from the store; everything else is UI memory.
  var S = {
    route: null, code: null, data: null, me: null, unsub: null, dirty: false, tripFilter: 'all',
    map: null, optionsKey: '', options: [], optionsPeople: [], addingFriend: false, originHits: {},
    venueKind: 'food', venueRadius: 600, venues: {}, venueLoading: false, venueError: '', pickId: null, foodFilter: 'all',
  };

  // ------------------------------------------------------------ icons (copied from the mockups)
  var ICON = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    ticket: '<path d="M3 9a3 3 0 0 0 0 6v3h18v-3a3 3 0 0 0 0-6V6H3z"/>',
    route: '<circle cx="9" cy="8" r="3"/><path d="M9 11v2"/><path d="M4 20l5-7 5 7"/><path d="M15 5l5 0"/><path d="M18 2l3 3-3 3"/>',
    spin: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    dollar: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M14.5 9.5c-.4-.9-1.3-1.3-2.5-1.3-1.4 0-2.4.7-2.4 1.7 0 2.4 5 1.2 5 3.7 0 1-1.1 1.8-2.6 1.8-1.3 0-2.3-.5-2.7-1.4"/><path d="M12 7v1.2M12 15.4v1.1"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    pin: '<path d="M12 21s-6-5.4-6-11a6 6 0 0 1 12 0c0 5.6-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
    people: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.6c2.2.2 3.6 1.6 4 4"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
    locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2"/><circle cx="15" cy="15" r="1.2"/><circle cx="15" cy="9" r="1.2"/><circle cx="9" cy="15" r="1.2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    food: '<path d="M3 12h18a9 9 0 0 1-18 0z"/><path d="M8 8c0-2 1-3 2-3M12 8c0-2 1-3 2-3M16 8c0-2 1-3 2-3"/>',
  };
  function icon(name, cls) {
    return '<svg class="icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + ICON[name] + '</svg>';
  }

  // ------------------------------------------------------------ helpers
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function mins(sec) { return Math.max(1, Math.round(sec / 60)); }
  var toastTimer;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function fail(e) { console.error(e); toast(e && e.message ? e.message : 'Something went wrong — try again.'); }
  function bullet(r) {
    var wide = r.label.length > 1 ? ' wide' : '';
    return '<span class="bullet' + wide + '" style="background:' + r.color + ';color:' + r.text + '" title="' +
      esc(r.label) + ' train">' + esc(r.label) + '</span>';
  }
  function stationBullets(st) {
    return '<span class="bullets">' + st.routes.map(function (r) { return bullet(subway.routes[r]); }).join('') + '</span>';
  }
  function legsHTML(legs) {
    if (!legs.length) return '<span class="walk">walk</span>';
    return '<span class="bullets">' + legs.map(function (l) { return bullet(subway.routes[l.route]); })
      .join('<span class="walk" aria-hidden="true">›</span>') + '</span>';
  }
  function placesHTML(st) {
    if (!st.places || !st.places.count) return '';
    var n = st.places.count, approx = n >= 100 ? Math.round(n / 10) * 10 : n;
    var top = st.places.top.length ? ' · ' + st.places.top.slice(0, 3).map(esc).join(', ') : '';
    return '<div class="places num">' + (n >= 100 ? '~' : '') + approx + ' places to eat within 10 min' + top + '</div>';
  }
  function initial(name) { return esc((name || '?').trim().charAt(0).toUpperCase() || '?'); }
  function avatar(p, i, size) {
    return '<span class="avatar' + (size ? ' ' + size : '') + ' ' + SLOT[i % SLOT.length] + '" aria-hidden="true">' + initial(p.name) + '</span>';
  }
  function peopleList() { return (S.data && S.data.people) || []; }
  function personIndex(id) { return peopleList().findIndex(function (p) { return p.id === id; }); }
  function personName(id) { var p = peopleList()[personIndex(id)]; return p ? p.name : 'Someone'; }
  function roomUrl(code) { return location.origin + location.pathname + '#/r/' + code; }

  // Small per-browser memory. Every read and write is guarded: private mode can throw.
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function getMe(code) { return lsGet('pintu_me_' + code); }
  function setMe(code, id) { lsSet('pintu_me_' + code, id); S.me = id; }
  function savedName() { return lsGet('pintu_name') || ''; }

  var TRIPS_KEY = 'pintu_trips_v1';
  function loadTrips() {
    try {
      var list = JSON.parse(lsGet(TRIPS_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function saveTrips(list) { lsSet(TRIPS_KEY, JSON.stringify(list)); }
  /** Remember a room this browser has opened (the Trips screen lists these). */
  function rememberTrip(code, name, kind) {
    var list = loadTrips().filter(function (t) { return t.code !== code; });
    list.unshift({ code: code, name: name, kind: kind, lastOpened: Date.now() });
    saveTrips(list.slice(0, 200));
  }

  function toSubwayOrigin(o) {
    if (!o) return null;
    if (o.station) return stationIdx[o.station] === undefined ? null : { station: stationIdx[o.station] };
    if (typeof o.lat === 'number') return { lat: o.lat, lon: o.lon };
    return null;
  }

  // ------------------------------------------------------------ hangout time (New York)
  function nyNow() {
    var parts = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())
      .forEach(function (x) { parts[x.type] = x.value; });
    return { date: parts.year + '-' + parts.month + '-' + parts.day, time: parts.hour + ':' + parts.minute };
  }
  /** {date, time, dow (0=Sun), min (minutes after midnight), isNow} */
  function hangoutTime() {
    var w = S.data && S.data.room.meet_time;
    var isNow = !(w && w.date && w.time);
    var base = isNow ? nyNow() : w;
    var hm = base.time.split(':');
    return { date: base.date, time: base.time, dow: new Date(base.date + 'T00:00:00Z').getUTCDay(),
      min: (+hm[0]) * 60 + (+hm[1]), isNow: isNow };
  }
  function currentPeriod() { return window.PintuSubway.Subway.periodFor(hangoutTime()); }
  function periodLabel(id) {
    var p = subway.periods.find(function (x) { return x.id === id; });
    return p ? p.label.toLowerCase() : '';
  }
  window.PintuApp = { hangoutTime: hangoutTime, partySize: function () { return peopleList().length || 2; } };

  // ------------------------------------------------------------ routing
  function parseRoute(hash) {
    var h = (hash || '').replace(/^#/, '').replace(/\/+$/, '');
    var m = h.match(/^\/r\/([A-Za-z0-9]{6})(?:\/(spots|food|room|ledger))?$/i);
    if (m) {
      var sub = (m[2] || '').toLowerCase();
      return { name: { '': 'where', spots: 'spots', food: 'food', room: 'share', ledger: 'ledger' }[sub], code: m[1].toUpperCase() };
    }
    if (h === '/meet') return { name: 'meet' };
    if (h === '/ledger') return { name: 'ledger_new' };
    if (h === '/spin') return { name: 'spin' };
    if (h === '/trips') return { name: 'trips' };
    return { name: 'home' };
  }

  function route() {
    var r = parseRoute(location.hash);
    if (!r.code) leaveRoom();
    if (r.name === 'home') return renderHome();
    if (r.name === 'trips') return renderTrips();
    if (r.name === 'meet') return renderMeet();
    if (r.name === 'spin' || r.name === 'ledger_new') return renderPlaceholder(r);
    return routeRoom(r);
  }

  function leaveRoom() {
    if (S.unsub) S.unsub();
    if (S.map) { S.map.remove(); S.map = null; }
    S.unsub = null; S.data = null; S.code = null; S.me = null; S.dirty = false;
  }

  // ------------------------------------------------------------ shell
  function topbar(title, back, right) {
    return '<header class="topbar">' +
      (back ? '<a class="back" href="' + esc(back) + '" aria-label="Back">' +
        '<svg class="icon" viewBox="0 0 24 24" style="stroke-width:2.2" aria-hidden="true">' + ICON.back + '</svg></a>' : '<span class="slot"></span>') +
      '<h1>' + esc(title) + '</h1>' + (right || '<span class="slot"></span>') + '</header>';
  }
  function tabbar(active) {
    return '<nav class="tabbar" aria-label="Main">' +
      '<a href="#/" ' + (active === 'home' ? 'aria-current="page"' : '') + '>' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">' + ICON.home + '</svg>Home</a>' +
      '<a href="#/trips" ' + (active === 'trips' ? 'aria-current="page"' : '') + '>' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">' + ICON.ticket + '</svg>Trips</a>' +
      '</nav>';
  }
  function footerHTML() {
    var valid = subway && subway.validTo ? ' (schedules valid through ' +
      subway.validTo.replace(/(\d{4})(\d{2})(\d{2})/, '$2/$3/$1') + ')' : '';
    return '<footer class="footer-note">Subway times estimated from MTA schedules' + valid + ', not live service.<br>' +
      'Map © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors © CARTO. ' +
      'Places from OpenStreetMap; restaurant counts from NYC DOHMH inspection data.</footer>';
  }
  function show(html) {
    if (S.map) { S.map.remove(); S.map = null; }
    $app.innerHTML = html;
  }
  function isTyping() {
    var a = document.activeElement;
    return !!a && $app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  }
  function isBusy() { return isTyping() || throwing || !!(drag && drag.moved); }

  // ------------------------------------------------------------ home
  function renderHome() {
    document.title = 'Pintu — the fair place to meet in NYC';
    show('<main class="screen has-tabs"><div class="content">' +
      '<div class="home-head"><h1>Pintu</h1>' +
        '<nav class="legal" aria-label="Pintu pages">' +
          '<a href="#/">Privacy</a><a href="#/">Terms</a><a href="#/">Contact</a>' +
          '<button type="button" data-act="backup">Backup &amp; restore</button>' +
        '</nav></div>' +
      '<form class="panel join-card" id="joinForm">' +
        '<div class="head"><span class="tile gold lg">' + icon('ticket') + '</span>' +
          '<div><h2 class="heading-md">Join a room</h2>' +
          '<p>Enter any meetup or ledger code to jump straight in.</p></div></div>' +
        '<label class="field"><span class="sr">Your name</span>' +
          '<input class="input" name="me" maxlength="40" placeholder="Your name" autocomplete="given-name" value="' + esc(savedName()) + '"></label>' +
        '<div class="input-row"><label class="grow" style="display:block"><span class="sr">Room code</span>' +
          '<input class="input code num" name="code" maxlength="6" placeholder="6-character room code" autocapitalize="characters" autocomplete="off" spellcheck="false"></label>' +
        '<button class="btn btn-primary" type="submit">Join</button></div>' +
      '</form>' +
      '<h3 class="section-label">Quick tools</h3>' +
      toolCard('#/meet', 'blue', 'route', 'Fair meetup · Food blind box', 'The subway stop that\'s fair for everyone, then swipe for a place to eat') +
      toolCard('#/spin', 'coral', 'spin', 'Who pays · Spinner', 'Whose round is it? Spin and let fate decide') +
      toolCard('#/ledger', 'pink', 'dollar', 'Trip ledger', 'Everyone pays as you go — settle up in one tap') +
      footerHTML() +
      '</div>' + tabbar('home') + '</main>');
  }
  function toolCard(href, tone, ico, title, sub) {
    return '<a class="card-link tool-card" href="' + href + '">' +
      '<span class="tile ' + tone + '">' + icon(ico) + '</span>' +
      '<span class="txt"><span class="t">' + esc(title) + '</span><span class="s">' + esc(sub) + '</span></span>' +
      '<span class="go">' + icon('arrow', 'sm') + '</span></a>';
  }

  function handleJoinHome(form) {
    var name = form.me.value.trim();
    var code = form.code.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) { toast('Codes are 6 letters and numbers.'); return; }
    if (!name) { toast('Add your name so the group knows who you are.'); return; }
    lsSet('pintu_name', name);
    location.hash = '#/r/' + code;
  }

  // ------------------------------------------------------------ trips
  function dayStart(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function renderTrips() {
    document.title = 'My trips · Pintu';
    var all = loadTrips(), f = S.tripFilter;
    var list = all.filter(function (t) { return f === 'all' || t.kind === (f === 'ledgers' ? 'ledger' : 'meetup'); });
    var weekAgo = dayStart(Date.now()) - 6 * 864e5, today = dayStart(Date.now());
    var recent = list.filter(function (t) { return t.lastOpened >= weekAgo; });
    var earlier = list.filter(function (t) { return t.lastOpened < weekAgo; });

    function row(t) {
      var ledger = t.kind === 'ledger';
      var live = t.lastOpened >= today ? '<span class="pill live"><span class="live-dot" aria-hidden="true"></span>Live</span>' : '';
      return '<a class="card-link trip-card" href="#/r/' + esc(t.code) + (ledger ? '/ledger' : '') + '">' +
        '<span class="tile ' + (ledger ? 'pink' : 'blue') + '">' + icon(ledger ? 'receipt' : 'pin') + '</span>' +
        '<span class="txt"><span class="t">' + esc(t.name) + '</span>' +
        '<span class="s">' + (ledger ? 'Trip ledger' : 'Meetup') + ' · room <span class="num">' + esc(t.code) + '</span></span></span>' +
        live + '</a>';
    }
    var body = '';
    if (!all.length) {
      body = '<div class="trip-empty"><p>No trips yet. Start a meetup or a ledger and it will show up here.</p>' +
        '<a class="btn btn-primary" href="#/meet">Find a fair meetup</a></div>';
    } else if (!list.length) {
      body = '<div class="empty">Nothing here for this filter.</div>';
    } else {
      if (recent.length) body += '<h3 class="section-label">This week</h3><div class="trip-list">' + recent.map(row).join('') + '</div>';
      if (earlier.length) body += '<h3 class="section-label">Earlier</h3><div class="trip-list">' + earlier.map(row).join('') + '</div>';
    }
    var chip = function (key, label) {
      return '<button class="chip" type="button" data-act="trip-filter" data-f="' + key + '" aria-pressed="' + (f === key) + '">' + label + '</button>';
    };
    show('<main class="screen has-tabs"><div class="content">' +
      '<h1 class="screen-title" style="text-align:center;font-size:19px">My trips</h1>' +
      '<div class="chip-row" role="group" aria-label="Filter trips">' + chip('all', 'All') + chip('meetups', 'Meetups') + chip('ledgers', 'Ledgers') + '</div>' +
      body +
      '<p class="footer-note" style="margin-top:6px">Saved on this phone. Use Backup &amp; restore to move them.</p>' +
      '</div>' + tabbar('trips') + '</main>');
  }

  function renderPlaceholder(r) {
    show('<main class="screen">' + topbar('Pintu', '#/') + '<div class="content"><p class="muted">Rebuilding this screen.</p></div></main>');
  }

  // ------------------------------------------------------------ meetup room: create / join
  function renderMeet() {
    document.title = 'Find the middle · Pintu';
    show('<main class="screen">' + topbar('Find the middle', '#/') +
      '<div class="content">' +
      '<section class="panel room-create" aria-labelledby="mtTitle">' +
        '<div class="header-line"><span class="tile green lg">' + icon('people') + '</span>' +
          '<div class="head-txt"><h2 class="heading-md" id="mtTitle">Meetup room</h2>' +
          '<p>Create a room and share the link — friends add where they\'re coming from.</p></div></div>' +
        '<form class="stack" id="createForm">' +
          '<label class="name-field"><span class="sr">Your name</span>' +
            icon('person', 'sm') +
            '<input name="me" maxlength="40" placeholder="Your name" autocomplete="given-name" required value="' + esc(savedName()) + '"></label>' +
          '<button class="btn btn-mid btn-lg btn-block" type="submit">+ Create room</button>' +
        '</form>' +
        '<form class="input-row" id="joinRoomForm">' +
          '<label class="grow" style="display:block"><span class="sr">Room code</span>' +
            '<input class="input code num" name="code" maxlength="6" placeholder="6-character code" autocapitalize="characters" autocomplete="off" spellcheck="false"></label>' +
          '<button class="btn btn-outline" type="submit">Join room</button>' +
        '</form>' +
      '</section>' +
      '</div></main>');
  }

  async function createRoomFromForm(form) {
    var name = form.me.value.trim();
    if (!name) { form.me.focus(); return; }
    lsSet('pintu_name', name);
    var btn = form.querySelector('button'); btn.disabled = true;
    try {
      var code = await store.createRoom(name + '’s meetup');
      var me = await store.addPerson(code, { name: name });
      setMe(code, me.id);
      location.hash = '#/r/' + code;
    } catch (err) { fail(err); btn.disabled = false; }
  }

  // ------------------------------------------------------------ room: load and route
  function renderNotFound(code) {
    show('<main class="screen">' + topbar('Room not found', '#/meet') +
      '<div class="content"><div class="panel"><p>We couldn\'t find a meetup with code <b class="num">' + esc(code) + '</b>.</p>' +
      (store.mode === 'local' ? '<p class="small muted">This copy of Pintu is running in local mode, so rooms only exist in the browser that made them.</p>' : '') +
      '<a class="btn btn-primary" href="#/meet">Start a new meetup</a></div></div></main>');
  }

  async function routeRoom(r) {
    var code = r.code;
    if (S.code !== code) { leaveRoom(); S.code = code; }
    S.route = r.name;
    if (!S.data) {
      show('<main class="screen"><div class="boot">Opening ' + esc(code) + '…</div></main>');
      try { S.data = await store.load(code); } catch (err) { fail(err); }
      if (S.code !== code) return;   // the user has moved on
      if (!S.data) return renderNotFound(code);
      S.unsub = store.subscribe(code, refresh);
    }
    S.me = meFor(code);
    rememberTrip(code, S.data.room.name, S.data.room.bill && S.data.room.bill.kind === 'ledger' ? 'ledger' : 'meetup');
    render();
    refresh();
  }

  function meFor(code) {
    var me = getMe(code);
    return me && peopleList().some(function (p) { return p.id === me; }) ? me : null;
  }

  var refreshing = false, refreshAgain = false;
  async function refresh() {
    if (!S.code) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    var code = S.code;
    try {
      var d = await store.load(code);
      if (d && S.code === code) { S.data = d; S.me = meFor(code) || S.me; render(); }
    } catch (err) { console.warn(err); }
    refreshing = false;
    if (refreshAgain) { refreshAgain = false; refresh(); }
  }

  // Redraw the current room screen. Waits while someone is typing or swiping
  // so a remote change never wipes out what they are doing.
  function render() {
    if (!S.data || !S.code) return;
    if (isBusy()) { S.dirty = true; return; }
    S.dirty = false;
    var R = {
      where: renderWhere, spots: renderSpots, food: renderFood, share: renderShare, ledger: renderLedgerRoute,
    }[S.route];
    if (R) R();
  }
  function flush() { if (S.dirty && !isBusy()) render(); }
  $app.addEventListener('focusout', function () { setTimeout(flush, 0); });

  function roomHeaderRight() {
    return '<a class="room-pill num" href="#/r/' + esc(S.code) + '/room" aria-label="Room code ' + esc(S.code) + ', share the room">' + esc(S.code) + '</a>';
  }
  function roomHeaderBack(parent) { return '#/r/' + S.code + (parent || ''); }

  // ------------------------------------------------------------ 1 where everyone starts
  function whenLabel(t) {
    if (t.isNow) return 'now';
    var hm = t.time.split(':'), h = +hm[0], ap = h >= 12 ? 'PM' : 'AM';
    return DAY_NAMES[t.dow] + ' ' + ((h % 12) || 12) + ':' + hm[1] + ' ' + ap;
  }
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function renderWhere() {
    var t = hangoutTime(), people = peopleList(), me = S.me;
    var addingFriend = S.addingFriend;
    var html = '<main class="screen">' + topbar('Find the middle', '#/meet', roomHeaderRight()) +
      '<div class="content">' +
      '<section class="panel where-panel" aria-labelledby="whereTitle">' +
        '<div class="intro"><h2 class="screen-title" id="whereTitle">Where\'s everyone coming from?</h2>' +
        '<p>We\'ll find the subway stop where nobody\'s trip is long.</p></div>' +
        '<div class="when-bar" role="group" aria-label="When are you leaving?">' +
          '<span class="lead">' + icon('clock', 'sm') + 'Leaving</span>' +
          '<button type="button" class="chip" data-act="when-now" aria-pressed="' + t.isNow + '">Now</button>' +
          '<input type="date" class="input when-input num" id="whenDate" value="' + esc(t.date) + '" aria-label="Date">' +
          '<input type="time" class="input when-input num" id="whenTime" value="' + esc(t.time) + '" step="900" aria-label="Time">' +
          '<span class="caption grow" style="flex-basis:100%">' + (subway ? 'Using ' + esc(periodLabel(currentPeriod())) + ' subway service' : '') + '</span>' +
        '</div>' +
        '<div class="section-label" style="display:flex;align-items:center;gap:8px;color:var(--ink-soft)">' + icon('people', 'sm') + 'Starting points</div>' +
        (!people.length ? '<div class="empty">Nobody yet. Add yourself first.</div>' : '') +
        people.map(function (p, i) { return personCardHTML(p, i); }).join('') +
        (me ? '' : joinAsHTML()) +
        (addingFriend
          ? '<form class="add-friend-form" id="addFriendForm"><label class="grow" style="display:block"><span class="sr">Friend\'s name</span>' +
            '<input class="input" name="name" maxlength="40" placeholder="Friend\'s name" autocomplete="off" required></label>' +
            '<button class="btn btn-primary" type="submit">Add</button></form>'
          : '<button class="btn btn-dashed btn-block" type="button" data-act="add-friend">+ Add a friend</button>') +
      '</section>' +
      '<a class="btn btn-primary btn-lg btn-block" href="#/r/' + esc(S.code) + '/spots">Find meetup spots</a>' +
      '</div></main>';
    show(html);
    if (addingFriend) { var f = $('#addFriendForm input'); if (f) setTimeout(function () { f.focus(); }, 0); }
    S.addingFriend = false;
  }

  function personCardHTML(p, i) {
    var mine = p.id === S.me, origin = p.origin && p.origin.label;
    return '<div class="person-card" data-person="' + esc(p.id) + '">' +
      '<div class="person-head">' + avatar(p, i, 'lg') +
        '<span class="nm">' + esc(p.name) + (mine ? '<span class="tag-you">You</span>' : '') + '</span>' +
        '<span class="grow"></span>' +
        (mine ? '' : '<button class="remove" type="button" data-act="remove-person" data-id="' + esc(p.id) + '" aria-label="Remove ' + esc(p.name) + '">×</button>') +
      '</div>' +
      '<form class="origin-box" data-origin-form="' + esc(p.id) + '" role="search">' +
        '<label class="grow" style="display:block"><span class="sr">' + esc(p.name) + '\'s starting point</span>' +
          '<input class="input-inline" name="q" value="' + esc(origin || '') + '" autocomplete="off" enterkeyhint="search" ' +
          'placeholder="Address, cross streets or a subway stop"></label>' +
        '<button class="locate" type="button" data-act="locate" data-id="' + esc(p.id) + '" aria-label="Use ' + (mine ? 'my' : esc(p.name) + '\'s') + ' location">' +
          icon('locate', 'sm') + 'Locate</button>' +
      '</form>' +
      '<div class="results-box" data-origin-results="' + esc(p.id) + '" hidden></div>' +
      (origin ? '' : '<div class="person-note">No starting point yet</div>') +
      '</div>';
  }

  function joinAsHTML() {
    return '<form class="panel tight" id="joinAsForm" style="gap:10px">' +
      '<div class="heading-sm">Who are you?</div>' +
      '<div class="input-row"><label class="grow" style="display:block"><span class="sr">Your name</span>' +
      '<input class="input" name="name" maxlength="40" placeholder="Your name" autocomplete="given-name" required value="' + esc(savedName()) + '"></label>' +
      '<button class="btn btn-primary" type="submit">Join</button></div></form>';
  }

  function setWhen(value) {
    S.data.room.meet_time = value;  // optimistic
    render();
    store.updateRoom(S.code, { meet_time: value }).catch(fail);
  }

  async function searchOriginInline(pid, q) {
    var box = $('[data-origin-results="' + pid + '"]');
    if (!box || !q) return;
    var stations = subway.searchStations(q, 4).map(function (s) {
      return { label: s.name + ' station', station: subway.stations[s.station].id };
    });
    function paint(addresses, note) {
      var hits = stations.concat(addresses);
      S.originHits = S.originHits || {};
      S.originHits[pid] = hits;
      var b = $('[data-origin-results="' + pid + '"]');
      if (!b) return;
      b.hidden = false;
      var body = hits.length ? hits.map(function (r, i) {
        var extra = r.station ? '<span class="small muted">subway</span>' : '<span class="small muted">address</span>';
        return '<button type="button" data-act="pick-origin" data-pid="' + esc(pid) + '" data-i="' + i + '"><span class="grow">' + esc(r.label) + '</span>' + extra + '</button>';
      }).join('') : '<div class="none">' + esc(note || 'No matches. Try cross streets like "Bedford & N 7th".') + '</div>';
      if (hits.length && note) body += '<div class="none">' + esc(note) + '</div>';
      b.innerHTML = body;
    }
    paint([], 'Searching addresses…');
    try {
      var addrs = await Places.geocode(q);
      paint(addrs.map(function (a) { return { label: a.label, lat: +a.lat.toFixed(5), lon: +a.lon.toFixed(5) }; }));
    } catch (err) { paint([], err.message); }
  }

  async function saveOrigin(pid, origin) {
    var p = peopleList()[personIndex(pid)];
    if (!p) return;
    p.origin = origin;   // optimistic
    render();
    try { await store.updatePerson(pid, { origin: origin }); } catch (err) { fail(err); refresh(); }
  }

  function locateFor(pid) {
    if (!navigator.geolocation) { toast('Location is not available here — search an address instead.'); return; }
    var btn = $('[data-act="locate"][data-id="' + pid + '"]');
    if (btn) btn.disabled = true;
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      var near = subway.nearbyStations(lat, lon)[0];
      saveOrigin(pid, { label: 'Near ' + subway.stations[near.station].name, lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
    }, function () {
      if (btn) btn.disabled = false;
      toast('Couldn\'t get your location — search an address instead.');
    }, { enableHighAccuracy: false, timeout: 10000 });
  }

  // ------------------------------------------------------------ 2 spots (ranked stops + map)
  function computeOptions() {
    var people = peopleList().filter(function (p) { return toSubwayOrigin(p.origin); });
    var period = currentPeriod();
    var key = JSON.stringify([period, people.map(function (p) { return [p.id, p.origin]; })]);
    if (key !== S.optionsKey) {
      S.optionsKey = key;
      S.optionsPeople = people;
      S.options = people.length >= 2 ? subway.fairMeet(people.map(function (p) { return toSubwayOrigin(p.origin); }), 3, period) : [];
    }
    return { people: S.optionsPeople, options: S.options };
  }

  // Times for a specific station (used when the chosen stop isn't in the top 3 anymore).
  function evaluateStation(people, idx) {
    var times = [], paths = [];
    people.forEach(function (p) {
      var r = subway.timesFrom(toSubwayOrigin(p.origin), currentPeriod());
      times.push(r.time[idx]); paths.push(r.path(idx));
    });
    return { station: idx, times: times, paths: paths, max: Math.max.apply(null, times),
      total: times.reduce(function (a, b) { return a + b; }, 0) };
  }

  function renderSpots() {
    var meet = S.data.room.meet, t = hangoutTime();
    var res = computeOptions(), people = res.people, options = res.options.slice();
    var chosenIdx = meet && stationIdx[meet.station] !== undefined ? stationIdx[meet.station] : -1;
    var head = topbar('Meetup spots', roomHeaderBack(''), roomHeaderRight());
    if (people.length < 2) {
      return show('<main class="screen">' + head + '<div class="content">' +
        '<div class="panel"><div class="empty">Add at least two starting points and Pintu will find the stop where nobody\'s trip is long.</div>' +
        '<a class="btn btn-outline btn-block" href="#/r/' + esc(S.code) + '">Add starting points</a></div>' +
        '</div></main>');
    }
    if (chosenIdx >= 0 && !options.some(function (o) { return o.station === chosenIdx; })) {
      options.unshift(evaluateStation(people, chosenIdx));
    }
    var longest = Math.max.apply(null, options.map(function (o) { return o.max; }));
    var fastest = Math.min.apply(null, options.map(function (o) { return mins(o.max); }));

    var html = '<main class="screen">' + head + '<div class="content">' +
      '<div class="map-card"><div id="map" role="img" aria-label="Map of everyone\'s starting points and suggested stops"></div></div>' +
      '<p class="leaving-line">Leaving <b>' + esc(whenLabel(t)) + '</b> · ranked by the longest trip, among stops with plenty to eat.</p>';
    options.forEach(function (o, k) {
      var st = subway.stations[o.station], chosen = o.station === chosenIdx;
      var extra = mins(o.max) - fastest;
      html += '<article class="option' + (chosen ? ' chosen' : '') + '">' +
        '<div class="option-head"><span class="option-rank">' + (k + 1) + '</span>' +
          '<div class="option-title"><h2>' + esc(st.name) + '</h2>' + stationBullets(st) + placesHTML(st) + '</div>' +
          '<div class="option-max"><div class="big num">' + mins(o.max) + '<span> min</span></div><div class="cap">longest trip</div>' +
            (extra >= 2 ? '<div class="plus num">+' + extra + ' min</div>' : '') + '</div></div>' +
        '<div class="trip-rows">' + people.map(function (p, i) {
          var pi = personIndex(p.id), bar = Math.round(100 * o.times[i] / longest);
          return '<div class="trip-row"><span class="who" style="color:' + SLOT_INK[pi % 4] + '">' + esc(p.name) + '</span>' +
            '<span class="mins num">' + mins(o.times[i]) + ' min</span>' +
            '<span class="via">' + legsHTML(o.paths[i]) + '<span class="bar"><i style="width:' + bar + '%;background:' + SLOT_HEX[pi % 4] + '"></i></span></span></div>';
        }).join('') + '</div>' +
        (chosen
          ? '<div class="option-actions"><span class="meeting-here">' + icon('check', 'sm') + 'Meeting here</span>' +
            '<a class="btn btn-primary btn-pick" href="#/r/' + esc(S.code) + '/food">Pick food</a></div>'
          : '<button class="btn btn-outline btn-block" type="button" data-act="meet" data-station="' + o.station + '">Meet here</button>') +
        '</article>';
    });
    html += '<p class="disclaimer">Estimated from MTA schedules for that time — check live service before you go.</p>' +
      footerHTML() + '</div></main>';
    show(html);
    drawMap(people, options, chosenIdx);
  }

  function drawMap(people, options, chosenIdx) {
    var el = $('#map');
    if (!window.L || !el) return;
    var map = L.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 18, subdomains: 'abcd',
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/">CARTO</a>',
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    var pts = [];
    people.forEach(function (p) {
      var o = p.origin, lat = o.lat, lon = o.lon;
      if (o.station) { var st = subway.stations[stationIdx[o.station]]; lat = st.lat; lon = st.lon; }
      var pi = personIndex(p.id);
      L.marker([lat, lon], { icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13],
        html: '<div class="map-pin" style="background:' + SLOT_HEX[pi % 4] + '">' + initial(p.name) + '</div>' }), title: p.name }).addTo(map);
      pts.push([lat, lon]);
    });
    options.forEach(function (o, k) {
      var st = subway.stations[o.station];
      L.marker([st.lat, st.lon], { zIndexOffset: 1000, icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15],
        html: '<div class="map-pin map-opt' + (o.station === chosenIdx ? ' chosen' : '') + '">' + (k + 1) + '</div>' }), title: st.name }).addTo(map);
      pts.push([st.lat, st.lon]);
    });
    map.fitBounds(pts, { padding: [28, 28], maxZoom: 14 });
    S.map = map;
  }

  // ------------------------------------------------------------ 3 food (blind box)
  var RESERVABLE = { restaurant: true, bar: true, pub: true, cafe: true };
  var SWIPE_PX = 100, FLICK_PX_PER_MS = 0.5, THROW_MS = 200, SPRING_MS = 260;

  var drag = null;          // the card under the pointer: {card, id, x0, lastX, lastT, dx, vel, moved}
  var throwing = false;     // a card is flying off; don't re-render under it

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function spotKey() { var meet = S.data.room.meet; return meet.station + ':' + S.venueKind + ':' + S.venueRadius; }
  function voteTally() {
    var tally = {};
    (S.data.votes || []).forEach(function (v) {
      if (personIndex(v.person_id) < 0) return;
      var t = tally[v.venue_id] || (tally[v.venue_id] = { venue: v.venue, yes: [], no: [] });
      (v.vote > 0 ? t.yes : t.no).push(v.person_id);
    });
    return tally;
  }
  function isClosedAt(v, t) { return window.PintuHours.isOpenAt(v.hours, t.dow, t.min) === false; }
  // Opening status for the card: {text, cls: 'open' | 'closed'}, or null when the hours are unknown.
  function hoursStatus(v, t) {
    var H = window.PintuHours, i = H.info(v.hours, t.dow, t.min);
    if (!i) return null;
    var text;
    if (t.isNow) text = H.describe(v.hours, t.dow, t.min).replace(/^Closed then/, 'Closed now').replace(/^Closed that day/, 'Closed today');
    else {
      var day = DAY_NAMES[t.dow], at = H.formatTime(t.min);
      if (i.open) text = 'Open at ' + at + ' ' + day + (i.always ? ' · 24 hours' : ' · until ' + i.closes);
      else text = 'Closed ' + day + ' ' + at + (i.opens ? ' · opens ' + i.opens : '');
    }
    return { text: text, cls: i.open ? 'open' : 'closed' };
  }
  function bookingLinksHTML(v, t) {
    var n = Math.min(20, Math.max(1, window.PintuApp.partySize()));
    var opentable = 'https://www.opentable.com/s?term=' + encodeURIComponent(v.name) + '&covers=' + n +
      '&dateTime=' + t.date + 'T' + t.time + '&latitude=' + v.lat + '&longitude=' + v.lon;
    var resy = 'https://resy.com/cities/new-york-ny/search?query=' + encodeURIComponent(v.name) +
      '&date=' + t.date + '&seats=' + n;
    return '<a href="' + esc(opentable) + '" target="_blank" rel="noopener" title="Search OpenTable for a table">OpenTable</a>' +
      '<a href="' + esc(resy) + '" target="_blank" rel="noopener" title="Search Resy for a table">Resy</a>';
  }
  function cuisineList(list) {
    var count = {};
    list.forEach(function (v) {
      (v.cuisine || '').split(' · ').forEach(function (c) { if (c) count[c] = (count[c] || 0) + 1; });
    });
    return Object.keys(count).sort(function (a, b) { return count[b] - count[a] || (a < b ? -1 : 1); }).slice(0, 3);
  }

  // One place for every vote: buttons, swipes and arrow keys. Optimistic, so the
  // next card shows at once; the store is updated in the background.
  async function castVote(venueId, vote) {
    if (!S.me || !S.code || !S.data || !S.data.room.meet) return;
    var venue = (S.venues[spotKey()] || []).find(function (x) { return x.id === venueId; });
    if (!venue) return;
    S.pickId = null;
    S.data.votes = (S.data.votes || []).filter(function (x) { return !(x.person_id === S.me && x.venue_id === venue.id); })
      .concat([{ person_id: S.me, venue_id: venue.id, venue: venue, vote: vote }]);
    render();
    try { await store.vote(S.code, S.me, venue, vote); } catch (err) { fail(err); refresh(); }
  }

  // Fly the card off-screen (dir +1 = yes, -1 = pass), then vote.
  function throwCard(card, dir) {
    var venueId = card.dataset.vid;
    throwing = true;
    if (reducedMotion()) return finishThrow(venueId, dir);
    card.style.transition = 'transform ' + THROW_MS + 'ms ease-in, opacity ' + THROW_MS + 'ms ease-in';
    card.style.transform = 'translateX(' + dir * (window.innerWidth + 200) + 'px) rotate(' + dir * 20 + 'deg)';
    card.style.opacity = '0';
    setTimeout(function () { finishThrow(venueId, dir); }, THROW_MS);
  }
  function finishThrow(venueId, vote) {
    throwing = false;
    castVote(venueId, vote);
  }
  // Snap a card that was let go too early back into place.
  function springBack(card) {
    card.querySelectorAll('.stamp').forEach(function (s) { s.style.opacity = ''; });
    card.style.transition = 'transform ' + SPRING_MS + 'ms ease-out';
    card.style.transform = '';
    setTimeout(function () { card.style.transition = ''; flush(); }, reducedMotion() ? 0 : SPRING_MS);
  }

  $app.addEventListener('pointerdown', function (e) {
    if (drag || throwing) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('a, button, input, select, textarea')) return;   // links and buttons keep working
    var card = e.target.closest('.venue-card');
    if (!card) return;
    drag = { card: card, id: e.pointerId, x0: e.clientX, lastX: e.clientX, lastT: e.timeStamp, dx: 0, vel: 0, moved: false };
    try { card.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  $app.addEventListener('pointermove', function (e) {
    var d = drag;
    if (!d || e.pointerId !== d.id) return;
    var dx = e.clientX - d.x0, dt = e.timeStamp - d.lastT;
    if (dt > 0) { d.vel = (e.clientX - d.lastX) / dt; d.lastX = e.clientX; d.lastT = e.timeStamp; }
    if (!d.moved && Math.abs(dx) < 6) return;   // a tap, not a swipe
    d.moved = true; d.dx = dx;
    d.card.classList.add('dragging');
    d.card.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 15) + 'deg)';
    var share = Math.min(1, Math.abs(dx) / SWIPE_PX);
    d.card.querySelector('.stamp.yes').style.opacity = dx > 0 ? share : 0;
    d.card.querySelector('.stamp.no').style.opacity = dx < 0 ? share : 0;
  });
  function endDrag(e) {
    var d = drag;
    if (!d || e.pointerId !== d.id) return;
    drag = null;
    d.card.classList.remove('dragging');
    if (!d.moved) return flush();
    // A release after a pause isn't a flick, however fast the drag was before it.
    var vel = e.timeStamp - d.lastT > 80 ? 0 : d.vel;
    var flick = Math.abs(vel) > FLICK_PX_PER_MS && (vel > 0) === (d.dx > 0);
    if (e.type === 'pointerup' && (Math.abs(d.dx) > SWIPE_PX || flick)) throwCard(d.card, d.dx > 0 ? 1 : -1);
    else springBack(d.card);
  }
  $app.addEventListener('pointerup', endDrag);
  $app.addEventListener('pointercancel', endDrag);

  function renderFood() {
    var meet = S.data.room.meet, t = hangoutTime();
    var head = topbar('Food blind box', roomHeaderBack('/spots'), '<span class="slot" id="foodCount"></span>');
    if (!meet) {
      return show('<main class="screen">' + head + '<div class="content"><div class="panel"><div class="empty">Choose where to meet first, then everyone swipes on places nearby.</div>' +
        '<a class="btn btn-outline btn-block" href="#/r/' + esc(S.code) + '/spots">Pick a meetup spot</a></div></div></main>');
    }
    var key = spotKey();
    var list = S.venues[key];
    if (!list && !S.venueLoading && !S.venueError) loadVenues(key, meet);

    var tally = voteTally(), total = peopleList().length;
    var myVotes = {};
    (S.data.votes || []).forEach(function (v) { if (v.person_id === S.me) myVotes[v.venue_id] = v.vote; });
    var filter = S.foodFilter || 'all';
    var cuisines = list ? cuisineList(list) : [];
    var chip = function (key, label) {
      return '<button class="chip" type="button" data-act="food-filter" data-f="' + esc(key) + '" aria-pressed="' + (filter === key) + '">' + esc(label) + '</button>';
    };
    var filters = '<div class="filters" role="group" aria-label="Filter places">' + chip('all', 'All') + chip('open', 'Open then') +
      cuisines.map(function (c) { return chip('c:' + c, c); }).join('') + '</div>';

    var body = '';
    var seen = 0, card = '';
    if (S.venueError) {
      body = '<div class="error">' + esc(S.venueError) + '</div><button class="btn btn-outline btn-block" type="button" data-act="retry">Try again</button>';
    } else if (!list) {
      body = '<div class="empty">Finding places near ' + esc(meet.name) + '…</div>';
    } else if (!S.me) {
      body = '<div class="panel"><div class="empty">Join the meetup to vote on places.</div><a class="btn btn-outline btn-block" href="#/r/' + esc(S.code) + '">Join the meetup</a></div>';
    } else {
      seen = list.filter(function (v) { return myVotes[v.id] !== undefined; }).length;
      var queue = list.filter(function (v) { return myVotes[v.id] === undefined; });
      if (filter === 'open') queue = queue.filter(function (v) { return !isClosedAt(v, t); });
      else if (filter.indexOf('c:') === 0) queue = queue.filter(function (v) { return (v.cuisine || '').split(' · ').indexOf(filter.slice(2)) >= 0; });
      // Places that are closed at the planned time go to the back; the rest keep their order.
      queue = queue.filter(function (v) { return !isClosedAt(v, t); }).concat(queue.filter(function (v) { return isClosedAt(v, t); }));
      var picked = S.pickId && queue.find(function (v) { return v.id === S.pickId; });
      if (picked) queue = [picked].concat(queue.filter(function (v) { return v.id !== picked.id; }));
      if (queue.length) {
        var v = queue[0], walk = mins(window.PintuSubway.walkSec(v.meters));
        var status = hoursStatus(v, t);
        var liked = tally[v.id] ? tally[v.id].yes.length : 0;
        var reserve = RESERVABLE[v.kind];
        card = '<article class="venue-card" tabindex="0" aria-label="' + esc(v.name) + '" data-vid="' + esc(v.id) + '">' +
          '<span class="stamp yes" aria-hidden="true">YES</span><span class="stamp no" aria-hidden="true">PASS</span>' +
          '<div class="venue-art">' + icon('food') +
            (status ? '<span class="pill-tl ' + (status.cls === 'open' ? 'open' : 'closed') + '">' + esc(status.text) + '</span>' : '') +
            '<span class="pill-tr num">' + walk + ' min walk</span></div>' +
          '<div class="venue-body">' +
            '<div><div class="eyebrow-c">' + esc(v.cuisine || labelFor(v.kind)) + '</div>' +
            '<h2>' + esc(v.name) + '</h2>' +
            '<div class="sub">' + esc(labelFor(v.kind)) + ' · near ' + esc(meet.name) + (liked ? ' · ' + liked + ' liked it' : '') + '</div></div>' +
            '<div class="venue-tags">' + (reserve ? '<span style="background:var(--blue-tint);color:var(--blue)">Takes reservations</span>' : '') +
              (v.website ? '<span style="background:var(--line-soft);color:var(--ink-soft)">Has a website</span>' : '') + '</div>' +
            '<div class="venue-links">' +
              '<a href="' + esc(Places.googleMapsLink(v)) + '" target="_blank" rel="noopener">Map</a>' +
              (reserve ? bookingLinksHTML(v, t) : (v.website ? '<a href="' + esc(v.website) + '" target="_blank" rel="noopener">Website</a>' : '')) +
            '</div></div></article>';
        body = '<div class="deck"><div class="stack-wrap"><div class="stack-back b2"></div><div class="stack-back b1"></div>' + card + '</div></div>' +
          '<div class="round-controls">' +
            '<button class="round-btn skip" type="button" data-act="vote" data-v="' + esc(v.id) + '" data-vote="-1" aria-label="Pass on ' + esc(v.name) + '">' + icon('x') + '</button>' +
            '<button class="round-btn dice" type="button" data-act="dice" aria-label="Pick a random place for me">' + icon('dice') + '</button>' +
            '<button class="round-btn like" type="button" data-act="vote" data-v="' + esc(v.id) + '" data-vote="1" aria-label="I\'d go to ' + esc(v.name) + '">' + icon('heart') + '</button>' +
          '</div>' +
          '<p class="footer-note" style="margin-top:0">In a room, a place everyone likes becomes a match.</p>';
      } else {
        body = '<div class="panel"><div class="empty">' + (filter === 'all' ? 'You\'ve seen all ' + list.length + ' places within ' + S.venueRadius + ' m.' : 'No more places match this filter.') +
          '</div>' + (S.venueRadius < 1000 ? '<button class="btn btn-outline btn-block" type="button" data-act="wider">Show places a bit farther away</button>' : '') +
          (filter !== 'all' ? '<button class="btn btn-outline btn-block" type="button" data-act="food-filter" data-f="all">Show all places</button>' : '') + '</div>';
      }
    }

    var picks = Object.keys(tally).map(function (id) { return tally[id]; })
      .filter(function (p) { return p.yes.length; })
      .sort(function (a, b) { return b.yes.length - a.yes.length || a.no.length - b.no.length; }).slice(0, 8);
    var picksHTML = !picks.length ? '<div class="empty">Places someone likes will show up here.</div>' :
      '<div class="group-picks">' + picks.map(function (p) {
        var closed = isClosedAt(p.venue, t);
        return '<div class="pick"><span class="count num' + (p.yes.length === total ? ' all' : '') + '">' + p.yes.length + '</span>' +
          '<div class="pname">' + esc(p.venue.name) + (closed ? ' <span class="closed-tag">Closed then</span>' : '') +
            '<div class="likes">' + esc(p.yes.map(personName).join(', ')) + (p.yes.length === total ? ' — everyone' : '') + '</div></div>' +
          '<a class="btn btn-sm btn-outline-quiet" target="_blank" rel="noopener" href="' + esc(Places.googleMapsLink(p.venue)) + '">Map</a></div>';
      }).join('') + '</div>';

    var keepFocus = $app.querySelector('.venue-card') && document.activeElement && document.activeElement.classList.contains('venue-card');
    show('<main class="screen">' + head + '<div class="content">' + filters + body +
      '<h3 class="section-label" style="margin-top:6px">Group picks</h3>' + picksHTML + '</div></main>');
    var count = $('#foodCount');
    if (count && list && S.me) count.textContent = (seen + 1 > list.length ? list.length : seen + 1) + ' / ' + list.length;
    if (keepFocus) { var c = $app.querySelector('.venue-card'); if (c) c.focus({ preventScroll: true }); }
  }

  function labelFor(kind) {
    return { restaurant: 'Restaurant', fast_food: 'Quick bite', food_court: 'Food hall', bar: 'Bar', pub: 'Pub',
      biergarten: 'Beer garden', cafe: 'Café', ice_cream: 'Dessert' }[kind] || 'Place';
  }

  async function loadVenues(key, meet) {
    S.venueLoading = true;
    try {
      var list = await Places.venues(meet.lat, meet.lon, S.venueKind || 'food', S.venueRadius);
      S.venues[key] = list.slice(0, 40);
      S.venueError = '';
    } catch (err) {
      S.venueError = err.message;
    }
    S.venueLoading = false;
    if (S.data && S.route === 'food') render();
  }

  // ------------------------------------------------------------ room code + members
  function renderShare() {
    var room = S.data.room, people = peopleList(), ready = people.filter(function (p) { return p.origin; }).length;
    var tally = voteTally(), total = people.length;
    var matches = Object.keys(tally).map(function (id) { return tally[id]; })
      .filter(function (p) { return total >= 2 && p.yes.length === total; });
    var html = '<main class="screen">' + topbar('Meetup room', roomHeaderBack(''), '<span class="slot"></span>') +
      '<div class="content">' +
      '<section class="code-card" aria-label="Room code">' +
        '<div class="top"><span class="label">Room code</span>' +
          '<span class="live">' + (store.mode === 'cloud' ? '<span class="live-dot" aria-hidden="true"></span>Live' : 'This browser') + '</span></div>' +
        '<div class="code num">' + esc(room.code) + '</div>' +
        '<div class="actions">' +
          '<button class="btn btn-light" type="button" data-act="copy-link" aria-live="polite">' + icon('share', 'sm') + 'Copy invite link</button>' +
          '<button class="btn btn-glass" type="button" data-act="share">Share…</button>' +
        '</div></section>' +
      (store.mode === 'local' ? '<div class="notice">Local demo mode: this room lives in this browser only. Add Supabase keys in <code>js/config.js</code> to share across phones.</div>' : '') +
      '<section class="panel members" style="padding:6px 16px" aria-labelledby="inRoom">' +
        '<div class="members-head"><h2 class="heading-sm" id="inRoom">In this room</h2>' +
        '<span class="caption num">' + ready + ' of ' + total + ' ready</span></div>' +
        (people.length ? people.map(function (p, i) {
          var mine = p.id === S.me;
          return '<div class="member">' + avatar(p, i, 'lg') +
            '<div class="who"><span class="n">' + esc(p.name) + (mine ? '<span class="tag-you">You</span>' : '') + '</span>' +
            (p.origin ? '<span class="s">' + esc(p.origin.label) + '</span>' : '<span class="s wait">Adding a starting point…</span>') + '</div>' +
            (p.origin ? '<span class="tick">' + '<svg class="icon sm" viewBox="0 0 24 24" aria-label="Ready" role="img">' + ICON.check + '</svg></span>' : '') + '</div>';
        }).join('') : '<div class="empty">Nobody yet.</div>') +
      '</section>' +
      (matches.length
        ? '<section class="match-banner" role="status"><svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>' +
          '<span><b>It\'s a match:</b> everyone liked ' + esc(matches[0].venue.name) + '</span>' +
          '<a href="#/r/' + esc(S.code) + '/food">See</a></section>'
        : '') +
      '<a class="btn btn-primary btn-lg btn-block" href="#/r/' + esc(S.code) + '/spots">Find meetup spots</a>' +
      '</div></main>';
    show(html);
  }

  function renderLedgerRoute() { return renderPlaceholder({ name: 'ledger' }); }

  // ------------------------------------------------------------ invite
  function inviteText() { return 'Join "' + S.data.room.name + '" on Pintu — add where you\'re coming from and we\'ll find the fair place to meet.'; }
  async function copyInvite(btn) {
    var url = roomUrl(S.code);
    try {
      await navigator.clipboard.writeText(inviteText() + ' ' + url);
      btn.innerHTML = icon('check', 'sm') + 'Copied';
      setTimeout(function () { if (btn.isConnected) btn.innerHTML = icon('share', 'sm') + 'Copy invite link'; }, 2500);
    } catch (e) { prompt('Copy this invite link:', url); }
  }
  async function shareInvite() {
    var url = roomUrl(S.code);
    if (navigator.share) {
      try { await navigator.share({ title: 'Pintu', text: inviteText(), url: url }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    toast('Sharing isn\'t available here — use Copy invite link.');
  }

  // ------------------------------------------------------------ actions
  var ACTIONS = {
    'trip-filter': function (t) { S.tripFilter = t.dataset.f; renderTrips(); },
    'when-now': function () { setWhen(null); },
    'add-friend': function () { S.addingFriend = true; render(); },
    'remove-person': async function (t) {
      var p = peopleList()[personIndex(t.dataset.id)];
      if (!p || !confirm('Remove ' + p.name + ' from this meetup?')) return;
      try { await store.removePerson(p.id); if (p.id === S.me) { S.me = null; lsSet('pintu_me_' + S.code, ''); } refresh(); }
      catch (err) { fail(err); }
    },
    'locate': function (t) { locateFor(t.dataset.id); },
    'pick-origin': function (t) {
      var hit = (S.originHits && S.originHits[t.dataset.pid] || [])[+t.dataset.i];
      if (!hit) return;
      var origin = hit.station ? { label: hit.label, station: hit.station } : { label: hit.label, lat: hit.lat, lon: hit.lon };
      saveOrigin(t.dataset.pid, origin);
    },
    'meet': async function (t) {
      var st = subway.stations[+t.dataset.station];
      t.disabled = true;
      try {
        S.data.room.meet = { station: st.id, name: st.name, lat: st.lat, lon: st.lon, by: S.me };   // optimistic
        render();
        await store.updateRoom(S.code, { meet: S.data.room.meet });
        toast('Meeting at ' + st.name);
      } catch (err) { fail(err); refresh(); }
    },
    'food-filter': function (t) { S.foodFilter = t.dataset.f; S.pickId = null; render(); },
    'retry': function () { S.venueError = ''; render(); },
    'wider': function () { S.venueRadius = 1000; render(); },
    'dice': function () {
      var list = S.venues[spotKey()] || [], mine = {};
      (S.data.votes || []).forEach(function (v) { if (v.person_id === S.me) mine[v.venue_id] = true; });
      var pool = list.filter(function (v) { return !mine[v.id]; });
      if (!pool.length) return toast('No places left to pick from.');
      S.pickId = pool[Math.floor(Math.random() * pool.length)].id;
      render();
    },
    'vote': function (t) { castVote(t.dataset.v, +t.dataset.vote); },
    'copy-link': function (t) { copyInvite(t); },
    'share': function () { shareInvite(); },
    'backup': function () { if (window.PintuBackup) window.PintuBackup.open(); },
  };
  $app.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || !ACTIONS[t.dataset.act]) return;
    ACTIONS[t.dataset.act](t, e);
  });
  $app.addEventListener('change', function (e) {
    if (e.target.id !== 'whenDate' && e.target.id !== 'whenTime') return;
    var d = $('#whenDate').value, tm = $('#whenTime').value;
    if (d && tm) setWhen({ date: d, time: tm });
  });
  $app.addEventListener('submit', function (e) {
    var f = e.target;
    e.preventDefault();
    if (f.id === 'joinForm') return handleJoinHome(f);
    if (f.id === 'createForm') return createRoomFromForm(f);
    if (f.id === 'joinRoomForm') {
      var code = f.code.value.trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) { toast('Codes are 6 letters and numbers.'); return; }
      var typed = $('#createForm input[name="me"]');
      if (typed && typed.value.trim()) lsSet('pintu_name', typed.value.trim());
      location.hash = '#/r/' + code;
      return;
    }
    if (f.id === 'joinAsForm') {
      var name = f.name.value.trim();
      if (!name) return;
      lsSet('pintu_name', name);
      store.addPerson(S.code, { name: name }).then(function (row) {
        setMe(S.code, row.id); refresh();
      }).catch(fail);
      return;
    }
    if (f.id === 'addFriendForm') {
      var fname = f.name.value.trim();
      if (!fname) return;
      store.addPerson(S.code, { name: fname }).then(function () { refresh(); }).catch(fail);
      return;
    }
    if (f.hasAttribute('data-origin-form')) {
      var pid = f.getAttribute('data-origin-form'), q = f.q.value.trim();
      if (q) searchOriginInline(pid, q);
    }
  });

  // ------------------------------------------------------------ boot
  async function boot() {
    try {
      var res = await fetch('data/subway.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      subway = new window.PintuSubway.Subway(await res.json());
      subway.stations.forEach(function (st) { stationIdx[st.id] = st.idx; });
      try {
        var vres = await fetch('data/venues.json');
        if (vres.ok) subway.setPlaces(await vres.json());
      } catch (e) { console.warn('venues.json not loaded; ranking by time only', e); }
    } catch (err) {
      $app.innerHTML = '<div class="error" style="margin:40px 16px">Couldn\'t load the subway map (' + esc(err.message) + '). Refresh to try again.</div>';
      return;
    }
    window.addEventListener('hashchange', route);
    route();
  }

  boot();
})();

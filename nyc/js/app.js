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

  var S = { route: null, code: null, data: null, me: null, unsub: null, dirty: false, tripFilter: 'all' };

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
  var PARENT = { meet: '#/', where: '#/meet', spots: '#/r/', food: '#/r/', share: '#/r/', ledger: '#/', ledger_new: '#/', spin: '#/' };

  function parseRoute(hash) {
    var h = (hash || '').replace(/^#/, '').replace(/\/+$/, '');
    var m = h.match(/^\/r\/([A-Za-z0-9]{6})(?:\/(spots|food|room|ledger))?$/i);
    if (m) {
      var sub = (m[2] || '').toLowerCase();
      var name = { '': 'where', spots: 'spots', food: 'food', room: 'share', ledger: 'ledger' }[sub];
      return { name: name, code: m[1].toUpperCase() };
    }
    if (h === '/meet') return { name: 'meet' };
    if (h === '/ledger') return { name: 'ledger_new' };
    if (h === '/spin') return { name: 'spin' };
    if (h === '/trips') return { name: 'trips' };
    return { name: 'home' };
  }

  function route() {
    var r = parseRoute(location.hash);
    if (r.code && r.code !== S.code) leaveRoom();
    if (r.code) S.code = r.code;
    S.route = r.name;
    if (r.name === 'home') return renderHome();
    if (r.name === 'trips') return renderTrips();
    return renderPlaceholder(r);
  }

  function leaveRoom() {
    if (S.unsub) S.unsub();
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
  function show(html) { $app.innerHTML = html; }

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
      '<a class="card-link tool-card" href="#/meet">' +
        '<span class="tile blue">' + icon('route') + '</span>' +
        '<span class="txt"><span class="t">Fair meetup · Food blind box</span>' +
        '<span class="s">The subway stop that\'s fair for everyone, then swipe for a place to eat</span></span>' +
        '<span class="go">' + icon('arrow', 'icon sm') + '</span></a>' +
      '<a class="card-link tool-card" href="#/spin">' +
        '<span class="tile coral">' + icon('spin') + '</span>' +
        '<span class="txt"><span class="t">Who pays · Spinner</span>' +
        '<span class="s">Whose round is it? Spin and let fate decide</span></span>' +
        '<span class="go">' + icon('arrow', 'icon sm') + '</span></a>' +
      '<a class="card-link tool-card" href="#/ledger">' +
        '<span class="tile pink">' + icon('dollar') + '</span>' +
        '<span class="txt"><span class="t">Trip ledger</span>' +
        '<span class="s">Everyone pays as you go — settle up in one tap</span></span>' +
        '<span class="go">' + icon('arrow', 'icon sm') + '</span></a>' +
      footerHTML() +
      '</div>' + tabbar('home') + '</main>');
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

  // ------------------------------------------------------------ placeholder (replaced screen by screen)
  function renderPlaceholder(r) {
    show('<main class="screen">' + topbar('Pintu', '#/') + '<div class="content"><p class="muted">Rebuilding this screen.</p></div></main>');
  }

  // ------------------------------------------------------------ events (delegated)
  var ACTIONS = {
    'trip-filter': function (t) { S.tripFilter = t.dataset.f; renderTrips(); },
  };
  $app.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || !ACTIONS[t.dataset.act]) return;
    ACTIONS[t.dataset.act](t, e);
  });
  $app.addEventListener('submit', function (e) {
    e.preventDefault();
    if (e.target.id === 'joinForm') handleJoinHome(e.target);
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

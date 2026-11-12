/* Pintu NYC — app UI.
 * Routes: "#/" home, "#/r/CODE" a hangout room.
 * Sections in a room: Who's coming → 1 Where to meet → 2 Pick a spot → 3 Split the bill.
 */
(function () {
  'use strict';

  var CFG = window.PINTU_CONFIG || {};
  var store = window.PintuStore.createStore(CFG);
  var Split = window.PintuSplit, Places = window.PintuPlaces;
  var $app = document.getElementById('app');
  // Subway line colors, minus green (reserved for "chosen").
  var PEOPLE_COLORS = ['#0039A6', '#EE352E', '#FF6319', '#B933AD', '#996633', '#0078C6', '#6D6E71', '#C99A00'];

  var subway = null, stationIdx = {};
  var S = freshState();

  function freshState() {
    return {
      code: null, data: null, unsub: null, me: null,
      map: null, mapLayer: null, optionsKey: '', options: [],
      venueKind: 'food', venueRadius: 600, venues: {}, venueLoading: false, venueError: '',
      billTimer: null,
    };
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
    return '<div class="places small muted num">' + (n >= 100 ? '~' : '') + approx + ' places to eat within 10 min' + top + '</div>';
  }
  function personColor(i) { return PEOPLE_COLORS[i % PEOPLE_COLORS.length]; }
  function initial(name) { return esc((name || '?').trim().charAt(0).toUpperCase() || '?'); }
  function peopleList() { return (S.data && S.data.people) || []; }
  function personIndex(id) { return peopleList().findIndex(function (p) { return p.id === id; }); }
  function personName(id) { var p = peopleList()[personIndex(id)]; return p ? p.name : 'Someone'; }
  function roomUrl(code) { return location.origin + location.pathname + '#/r/' + code; }
  function meKey(code) { return 'pintu_me_' + code; }
  function getMe(code) { try { return localStorage.getItem(meKey(code)); } catch (e) { return null; } }
  function setMe(code, id) { try { localStorage.setItem(meKey(code), id); } catch (e) { /* ignore */ } S.me = id; }

  function toSubwayOrigin(o) {
    if (!o) return null;
    if (o.station) return stationIdx[o.station] === undefined ? null : { station: stationIdx[o.station] };
    if (typeof o.lat === 'number') return { lat: o.lat, lon: o.lon };
    return null;
  }

  // ------------------------------------------------------------ hangout time
  // When the group plans to go, in New York time. room.meet_time is
  // {date: 'YYYY-MM-DD', time: 'HH:MM'}, or null for "leaving now".
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
  function route() {
    var m = location.hash.match(/^#\/r\/([A-Za-z0-9]{6})/);
    if (m) openRoom(m[1].toUpperCase());
    else renderHome();
  }

  function leaveRoom() {
    if (S.unsub) S.unsub();
    if (S.map) { S.map.remove(); }
    S = freshState();
  }

  // ------------------------------------------------------------ home
  function renderHome() {
    leaveRoom();
    document.title = 'Pintu — the fair place to meet in NYC';
    $app.innerHTML =
      '<header class="sign"><h1>Pintu</h1><span class="code">NYC</span></header>' +
      '<section class="hero">' +
        '<p class="lead">The fair place to meet in New York.</p>' +
        '<p>Everyone drops where they\'re coming from. Pintu finds the subway stop where nobody\'s trip is long, then helps you pick a spot and split the bill.</p>' +
      '</section>' +
      '<form class="card" id="createForm">' +
        '<div class="label">Start a hangout</div>' +
        '<label class="field"><span class="small muted">What\'s the plan?</span>' +
          '<input class="input" name="room" maxlength="60" placeholder="Friday ramen" required></label>' +
        '<label class="field"><span class="small muted">Your name</span>' +
          '<input class="input" name="me" maxlength="40" placeholder="Alex" autocomplete="given-name" required></label>' +
        '<button class="btn primary block" type="submit">Create and get an invite link</button>' +
      '</form>' +
      '<form class="card" id="joinForm">' +
        '<div class="label">Got a code?</div>' +
        '<div class="row"><input class="input grow num" name="code" maxlength="6" placeholder="6-character code" ' +
          'autocapitalize="characters" autocomplete="off" style="text-transform:uppercase;letter-spacing:.12em">' +
        '<button class="btn" type="submit">Join</button></div>' +
      '</form>' +
      '<ol class="how card">' +
        '<li><span class="step">1</span><div><b>Where to meet</b><span class="muted small">Ranked by the longest trip in the group, using real subway schedules.</span></div></li>' +
        '<li><span class="step">2</span><div><b>Pick a spot</b><span class="muted small">Everyone swipes on places near the stop. Matches float to the top.</span></div></li>' +
        '<li><span class="step">3</span><div><b>Split the bill</b><span class="muted small">NYC tax and tip included, with Venmo links to settle up.</span></div></li>' +
      '</ol>' + footerHTML();

    $('#createForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var f = e.target, btn = f.querySelector('button');
      btn.disabled = true;
      try {
        var code = await store.createRoom(f.room.value.trim());
        var me = await store.addPerson(code, { name: f.me.value.trim() });
        setMe(code, me.id);
        location.hash = '#/r/' + code;
      } catch (err) { fail(err); btn.disabled = false; }
    });
    $('#joinForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var code = e.target.code.value.trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) { toast('Codes are 6 letters and numbers.'); return; }
      location.hash = '#/r/' + code;
    });
  }

  function footerHTML() {
    var valid = subway && subway.validTo ? ' (schedules valid through ' +
      subway.validTo.replace(/(\d{4})(\d{2})(\d{2})/, '$2/$3/$1') + ')' : '';
    return '<footer>Subway times estimated from MTA schedules' + valid + ', not live service.<br>' +
      'Map © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors © CARTO. ' +
      'Places from OpenStreetMap; restaurant counts from NYC DOHMH inspection data.</footer>';
  }

  // ------------------------------------------------------------ room
  async function openRoom(code) {
    if (S.code !== code) {
      leaveRoom();
      S.code = code;
      $app.innerHTML = '<div class="boot">Opening ' + esc(code) + '…</div>';
    }
    try {
      S.data = await store.load(code);
    } catch (err) { fail(err); }
    if (S.code !== code) return;
    if (!S.data) {
      $app.innerHTML = '<header class="sign"><a class="home" href="#/">Pintu</a><h1>Room not found</h1></header>' +
        '<div class="card"><p>We couldn\'t find a hangout with code <b class="num">' + esc(code) + '</b>.</p>' +
        (store.mode === 'local' ? '<p class="small muted">This copy of Pintu is running in local mode, so rooms only exist in the browser that made them.</p>' : '') +
        '<a class="btn primary" href="#/">Start a new hangout</a></div>';
      return;
    }
    var me = getMe(code);
    S.me = me && peopleList().some(function (p) { return p.id === me; }) ? me : null;
    renderRoomShell();
    renderAll();
    if (!S.unsub) S.unsub = store.subscribe(code, refresh);
    if (!S.me) openPersonDialog(null, true);
    else {
      var mine = peopleList()[personIndex(S.me)];
      if (mine && !mine.origin) openPersonDialog(S.me, false);  // e.g. right after creating the room
    }
  }

  var refreshing = false, refreshAgain = false;
  async function refresh() {
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
      var d = await store.load(S.code);
      if (d) { S.data = d; renderAll(true); }
    } catch (err) { console.warn(err); }
    refreshing = false;
    if (refreshAgain) { refreshAgain = false; refresh(); }
  }

  function renderRoomShell() {
    var room = S.data.room;
    document.title = room.name + ' · Pintu';
    $app.innerHTML =
      '<header class="sign"><a class="home" href="#/" aria-label="Pintu home">Pintu</a>' +
        '<h1 id="roomName"></h1><span class="code num" title="Room code">' + esc(room.code) + '</span>' +
        '<button class="sign-btn" id="inviteBtn" type="button">Invite</button></header>' +
      (store.mode === 'local'
        ? '<div class="notice">Local demo mode: this hangout lives in this browser only (open it in another tab to see live sync). Add Supabase keys in <code>js/config.js</code> to share across phones.</div>'
        : '') +
      '<section class="section" id="secPeople"></section>' +
      '<section class="section" id="secWhere"></section>' +
      '<section class="section" id="secSpot"></section>' +
      '<section class="section" id="secSplit"></section>' +
      footerHTML() +
      personDialogHTML();
    $('#inviteBtn').addEventListener('click', invite);
    bindPersonDialog();
  }

  function renderAll(fromRemote) {
    $('#roomName').textContent = S.data.room.name;
    renderPeople();
    // Votes and bill edits don't change the meetup options; skip redrawing the map for them.
    var meet = S.data.room.meet;
    var whereKey = JSON.stringify([peopleList().map(function (p) { return [p.id, p.name, p.origin]; }), meet && meet.station,
      S.data.room.meet_time, currentPeriod()]);
    if (whereKey !== S.whereKey || !$('#secWhere').innerHTML) { S.whereKey = whereKey; renderWhere(); bindWhen(); }
    renderSpot();
    renderSplit(fromRemote);
  }

  async function invite() {
    var url = roomUrl(S.code);
    var text = 'Join "' + S.data.room.name + '" on Pintu — add where you\'re coming from and we\'ll find the fair place to meet.';
    if (navigator.share) {
      try { await navigator.share({ title: 'Pintu', text: text, url: url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(text + ' ' + url); toast('Invite link copied — paste it in the group chat'); }
    catch (e) { prompt('Copy this invite link:', url); }
  }

  // ------------------------------------------------------------ people
  function renderPeople() {
    var people = peopleList();
    var html = '<div class="band"><h2>Who\'s coming</h2><span class="hint num">' + people.length + ' ' +
      (people.length === 1 ? 'person' : 'people') + '</span></div><div class="card"><div class="people">';
    if (!people.length) html += '<div class="empty">Nobody yet. Add yourself first.</div>';
    people.forEach(function (p, i) {
      var from = p.origin && p.origin.label
        ? esc(p.origin.label)
        : '<span style="color:var(--bad)">No starting point yet</span>';
      html += '<div class="person"><span class="avatar" style="background:' + personColor(i) + '">' + initial(p.name) + '</span>' +
        '<div class="who"><div class="name">' + esc(p.name) + (p.id === S.me ? '<span class="you">you</span>' : '') + '</div>' +
        '<div class="from">' + from + '</div></div>' +
        '<button class="icon-btn" data-edit="' + esc(p.id) + '" aria-label="Edit ' + esc(p.name) + '">Edit</button></div>';
    });
    html += '</div>';
    if (!S.me) html += '<button class="btn primary block" data-join>Join this hangout</button>';
    html += '<button class="btn ghost" data-add type="button">+ Add a friend who won\'t open the link</button></div>';
    var sec = $('#secPeople');
    sec.innerHTML = html;
    sec.onclick = function (e) {
      var t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.edit) openPersonDialog(t.dataset.edit, false);
      else if (t.hasAttribute('data-join')) openPersonDialog(null, true);
      else if (t.hasAttribute('data-add')) openPersonDialog(null, false);
    };
  }

  // Person dialog: name, starting point (address or station), Venmo.
  var dlg = { personId: null, asMe: false, origin: null };

  function personDialogHTML() {
    return '<dialog id="personDlg"><form method="dialog" id="personForm">' +
      '<h3 id="dlgTitle">Join</h3>' +
      '<label class="field"><span class="small muted">Name</span>' +
        '<input class="input" name="name" maxlength="40" required autocomplete="given-name"></label>' +
      '<div class="field"><span class="small muted">Coming from</span>' +
        '<div id="originChosen" class="notice" hidden></div>' +
        '<div class="row"><input class="input grow" id="originQuery" placeholder="Address, cross streets, or subway stop" autocomplete="off">' +
        '<button class="btn" type="button" id="originSearch">Search</button></div>' +
        '<button class="btn ghost" type="button" id="originGeo" style="align-self:flex-start">Use my current location</button>' +
        '<div id="originResults"></div>' +
        '<span class="small muted">Only used to find a fair stop. Your exact address isn\'t shown to others — just the label you pick.</span></div>' +
      '<label class="field"><span class="small muted">Venmo username (optional, so friends can pay you back)</span>' +
        '<input class="input" name="venmo" maxlength="40" placeholder="@alex-k" autocomplete="off"></label>' +
      '<div class="row"><button class="btn" type="button" id="dlgRemove" style="color:var(--bad)">Remove</button>' +
        '<span class="grow"></span><button class="btn" type="button" id="dlgCancel">Cancel</button>' +
        '<button class="btn primary" type="submit" id="dlgSave">Save</button></div>' +
      '</form></dialog>';
  }

  function setDialogOrigin(o) {
    dlg.origin = o;
    var box = $('#originChosen');
    if (o) { box.hidden = false; box.innerHTML = 'Coming from <b>' + esc(o.label) + '</b>'; }
    else { box.hidden = true; box.innerHTML = ''; }
  }

  function openPersonDialog(personId, asMe) {
    var d = $('#personDlg'), f = $('#personForm');
    var p = personId ? peopleList()[personIndex(personId)] : null;
    dlg.personId = personId; dlg.asMe = asMe;
    $('#dlgTitle').textContent = p ? 'Edit ' + p.name : (asMe ? 'Join ' + S.data.room.name : 'Add a friend');
    f.name.value = p ? p.name : '';
    f.venmo.value = p && p.venmo ? p.venmo : '';
    $('#originQuery').value = '';
    $('#originResults').innerHTML = '';
    setDialogOrigin(p && p.origin ? p.origin : null);
    $('#dlgRemove').hidden = !p;
    $('#originGeo').hidden = !(asMe || (p && p.id === S.me)) || !navigator.geolocation;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    setTimeout(function () { (p ? $('#originQuery') : f.name).focus(); }, 30);
  }

  function closeDialog() { var d = $('#personDlg'); if (d.close) d.close(); else d.removeAttribute('open'); }

  function bindPersonDialog() {
    var f = $('#personForm');
    $('#dlgCancel').onclick = closeDialog;
    $('#originQuery').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); searchOrigin(); }
    });
    $('#originSearch').onclick = searchOrigin;
    $('#originGeo').onclick = function () {
      var btn = this; btn.disabled = true; btn.textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(function (pos) {
        btn.disabled = false; btn.textContent = 'Use my current location';
        var lat = pos.coords.latitude, lon = pos.coords.longitude;
        var near = subway.nearbyStations(lat, lon)[0];
        var label = 'Near ' + subway.stations[near.station].name;
        setDialogOrigin({ label: label, lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
      }, function () {
        btn.disabled = false; btn.textContent = 'Use my current location';
        toast('Couldn\'t get your location — search an address instead.');
      }, { enableHighAccuracy: false, timeout: 10000 });
    };
    $('#originResults').onclick = function (e) {
      var b = e.target.closest('button[data-i]');
      if (!b) return;
      setDialogOrigin(lastOriginResults[+b.dataset.i]);
      $('#originResults').innerHTML = '';
      $('#originQuery').value = '';
    };
    $('#dlgRemove').onclick = async function () {
      var p = peopleList()[personIndex(dlg.personId)];
      if (!p || !confirm('Remove ' + p.name + ' from this hangout?')) return;
      try { await store.removePerson(p.id); closeDialog(); if (p.id === S.me) S.me = null; refresh(); } catch (err) { fail(err); }
    };
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var name = f.name.value.trim();
      if (!name) return;
      var venmo = f.venmo.value.trim().replace(/^@/, '') || null;
      var btn = $('#dlgSave'); btn.disabled = true;
      try {
        if (dlg.personId) {
          await store.updatePerson(dlg.personId, { name: name, origin: dlg.origin, venmo: venmo });
        } else {
          var row = await store.addPerson(S.code, { name: name, origin: dlg.origin, venmo: venmo });
          if (dlg.asMe) setMe(S.code, row.id);
        }
        closeDialog();
        refresh();
        if (!dlg.origin) toast('Add a starting point so it counts toward the meetup spot.');
      } catch (err) { fail(err); }
      btn.disabled = false;
    });
  }

  var lastOriginResults = [];
  async function searchOrigin() {
    var q = $('#originQuery').value.trim(), box = $('#originResults');
    if (!q) return;
    var stations = subway.searchStations(q, 4).map(function (s) {
      return { label: s.name + ' station', station: subway.stations[s.station].id, routes: s.routes };
    });
    lastOriginResults = stations.slice();
    function paint(addresses, note) {
      lastOriginResults = stations.concat(addresses);
      var html = '';
      if (!lastOriginResults.length) html = '<div class="empty">' + (note || 'No matches. Try cross streets like "Bedford & N 7th".') + '</div>';
      else {
        html = '<div class="results">' + lastOriginResults.map(function (r, i) {
          var extra = r.routes ? '<span class="bullets">' + r.routes.map(bullet).join('') + '</span>' : '<span class="small muted">address</span>';
          return '<button type="button" data-i="' + i + '"><span class="grow">' + esc(r.label) + '</span>' + extra + '</button>';
        }).join('') + '</div>';
        if (note) html += '<div class="small muted" style="margin-top:6px">' + esc(note) + '</div>';
      }
      box.innerHTML = html;
    }
    paint([], 'Searching addresses…');
    try {
      var addrs = await Places.geocode(q);
      paint(addrs.map(function (a) { return { label: a.label, lat: +a.lat.toFixed(5), lon: +a.lon.toFixed(5) }; }));
    } catch (err) {
      paint([], err.message);
    }
  }

  // ------------------------------------------------------------ 1 where
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

  function renderWhere() {
    var sec = $('#secWhere');
    var res = computeOptions(), people = res.people, options = res.options.slice();
    var meet = S.data.room.meet;
    var chosenIdx = meet && stationIdx[meet.station] !== undefined ? stationIdx[meet.station] : -1;
    if (chosenIdx >= 0 && people.length >= 2 && !options.some(function (o) { return o.station === chosenIdx; })) {
      options.unshift(evaluateStation(people, chosenIdx));
    }

    var head = '<div class="band"><span class="step">1</span><h2>Where to meet</h2>' +
      (people.length >= 2 ? '<span class="hint">' + (subway.hasPlaces ? 'fair, with lots to eat' : 'fairest first') + '</span>' : '') + '</div>' +
      whenHTML();
    if (people.length < 2) {
      if (S.map) { S.map.remove(); S.map = null; }
      sec.innerHTML = head + '<div class="card"><div class="empty">Add at least two starting points and Pintu will find the stop where nobody\'s trip is long.</div></div>';
      sec.onclick = function (e) { if (e.target.closest('[data-when-now]')) setWhen(null); };
      return;
    }

    var longest = Math.max.apply(null, options.map(function (o) { return o.max; }));
    // "+N min" is relative to the quickest option shown, in displayed minutes.
    var fastestShown = Math.min.apply(null, options.map(function (o) { return mins(o.max); }));
    var html = head + '<div id="map" role="img" aria-label="Map of everyone\'s starting points and suggested stops"></div><div class="options">';
    options.forEach(function (o, k) {
      var st = subway.stations[o.station], chosen = o.station === chosenIdx;
      html += '<div class="option' + (chosen ? ' chosen' : '') + '">' +
        '<div class="option-head"><span class="option-rank">' + (k + 1) + '</span>' +
          '<div class="option-title"><div class="st">' + esc(st.name) + '</div>' + stationBullets(st) + placesHTML(st) + '</div>' +
          '<div class="option-max"><div class="big num">' + mins(o.max) + '<span class="small"> min</span></div><div class="cap">longest trip</div>' +
            (mins(o.max) - fastestShown >= 2 ? '<div class="extra-min num">+' + (mins(o.max) - fastestShown) + ' min vs quickest here</div>' : '') + '</div></div>' +
        '<div class="trips">' + people.map(function (p, i) {
          var pi = personIndex(p.id);
          return '<div class="trip"><span class="tname" style="color:' + personColor(pi) + '">' + esc(p.name) + '</span>' +
            '<span class="tmin num">' + mins(o.times[i]) + ' min</span>' +
            '<span>' + legsHTML(o.paths[i]) + '<div class="bar"><i style="width:' + Math.round(100 * o.times[i] / longest) + '%;background:' + personColor(pi) + '"></i></div></span></div>';
        }).join('') + '</div>' +
        (chosen
          ? '<div class="row"><span class="chosen-badge">✓ Meeting here</span><span class="grow"></span>' +
            '<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=' +
              encodeURIComponent(st.name + ' station ' + st.lat + ',' + st.lon) + '">Open in Maps</a></div>'
          : '<button class="btn primary" data-meet="' + o.station + '">Meet here</button>') +
        '</div>';
    });
    html += '</div><div class="small muted">Times include walking to the station and the usual wait for a train. Check live service before you go.</div>';
    sec.innerHTML = html;
    sec.onclick = async function (e) {
      if (e.target.closest('[data-when-now]')) { setWhen(null); return; }
      var b = e.target.closest('button[data-meet]');
      if (!b) return;
      var st = subway.stations[+b.dataset.meet];
      b.disabled = true;
      try {
        await store.updateRoom(S.code, { meet: { station: st.id, name: st.name, lat: st.lat, lon: st.lon, by: S.me } });
        toast('Meeting at ' + st.name);
        refresh();
      } catch (err) { fail(err); b.disabled = false; }
    };
    drawMap(people, options, chosenIdx);
  }

  function whenHTML() {
    var t = hangoutTime();
    return '<div class="when" role="group" aria-label="When are you leaving?">' +
      '<span class="label">Leaving</span>' +
      '<button type="button" class="chip" data-when-now aria-pressed="' + t.isNow + '">Now</button>' +
      '<input type="date" class="input when-input num" id="whenDate" value="' + esc(t.date) + '" aria-label="Date">' +
      '<input type="time" class="input when-input num" id="whenTime" value="' + esc(t.time) + '" step="900" aria-label="Time">' +
      '<span class="small muted when-note">Using ' + esc(periodLabel(currentPeriod())) + ' subway service</span></div>';
  }

  function setWhen(value) {
    S.data.room.meet_time = value;  // optimistic
    S.whereKey = null; renderAll();
    store.updateRoom(S.code, { meet_time: value }).catch(fail);
  }

  function bindWhen() {
    var sec = $('#secWhere');
    sec.onchange = function (e) {
      if (e.target.id !== 'whenDate' && e.target.id !== 'whenTime') return;
      var d = $('#whenDate').value, t = $('#whenTime').value;
      if (d && t) setWhen({ date: d, time: t });
    };
  }

  function drawMap(people, options, chosenIdx) {
    var el = $('#map');
    if (!window.L || !el) return;
    if (S.map) { S.map.remove(); S.map = null; }
    var dark = document.documentElement.dataset.theme === 'dark' ||
      (document.documentElement.dataset.theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var map = L.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/' + (dark ? 'dark_all' : 'light_all') + '/{z}/{x}/{y}{r}.png', {
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
        html: '<div class="map-pin" style="background:' + personColor(pi) + '">' + initial(p.name) + '</div>' }), title: p.name }).addTo(map);
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

  // ------------------------------------------------------------ 2 spot
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var RESERVABLE = { restaurant: true, bar: true, pub: true, cafe: true };
  var SWIPE_PX = 100, FLICK_PX_PER_MS = 0.5, THROW_MS = 200, SPRING_MS = 260;

  var drag = null;          // the card under the pointer: {card, id, x0, lastX, lastT, dx, vel, moved}
  var throwing = false;     // a card is flying off; don't re-render under it
  var spotDirty = false;    // a render was skipped while swiping; do it when the swipe ends

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function spotKey() {
    var meet = S.data.room.meet;
    return meet.station + ':' + S.venueKind + ':' + S.venueRadius;
  }
  function voteTally() {
    var tally = {};
    (S.data.votes || []).forEach(function (v) {
      if (personIndex(v.person_id) < 0) return;
      var t = tally[v.venue_id] || (tally[v.venue_id] = { venue: v.venue, yes: [], no: [] });
      (v.vote > 0 ? t.yes : t.no).push(v.person_id);
    });
    return tally;
  }
  function isClosedAt(v, t) {
    return window.PintuHours.isOpenAt(v.hours, t.dow, t.min) === false;
  }
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
  // Find-a-table search links, only for places that take reservations.
  function bookingLinksHTML(v, t) {
    if (!RESERVABLE[v.kind]) return '';
    var n = Math.min(20, Math.max(1, window.PintuApp.partySize()));
    var opentable = 'https://www.opentable.com/s?term=' + encodeURIComponent(v.name) + '&covers=' + n +
      '&dateTime=' + t.date + 'T' + t.time + '&latitude=' + v.lat + '&longitude=' + v.lon;
    var resy = 'https://resy.com/cities/new-york-ny/search?query=' + encodeURIComponent(v.name) +
      '&date=' + t.date + '&seats=' + n;
    return '<a class="btn" target="_blank" rel="noopener" href="' + esc(opentable) + '" title="Search OpenTable for a table">OpenTable</a>' +
      '<a class="btn" target="_blank" rel="noopener" href="' + esc(resy) + '" title="Search Resy for a table">Resy</a>';
  }

  // One place for every vote: buttons, swipes and arrow keys. Optimistic, so the
  // next card shows at once; the store is updated in the background.
  async function castVote(venueId, vote) {
    if (!S.me || !S.code || !S.data || !S.data.room.meet) return;
    var venue = (S.venues[spotKey()] || []).find(function (x) { return x.id === venueId; });
    if (!venue) return;
    S.data.votes = (S.data.votes || []).filter(function (x) { return !(x.person_id === S.me && x.venue_id === venue.id); })
      .concat([{ person_id: S.me, venue_id: venue.id, venue: venue, vote: vote }]);
    renderSpot();
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
    setTimeout(function () {
      card.style.transition = '';
      if (spotDirty && !drag) { spotDirty = false; renderSpot(); }
    }, reducedMotion() ? 0 : SPRING_MS);
  }

  function bindSwipe(sec) {
    sec.onpointerdown = function (e) {
      if (drag || throwing) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('a, button, input, select, textarea')) return;   // links and buttons keep working
      var card = e.target.closest('.venue');
      if (!card) return;
      drag = { card: card, id: e.pointerId, x0: e.clientX, lastX: e.clientX, lastT: e.timeStamp, dx: 0, vel: 0, moved: false };
      try { card.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };
    sec.onpointermove = function (e) {
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
    };
    sec.onpointerup = sec.onpointercancel = function (e) {
      var d = drag;
      if (!d || e.pointerId !== d.id) return;
      drag = null;
      d.card.classList.remove('dragging');
      if (!d.moved) { if (spotDirty) { spotDirty = false; renderSpot(); } return; }
      // A release after a pause isn't a flick, however fast the drag was before it.
      var vel = e.timeStamp - d.lastT > 80 ? 0 : d.vel;
      var flick = Math.abs(vel) > FLICK_PX_PER_MS && (vel > 0) === (d.dx > 0);
      if (e.type === 'pointerup' && (Math.abs(d.dx) > SWIPE_PX || flick)) throwCard(d.card, d.dx > 0 ? 1 : -1);
      else springBack(d.card);
    };
    sec.onkeydown = function (e) {
      var card = e.target;
      if (!card.classList || !card.classList.contains('venue') || throwing || drag) return;
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      throwCard(card, e.key === 'ArrowRight' ? 1 : -1);
    };
  }

  function renderSpot() {
    var sec = $('#secSpot'), meet = S.data.room.meet;
    var head = '<div class="band"><span class="step">2</span><h2>Pick a spot</h2>' +
      (meet ? '<span class="hint">near ' + esc(meet.name) + '</span>' : '') + '</div>';
    if (!meet) {
      sec.className = 'section locked';
      sec.innerHTML = head + '<div class="card"><div class="empty">Choose where to meet first, then everyone swipes on places nearby.</div></div>';
      return;
    }
    // Don't swap the deck out from under a card that is being dragged or thrown.
    if ((drag && drag.moved) || throwing) { spotDirty = true; return; }
    spotDirty = false;
    sec.className = 'section';
    var kinds = [['food', 'Food'], ['drinks', 'Drinks'], ['coffee', 'Coffee']];
    var key = spotKey();
    var list = S.venues[key];
    if (!list && !S.venueLoading && !S.venueError) loadVenues(key, meet);

    var t = hangoutTime(), tally = voteTally();
    // Keep keyboard focus on the deck across re-renders (votes, or updates from other phones).
    var keepFocus = sec.contains(document.activeElement) && document.activeElement.classList.contains('venue');
    var myVotes = {};
    (S.data.votes || []).forEach(function (v) { if (v.person_id === S.me) myVotes[v.venue_id] = v.vote; });
    var html = head + '<div class="card"><div class="seg" role="group" aria-label="Category">' + kinds.map(function (k) {
      return '<button class="chip" data-kind="' + k[0] + '" aria-pressed="' + (S.venueKind === k[0]) + '">' + k[1] + '</button>';
    }).join('') + '</div><div class="deck">';

    if (S.venueError) {
      html += '<div class="error">' + esc(S.venueError) + '</div><button class="btn" data-retry>Try again</button>';
    } else if (!list) {
      html += '<div class="empty">Finding places near ' + esc(meet.name) + '…</div>';
    } else {
      var queue = list.filter(function (v) { return myVotes[v.id] === undefined; });
      // Places that are closed at the planned time go to the back; the rest keep their order.
      queue = queue.filter(function (v) { return !isClosedAt(v, t); })
        .concat(queue.filter(function (v) { return isClosedAt(v, t); }));
      if (!S.me) {
        html += '<div class="empty">Join the hangout to vote on places.</div>';
      } else if (queue.length) {
        var v = queue[0], walk = mins(window.PintuSubway.walkSec(v.meters));
        var others = tally[v.id] ? tally[v.id].yes.length : 0;
        var status = hoursStatus(v, t);
        html += '<div class="venue" tabindex="0" role="group" aria-label="' + esc(v.name) + '" data-vid="' + esc(v.id) + '">' +
          '<span class="stamp yes" aria-hidden="true">YES</span><span class="stamp no" aria-hidden="true">PASS</span>' +
          '<div class="label">' + esc(labelFor(v.kind)) + ' · ' + (list.length - queue.length + 1) + ' of ' + list.length + '</div>' +
          '<div class="vname">' + esc(v.name) + '</div>' +
          '<div class="meta">' + (v.cuisine ? '<span>' + esc(v.cuisine) + '</span>' : '') +
            '<span class="num">' + walk + ' min walk from the station</span>' +
            (others ? '<span style="color:var(--good);font-weight:600">' + others + ' liked it</span>' : '') + '</div>' +
          (status ? '<div class="hours ' + status.cls + '">' + esc(status.text) + '</div>' : '') +
          '<div class="row venue-links"><a class="btn" target="_blank" rel="noopener" href="' + esc(Places.googleMapsLink(v)) + '">Reviews</a>' +
            (v.website ? '<a class="btn" target="_blank" rel="noopener" href="' + esc(v.website) + '">Website</a>' : '') +
            bookingLinksHTML(v, t) + '</div></div>' +
          '<div class="vote-row"><button class="btn no" data-vote="-1" data-v="' + esc(v.id) + '">✕ Pass</button>' +
          '<button class="btn yes" data-vote="1" data-v="' + esc(v.id) + '">♥ I\'d go</button></div>';
      } else {
        html += '<div class="empty">You\'ve seen all ' + list.length + ' places within ' + S.venueRadius + ' m.' +
          (S.venueRadius < 1000 ? '' : ' Try another category.') + '</div>' +
          (S.venueRadius < 1000 ? '<button class="btn" data-wider>Show places a bit farther away</button>' : '');
      }
    }
    html += '</div>';

    var picks = Object.keys(tally).map(function (id) { return tally[id]; })
      .filter(function (p) { return p.yes.length; })
      .sort(function (a, b) { return b.yes.length - a.yes.length || a.no.length - b.no.length; }).slice(0, 8);
    var total = peopleList().length;
    html += '<div class="label" style="margin-top:4px">Group picks</div>';
    if (!picks.length) html += '<div class="empty">Places someone likes will show up here.</div>';
    else html += '<div class="picks">' + picks.map(function (p) {
      var closed = isClosedAt(p.venue, t);
      return '<div class="pick"><span class="count num' + (p.yes.length === total ? ' all' : '') + '">' + p.yes.length + '</span>' +
        '<div class="pname">' + esc(p.venue.name) + (closed ? ' <span class="closed-tag">Closed then</span>' : '') +
          '<div class="likes">' + esc(p.yes.map(personName).join(', ')) +
          (p.yes.length === total ? ' — everyone' : '') + '</div></div>' +
        '<a class="btn" target="_blank" rel="noopener" href="' + esc(Places.googleMapsLink(p.venue)) + '">Map</a></div>';
    }).join('') + '</div>';
    html += '</div>';
    sec.innerHTML = html;
    if (keepFocus) {
      var c = sec.querySelector('.venue');
      if (c) c.focus({ preventScroll: true });
    }
    bindSwipe(sec);
    sec.onclick = function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.kind) { S.venueKind = b.dataset.kind; S.venueError = ''; renderSpot(); }
      else if (b.hasAttribute('data-retry')) { S.venueError = ''; renderSpot(); }
      else if (b.hasAttribute('data-wider')) { S.venueRadius = 1000; renderSpot(); }
      else if (b.dataset.vote) castVote(b.dataset.v, +b.dataset.vote);
    };
  }

  function labelFor(kind) {
    return { restaurant: 'Restaurant', fast_food: 'Quick bite', food_court: 'Food hall', bar: 'Bar', pub: 'Pub',
      biergarten: 'Beer garden', cafe: 'Café', ice_cream: 'Dessert' }[kind] || 'Place';
  }

  async function loadVenues(key, meet) {
    S.venueLoading = true;
    try {
      var list = await Places.venues(meet.lat, meet.lon, S.venueKind, S.venueRadius);
      S.venues[key] = list.slice(0, 40);
      S.venueError = '';
    } catch (err) {
      S.venueError = err.message;
    }
    S.venueLoading = false;
    if (S.data) renderSpot();
  }

  // ------------------------------------------------------------ 3 split
  function currentBill() {
    var b = S.data.room.bill || {};
    var people = peopleList();
    var shares = {};
    people.forEach(function (p) { shares[p.id] = b.shares && b.shares[p.id] !== undefined ? b.shares[p.id] : 1; });
    var extra = {};
    people.forEach(function (p) { if (b.extra && b.extra[p.id]) extra[p.id] = b.extra[p.id]; });
    var payer = b.payerId && personIndex(b.payerId) >= 0 ? b.payerId : (S.me || (people[0] && people[0].id));
    return { subtotal: b.subtotal || 0, taxPct: b.taxPct === undefined ? Split.NYC_TAX : b.taxPct,
      tipPct: b.tipPct === undefined ? 20 : b.tipPct, payerId: payer, shares: shares, extra: extra };
  }

  function renderSplit(fromRemote) {
    var sec = $('#secSplit');
    // Don't rebuild the form under someone's fingers; just refresh the numbers.
    if (fromRemote && sec.contains(document.activeElement) && $('#splitOut')) { renderSplitOut(currentBill()); return; }
    var bill = currentBill(), people = peopleList();
    var head = '<div class="band"><span class="step">3</span><h2>Split the bill</h2><span class="hint">NYC tax ' + Split.NYC_TAX + '%</span></div>';
    if (!people.length) { sec.innerHTML = head; return; }
    var tipChoices = [18, 20, 22];
    var custom = tipChoices.indexOf(bill.tipPct) === -1;
    var html = head + '<form class="card" id="splitForm" autocomplete="off">' +
      '<div class="split-grid">' +
        '<label class="field"><span class="small muted">Food &amp; drinks (before tax and tip)</span>' +
          '<div class="money-input"><span>$</span><input class="input num" name="subtotal" inputmode="decimal" placeholder="0.00" value="' +
          (bill.subtotal ? (bill.subtotal / 100).toFixed(2) : '') + '"></div></label>' +
        '<label class="field"><span class="small muted">Sales tax %</span>' +
          '<input class="input num" name="tax" inputmode="decimal" value="' + bill.taxPct + '"></label>' +
      '</div>' +
      '<div class="field"><span class="small muted">Tip</span><div class="seg" role="group" aria-label="Tip">' +
        tipChoices.map(function (t) { return '<button type="button" class="chip" data-tip="' + t + '" aria-pressed="' + (bill.tipPct === t) + '">' + t + '%</button>'; }).join('') +
        '<input class="input num" name="tipCustom" inputmode="decimal" placeholder="Other %" style="width:110px;min-height:36px;padding:6px 10px" value="' + (custom ? bill.tipPct : '') + '">' +
      '</div></div>' +
      '<label class="field"><span class="small muted">Who paid the restaurant?</span><select class="input" name="payer">' +
        people.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === bill.payerId ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') +
      '</select></label>' +
      '<div class="field"><span class="small muted">Who\'s in? Add anything only one person had.</span><div>' +
        people.map(function (p, i) {
          return '<div class="inrow"><input type="checkbox" data-share="' + esc(p.id) + '"' + (bill.shares[p.id] > 0 ? ' checked' : '') +
            ' aria-label="' + esc(p.name) + ' is in"><span class="avatar" style="width:26px;height:26px;font-size:12px;background:' + personColor(i) + '">' +
            initial(p.name) + '</span><span class="grow">' + esc(p.name) + '</span>' +
            '<div class="money-input extra"><span>$</span><input class="input num" data-extra="' + esc(p.id) + '" inputmode="decimal" placeholder="extra" value="' +
            (bill.extra[p.id] ? (bill.extra[p.id] / 100).toFixed(2) : '') + '" aria-label="Extra for ' + esc(p.name) + '"></div></div>';
        }).join('') + '</div></div>' +
      '<div id="splitOut"></div></form>';
    sec.innerHTML = html;
    renderSplitOut(bill);

    var form = $('#splitForm');
    function readForm() {
      var b = currentBill();
      b.subtotal = Split.parseMoney(form.subtotal.value);
      var tax = parseFloat(form.tax.value); b.taxPct = isFinite(tax) && tax >= 0 && tax < 30 ? tax : Split.NYC_TAX;
      var pressed = form.querySelector('[data-tip][aria-pressed="true"]');
      var customTip = parseFloat(form.tipCustom.value);
      b.tipPct = form.tipCustom.value.trim() && isFinite(customTip) ? Math.max(0, Math.min(100, customTip)) : (pressed ? +pressed.dataset.tip : 20);
      b.payerId = form.payer.value;
      form.querySelectorAll('[data-share]').forEach(function (c) { b.shares[c.dataset.share] = c.checked ? 1 : 0; });
      b.extra = {};
      form.querySelectorAll('[data-extra]').forEach(function (inp) { var c = Split.parseMoney(inp.value); if (c) b.extra[inp.dataset.extra] = c; });
      return b;
    }
    function changed() {
      var b = readForm();
      S.data.room.bill = b;
      renderSplitOut(b);
      clearTimeout(S.billTimer);
      S.billTimer = setTimeout(function () { store.updateRoom(S.code, { bill: b }).catch(fail); }, 500);
    }
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    form.addEventListener('click', function (e) {
      var t = e.target.closest('[data-tip]');
      if (t) {
        form.querySelectorAll('[data-tip]').forEach(function (c) { c.setAttribute('aria-pressed', String(c === t)); });
        form.tipCustom.value = '';
        changed();
        return;
      }
      var c = e.target.closest('[data-copy]');
      if (c) copySummary();
    });
  }

  function renderSplitOut(bill) {
    var out = $('#splitOut');
    if (!out) return;
    if (!bill.subtotal) { out.innerHTML = '<div class="empty">Enter the food &amp; drinks total from the receipt.</div>'; return; }
    var r = Split.compute(bill), people = peopleList();
    var payer = people[personIndex(bill.payerId)];
    var html = '<div class="totals num"><span class="muted">Food &amp; drinks</span><span>' + Split.money(r.subtotal) + '</span>' +
      '<span class="muted">Tax ' + bill.taxPct + '%</span><span>' + Split.money(r.tax) + '</span>' +
      '<span class="muted">Tip ' + bill.tipPct + '%</span><span>' + Split.money(r.tip) + '</span>' +
      '<span class="t">Total</span><span class="t">' + Split.money(r.total) + '</span></div>';
    if (!r.owes.length) {
      html += '<div class="empty">Nobody owes ' + esc(payer ? payer.name : 'the payer') + ' anything yet.</div>';
    } else {
      html += '<div class="label">Pay back ' + esc(payer.name) + '</div><div>';
      r.owes.forEach(function (o) {
        var p = people[personIndex(o.from)], link = Split.venmoLink(payer.venmo, o.cents, S.data.room.name + ' (Pintu)');
        html += '<div class="owe"><span class="avatar" style="width:28px;height:28px;font-size:13px;background:' + personColor(personIndex(o.from)) + '">' + initial(p.name) + '</span>' +
          '<div class="grow"><b>' + esc(p.name) + '</b> owes <b class="num">' + Split.money(o.cents) + '</b></div>' +
          (link && o.from === S.me ? '<a class="btn venmo" target="_blank" rel="noopener" href="' + esc(link) + '">Pay on Venmo</a>' : '') + '</div>';
      });
      html += '</div>';
      if (!payer.venmo) html += '<div class="small muted">Ask ' + esc(payer.name) + ' to add a Venmo username (Edit next to their name) to get one-tap pay links.</div>';
    }
    html += '<button type="button" class="btn" data-copy>Copy summary for the group chat</button>';
    out.innerHTML = html;
  }

  async function copySummary() {
    var bill = currentBill(), r = Split.compute(bill), people = peopleList();
    var payer = people[personIndex(bill.payerId)];
    var lines = [S.data.room.name + ' — ' + Split.money(r.total) + ' total (tax ' + bill.taxPct + '%, tip ' + bill.tipPct + '%)'];
    r.owes.forEach(function (o) { lines.push(personName(o.from) + ' → ' + payer.name + ': ' + Split.money(o.cents)); });
    if (payer && payer.venmo) lines.push('Venmo: @' + payer.venmo);
    lines.push(roomUrl(S.code));
    try { await navigator.clipboard.writeText(lines.join('\n')); toast('Summary copied'); }
    catch (e) { prompt('Copy this:', lines.join('\n')); }
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    try {
      var res = await fetch('data/subway.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      subway = new window.PintuSubway.Subway(await res.json());
      subway.stations.forEach(function (st) { stationIdx[st.id] = st.idx; });
      // Optional: places-to-eat counts per station, used to prefer good hangout stops.
      try {
        var vres = await fetch('data/venues.json');
        if (vres.ok) subway.setPlaces(await vres.json());
      } catch (e) { console.warn('venues.json not loaded; ranking by time only', e); }
    } catch (err) {
      $app.innerHTML = '<div class="error" style="margin-top:40px">Couldn\'t load the subway map (' + esc(err.message) + '). Refresh to try again.</div>';
      return;
    }
    window.addEventListener('hashchange', route);
    route();
  }

  boot();
})();

/* Pintu NYC — app UI.
 * Hash routes (one screen each, see design/v1):
 *   #/                 Home                 #/meet            Create or join a meetup room
 *   #/r/CODE           Where everyone starts #/r/CODE/spots  Meetup spots (ranked stops)
 *   #/r/CODE/food      Food blind box        #/r/CODE/room   Room code and members
 *   #/r/CODE/ledger    Trip ledger           #/ledger        Start a ledger
 *   #/spin             Who pays · Spinner    #/trips         My trips
 *   #/privacy          Privacy               #/terms         Terms
 *   #/contact          Contact
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
    whenOpen: false,
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
    if (h === '/privacy') return { name: 'privacy' };
    if (h === '/terms') return { name: 'terms' };
    if (h === '/contact') return { name: 'contact' };
    return { name: 'home' };
  }

  function route() {
    var r = parseRoute(location.hash);
    S.route = r.name;
    if (!r.code) leaveRoom();
    if (r.name === 'home') return renderHome();
    if (r.name === 'trips') return renderTrips();
    if (r.name === 'meet') return renderMeet();
    if (r.name === 'ledger_new') return renderLedgerNew();
    if (r.name === 'spin') return renderSpin();
    if (r.name === 'privacy') return renderPrivacy();
    if (r.name === 'terms') return renderTerms();
    if (r.name === 'contact') return renderContact();
    return routeRoom(r);
  }

  function leaveRoom() {
    if (S.unsub) S.unsub();
    if (S.map) { S.map.remove(); S.map = null; }
    S.unsub = null; S.data = null; S.code = null; S.me = null; S.dirty = false; S.whenOpen = false;
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
          '<a href="#/privacy">Privacy</a><a href="#/terms">Terms</a><a href="#/contact">Contact</a>' +
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

  // ------------------------------------------------------------ info pages: privacy, terms, contact
  // Plain text pages. Static copy only; nothing here reads or sends room data.
  var LAST_UPDATED = 'November 12, 2026';
  function infoScreen(title, body) {
    document.title = title + ' · Pintu';
    show('<main class="screen">' + topbar(title, '#/') +
      '<div class="content info-page">' + body + '</div></main>');
  }
  function infoCard(heading, html) {
    return '<section class="panel info-card"><h2 class="heading-md">' + heading + '</h2>' + html + '</section>';
  }
  function infoList(items) {
    return '<ul class="info-list">' + items.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>';
  }
  function updatedLine() { return '<p class="caption info-updated">Last updated: ' + LAST_UPDATED + '</p>'; }
  function infoLinks() {
    return '<div class="info-actions"><a class="btn btn-outline" href="#/privacy">Privacy</a>' +
      '<a class="btn btn-outline" href="#/terms">Terms</a></div>';
  }

  function renderPrivacy() {
    infoScreen('Privacy', updatedLine() +
      infoCard('The short version',
        '<p>Pintu has no accounts and no sign-in. It keeps what a group types into a meetup or ledger room, so the room works for everyone in it. Anyone with the room code can open that room.</p>') +
      infoCard('What a room stores',
        '<p>A room holds only what the group adds while planning:</p>' +
        infoList([
          'The room name, such as a trip name or "Mia\'s meetup".',
          'Each person\'s name, as typed (usually a first name).',
          'Starting points: the address or station label. From Locate, Pintu keeps coordinates rounded to about 1 metre, plus the nearest subway station\'s name.',
          'An optional Venmo handle for each person.',
          'The meetup time and the chosen meeting stop.',
          'Food votes, with each place\'s name, cuisine, hours and website as they were when voted on.',
          'Ledger expenses: title, amount, who paid, who shares it, tax and tip settings, and which payments are marked paid.',
        ]) +
        '<p>With real-time sharing on, rooms are stored in a Supabase database hosted in the US. Anyone with a room code can read and change that room. The database is not yet set up to limit reads to one room, so anyone with the app\'s public key could read other rooms too. Treat a room as something you share, not a private place.</p>' +
        '<p>If this copy of Pintu runs in local mode, rooms exist only in this browser. Other phones can\'t see them, and clearing this site\'s data deletes them.</p>') +
      infoCard('What stays on your phone',
        '<p>These are saved in your browser\'s local storage and never leave the phone:</p>' +
        infoList([
          'Your name, so it fills in next time.',
          'Which person you are in each room you have joined.',
          'My trips: the rooms you have opened, with their names and when you last opened them.',
          'Spinner: the names on the wheel and the question you typed.',
        ]) +
        '<p>Backup &amp; restore writes My trips to a file only when you download it.</p>') +
      infoCard('Your location',
        '<p>Pintu reads your location only when you tap Locate, and only once. It never tracks where you are or keeps a history. The position is saved as that person\'s starting point, so people in the room can see it on the map.</p>') +
      infoCard('Services Pintu contacts',
        infoList([
          '<b>Address search:</b> the text you type goes to OpenStreetMap\'s Nominatim search service.',
          '<b>Nearby places:</b> after you pick a meeting stop, Pintu asks OpenStreetMap\'s Overpass service for places near that stop. It sends the stop\'s location, not yours.',
          '<b>Map tiles:</b> from CARTO.',
          '<b>Font:</b> IBM Plex Sans, from Google Fonts.',
          '<b>Links:</b> OpenTable, Resy, Google Maps and Venmo open only when you tap them. Venmo links include the room name as the payment note. Those sites have their own privacy policies.',
        ])) +
      infoCard('Ads, analytics and cookies',
        '<p>Pintu has no ads, no analytics and no tracking scripts, and it sets no cookies. Like any website, your hosting provider may keep standard server logs, such as IP addresses.</p>') +
      infoCard('Deleting your data',
        infoList([
          '<b>A person:</b> tap × next to their name. Their starting point and food votes go with them.',
          '<b>An expense:</b> open it and tap Delete.',
          '<b>My trips:</b> Pintu has no button to clear this list yet. Clearing this site\'s data in your browser settings removes My trips, your name and everything else saved on this phone.',
          '<b>A whole room:</b> there is no button to delete a room yet. Ask through the Contact page and we will remove it.',
        ])) +
      infoCard('What not to put in a room',
        '<p>Rooms are for planning meetups and splitting bills. Don\'t add passwords, bank details, health information or anything you wouldn\'t share in a group chat.</p>') +
      infoCard('Changes',
        '<p>We may update this page. The date at the top shows the latest version.</p>') +
      infoLinks());
  }

  function renderTerms() {
    infoScreen('Terms', updatedLine() +
      infoCard('Using Pintu',
        '<p>Pintu is a free tool for finding a fair meetup spot, choosing food and splitting bills. By using it you agree to these terms. If you don\'t agree, please don\'t use it.</p>') +
      infoCard('The service as it is',
        '<p>Pintu is provided free of charge and "as is", without warranties of any kind. We may change, pause or stop it at any time. To the extent the law allows, we are not responsible for losses from using it, including missed trains, wrong information or disagreements about money.</p>') +
      infoCard('Subway times are estimates',
        '<p>Travel times are based on MTA schedules, not live service, and don\'t reflect delays, closures or planned work. Always check the MTA before you go.</p>') +
      infoCard('Restaurant information',
        '<p>Hours, cuisine and website details come from OpenStreetMap and NYC Open Data. They may be out of date or wrong, so check with the place before you go.</p>') +
      infoCard('Money',
        '<p>Ledger totals and who-pays-whom are there to help you add things up. People settle up with each other themselves. Pintu never holds, moves or handles money. A Venmo link only opens Venmo with the amount and note filled in, and you confirm the payment there.</p>') +
      infoCard('Rooms and what you add',
        '<p>Anyone with a room code can view and edit that room, so share codes only with people you\'re planning with. Don\'t put sensitive or illegal content in a room. You are responsible for what you add.</p>') +
      infoCard('Not affiliated',
        '<p>Pintu is not affiliated with, endorsed by or sponsored by the MTA, the City of New York, OpenStreetMap, OpenTable, Resy or Venmo. Their names appear only to describe links and data sources.</p>') +
      infoCard('Data credits',
        infoList([
          'Subway schedules: MTA GTFS.',
          '© OpenStreetMap contributors (ODbL).',
          'Map tiles: © CARTO.',
          'Restaurant inspection data: NYC DOHMH, via NYC Open Data.',
        ])) +
      infoCard('Changes',
        '<p>We may update these terms. The date at the top shows the latest version.</p>') +
      infoLinks());
  }

  // A usable address only: anything else counts as not set.
  function contactEmail() {
    var e = String(CFG.CONTACT_EMAIL || '').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
  }
  function renderContact() {
    var addr = contactEmail();
    var reach = addr
      ? '<a class="btn btn-primary btn-lg btn-block" href="mailto:' + esc(addr) + '?subject=' + encodeURIComponent('Pintu NYC feedback') + '">Email us</a>' +
        '<p class="caption info-address num">' + esc(addr) + '</p>'
      : '<p class="info-soon">Contact details coming soon.</p>';
    infoScreen('Contact',
      infoCard('Get in touch',
        '<p>Questions, bugs or ideas are all welcome.</p>' + reach) +
      infoCard('What\'s helpful to include',
        infoList([
          'What you were doing, and what you expected to happen.',
          'The room code, if the problem is with a room.',
          'Your phone and browser, such as iPhone with Safari.',
        ])) +
      infoCard('Privacy and terms',
        '<p>How Pintu handles your data, and the rules for using it.</p>' + infoLinks()));
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
      return '<a class="card-link trip-card" href="#/r/' + esc(t.code) + (ledger ? '/ledger' : '') + '" data-trip-money="' + esc(t.code) + '">' +
        '<span class="tile ' + (ledger ? 'pink' : 'blue') + '">' + icon(ledger ? 'receipt' : 'pin') + '</span>' +
        '<span class="txt"><span class="t">' + esc(t.name) + '</span>' +
        '<span class="s">' + (ledger ? 'Trip ledger' : 'Meetup') + ' · room <span class="num">' + esc(t.code) + '</span></span></span>' +
        live + (ledger ? '<span class="pill pill-money grey"></span>' : '') + '</a>';
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
    var ledgers = list.filter(function (t) { return t.kind === 'ledger'; });
    show('<main class="screen has-tabs"><div class="content">' +
      '<h1 class="screen-title" style="text-align:center;font-size:19px">My trips</h1>' +
      '<div class="chip-row" role="group" aria-label="Filter trips">' + chip('all', 'All') + chip('meetups', 'Meetups') + chip('ledgers', 'Ledgers') + '</div>' +
      body +
      '<p class="footer-note" style="margin-top:6px">Saved on this phone. Use Backup &amp; restore to move them.</p>' +
      '</div>' + tabbar('trips') + '</main>');
    // Ledger rows fill in their totals once each room has loaded (in local mode this is instant).
    ledgers.forEach(function (t) {
      store.load(t.code).then(function (d) { if (S.route === 'trips' && d) tripMoney(t.code, d); }).catch(function () {});
    });
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
      where: renderWhere, spots: renderSpots, food: renderFood, share: renderShare, ledger: renderLedger,
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
    return DAY_NAMES[t.dow] + ' ' + clock(t.time);
  }
  // "Sat, Nov 14 · 8:00 PM" for the Leaving pill.
  function fullWhen(t) {
    var d = new Date(t.date + 'T00:00:00Z');
    return DAY_NAMES[t.dow] + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ' · ' + clock(t.time);
  }
  function clock(hhmm) {
    var hm = hhmm.split(':'), h = +hm[0], ap = h >= 12 ? 'PM' : 'AM';
    return ((h % 12) || 12) + ':' + hm[1] + ' ' + ap;
  }
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function renderWhere() {
    var t = hangoutTime(), people = peopleList(), me = S.me;
    var addingFriend = S.addingFriend, whenOpen = !!S.whenOpen;
    var html = '<main class="screen">' + topbar('Find the middle', '#/meet', roomHeaderRight()) +
      '<div class="content">' +
      '<section class="panel where-panel" aria-labelledby="whereTitle">' +
        '<div class="intro"><h2 class="screen-title" id="whereTitle">Where\'s everyone coming from?</h2>' +
        '<p>We\'ll find the subway stop where nobody\'s trip is long.</p></div>' +
        '<div class="when-bar when-row" role="group" aria-label="When are you leaving?">' +
          '<span class="lead">' + icon('clock', 'sm') + 'Leaving</span>' +
          '<button type="button" class="chip" data-act="when-now" aria-pressed="' + t.isNow + '">Now</button>' +
          '<button type="button" class="when-pill num" data-act="when-pick" aria-expanded="' + whenOpen + '" aria-controls="whenFields">' +
            esc(t.isNow ? 'Pick a time' : fullWhen(t)) + '</button>' +
          '<div class="when-fields" id="whenFields"' + (whenOpen ? '' : ' hidden') + '>' +
            '<input type="date" class="input when-input num" id="whenDate" value="' + esc(t.date) + '" aria-label="Date">' +
            '<input type="time" class="input when-input num" id="whenTime" value="' + esc(t.time) + '" step="900" aria-label="Time">' +
          '</div>' +
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

  // ------------------------------------------------------------ trip ledger
  // Stored in room.bill as {kind:'ledger', expenses:[...], paid:{'fromId>toId': true}}.
  function ledgerOf(room) {
    var b = room && room.bill;
    if (b && b.kind === 'ledger') return { expenses: b.expenses || [], paid: b.paid || {} };
    return { expenses: [], paid: {} };
  }
  function ledgerSettle() {
    var L = ledgerOf(S.data.room);
    return { L: L, r: Split.settle(L.expenses, peopleList().map(function (p) { return p.id; })) };
  }
  function saveLedger(next) {
    S.data.room.bill = Object.assign({ kind: 'ledger' }, next);   // optimistic
    render();
    store.updateRoom(S.code, { bill: S.data.room.bill }).catch(fail);
  }
  function nameOf(id) { return personName(id); }

  function renderLedgerNew() {
    document.title = 'Trip ledger · Pintu';
    show('<main class="screen">' + topbar('Trip ledger', '#/') +
      '<div class="content">' +
      '<section class="panel" aria-labelledby="ledgerNewTitle">' +
        '<div class="header-line"><span class="tile pink lg">' + icon('receipt') + '</span>' +
        '<div class="head-txt"><h2 class="heading-md" id="ledgerNewTitle">Start a trip ledger</h2>' +
        '<p>Everyone pays as you go. We\'ll track who owes whom and make settling up one tap.</p></div></div>' +
        '<form class="stack" id="ledgerNewForm">' +
          '<label class="field"><span class="caption">Trip name</span>' +
            '<input class="input" name="trip" maxlength="60" placeholder="Friday in K-town" required></label>' +
          '<label class="field"><span class="caption">Your name</span>' +
            '<input class="input" name="me" maxlength="40" placeholder="Your name" autocomplete="given-name" required value="' + esc(savedName()) + '"></label>' +
          '<button class="btn btn-primary btn-lg btn-block" type="submit">Start ledger</button>' +
        '</form></section>' +
      '</div></main>');
  }

  async function createLedgerFromForm(form) {
    var trip = form.trip.value.trim(), me = form.me.value.trim();
    if (!trip || !me) return;
    lsSet('pintu_name', me);
    var btn = form.querySelector('button'); btn.disabled = true;
    try {
      var code = await store.createRoom(trip);
      var row = await store.addPerson(code, { name: me });
      setMe(code, row.id);
      await store.updateRoom(code, { bill: { kind: 'ledger', expenses: [], paid: {} } });
      location.hash = '#/r/' + code + '/ledger';
    } catch (err) { fail(err); btn.disabled = false; }
  }

  function renderLedger() {
    var room = S.data.room, tab = S.ledgerTab || 'expenses';
    var people = peopleList(), set = ledgerSettle(), L = set.L, r = set.r;
    document.title = room.name + ' · Pintu';
    var share = '<a class="back" href="#/r/' + esc(S.code) + '/room" aria-label="Share room" style="color:var(--ink)">' +
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + ICON.share + '</svg></a>';
    var tabs = [['people', 'People', people.length], ['expenses', 'Expenses', L.expenses.length], ['settle', 'Settle up', null]];
    var tabBtns = tabs.map(function (t, i) {
      var sel = tab === t[0];
      return '<button type="button" role="tab" id="tab-' + t[0] + '" aria-selected="' + sel + '" aria-controls="ledgerBody" data-act="ledger-tab" data-t="' + t[0] + '">' +
        '<span class="num-badge">' + (i + 1) + '</span>' + t[1] + '</button>';
    }).join('');

    var body = '';
    if (tab === 'people') {
      body = '<div class="list-card">' + (people.length ? people.map(function (p, i) {
        return '<div class="person-edit">' + avatar(p, i, 'lg') +
          '<div class="who"><span class="n">' + esc(p.name) + (p.id === S.me ? '<span class="tag-you">You</span>' : '') + '</span>' +
          '<label style="display:block"><span class="sr">Venmo username for ' + esc(p.name) + '</span>' +
          '<input class="input-inline venmo-input" style="background:var(--field);border:1px solid var(--line);border-radius:10px;padding:0 10px;height:38px;min-height:38px" ' +
          'data-venmo="' + esc(p.id) + '" value="' + esc(p.venmo ? '@' + p.venmo : '') + '" placeholder="Venmo @username (optional)" autocomplete="off"></label></div>' +
          '<button class="round-btn" style="width:36px;height:36px;border:0;background:none;color:var(--ink-soft);font-size:18px" type="button" data-act="ledger-remove" data-id="' + esc(p.id) + '" aria-label="Remove ' + esc(p.name) + '">×</button>' +
          '</div>';
      }).join('') : '<div class="empty">Nobody yet.</div>') + '</div>' +
      '<form class="add-friend-form" id="ledgerPersonForm"><label class="grow" style="display:block"><span class="sr">Name</span>' +
      '<input class="input" name="name" maxlength="40" placeholder="Add a name" autocomplete="off" required></label>' +
      '<button class="btn btn-primary" type="submit">Add</button></form>';
    } else if (tab === 'expenses') {
      body = '<div class="list-card">' + (L.expenses.length ? L.expenses.map(function (e, i) {
        var total = Split.expenseTotal(e), n = (e.among || []).length;
        var tones = ['coral', 'blue', 'gold', 'pink'];
        return '<button class="exp-row" type="button" data-act="edit-expense" data-id="' + esc(e.id) + '">' +
          '<span class="tile ' + tones[i % 4] + '">' + icon('dollar', 'sm') + '</span>' +
          '<span class="txt"><span class="t">' + esc(e.title) + '</span>' +
          '<span class="s">' + esc(nameOf(e.payerId)) + ' paid · split ' + n + ' way' + (n === 1 ? '' : 's') +
          (e.taxTip ? ' · incl. tax + ' + (e.tipPct == null ? 20 : e.tipPct) + '% tip' : '') + '</span></span>' +
          '<span class="amt">' + Split.money(total) + '</span></button>';
      }).join('') : '<div class="empty">No expenses yet. Add one as you pay.</div>') + '</div>' +
      '<button class="add-dash" type="button" data-act="add-expense">+ Add expense</button>' +
      settlePanelHTML(r, people);
    } else {
      body = '<div class="list-card">' + people.map(function (p, i) {
        var net = r.balances[p.id] || 0;
        var cls = net > 0 ? 'in' : net < 0 ? 'out' : '';
        return '<div class="bal-row">' + avatar(p, i, 'lg') +
          '<div class="txt"><span class="n">' + esc(p.name) + '</span>' +
          '<span>' + (net > 0 ? 'is owed' : net < 0 ? 'owes' : 'all square') + '</span></div>' +
          '<span class="net ' + cls + '">' + (net === 0 ? '—' : Split.money(Math.abs(net))) + '</span></div>';
      }).join('') + '</div>' +
      '<div class="caption" style="text-align:center;margin:4px 0">Total spent: <b class="num">' + Split.money(r.total) + '</b></div>' +
      '<button class="btn btn-primary btn-block" type="button" data-act="copy-summary">Copy summary for the group chat</button>';
    }

    show('<main class="screen">' + topbar('Trip ledger', '#/', share) +
      '<div class="content">' +
      '<section class="panel ledger-head" style="padding:16px">' +
        '<span class="tile pink lg">' + icon('receipt') + '</span>' +
        '<div class="txt"><h2 class="heading-md">' + esc(room.name) + '</h2>' +
        '<span>' + people.length + ' people · ' + L.expenses.length + ' expense' + (L.expenses.length === 1 ? '' : 's') + ' · room <span class="num">' + esc(S.code) + '</span></span></div>' +
        '<div class="total"><div class="v num">' + Split.money(r.total) + '</div><div class="k">total</div></div>' +
      '</section>' +
      '<div class="seg-tabs" role="tablist" aria-label="Ledger sections">' + tabBtns + '</div>' +
      '<div id="ledgerBody" role="tabpanel" aria-labelledby="tab-' + tab + '">' + body + '</div>' +
      '</div></main>');
  }

  function settlePanelHTML(r, people) {
    var rows = r.transfers.map(function (t) {
      var from = people.find(function (p) { return p.id === t.from; }) || { name: 'Someone' };
      var to = people.find(function (p) { return p.id === t.to; }) || { name: 'Someone' };
      var key = t.from + '>' + t.to, paid = !!(S.data.room.bill && S.data.room.bill.paid && S.data.room.bill.paid[key]);
      var venmo = Split.venmoLink(to.venmo, t.cents, S.data.room.name + ' (Pintu)');
      return '<div class="pay-row">' + avatar(from, peopleList().indexOf(from), 'sm') +
        '<span class="txt"><b>' + esc(from.name) + '</b> → <b>' + esc(to.name) + '</b></span>' +
        '<span class="amt num">' + Split.money(t.cents) + '</span>' +
        (venmo && !paid ? '<a class="btn btn-sm btn-venmo" target="_blank" rel="noopener" href="' + esc(venmo) + '">Venmo</a>' : '') +
        '<button class="paid-toggle' + (paid ? ' on' : '') + '" type="button" data-act="toggle-paid" data-key="' + esc(key) + '" aria-pressed="' + paid + '">' +
          (paid ? icon('check', 'xs') + 'Paid' : 'Mark paid') + '</button></div>';
    }).join('');
    return '<section class="settle-panel" aria-labelledby="settleTitle">' +
      '<div class="head"><h2 id="settleTitle">Who pays whom</h2><span class="caption num">' + r.transfers.length + ' payment' + (r.transfers.length === 1 ? '' : 's') + '</span></div>' +
      (rows || '<div class="empty">Everyone\'s square. Nothing to settle.</div>') +
      '<button class="btn btn-primary btn-block" type="button" data-act="copy-summary">Copy summary for the group chat</button>' +
      '</section>';
  }

  function openExpenseDialog(id) {
    var dlg = document.getElementById('expDlg');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'expDlg';
      dlg.setAttribute('aria-labelledby', 'expTitle');
      document.body.appendChild(dlg);
      dlg.addEventListener('click', function (e) {
        var t = e.target.closest('[data-act]');
        if (!t) return;
        if (t.dataset.act === 'close-dialog') dlg.close();
        else if (t.dataset.act === 'delete-expense') deleteExpense(dlg.dataset.editing);
      });
      dlg.addEventListener('submit', function (e) { e.preventDefault(); saveExpenseFromDialog(dlg); });
      dlg.addEventListener('change', function (e) {
        if (e.target.name === 'taxTip') dlg.querySelector('[data-tip-row]').hidden = !e.target.checked;
      });
    }
    var L = ledgerOf(S.data.room), e = id ? L.expenses.find(function (x) { return x.id === id; }) : null;
    var people = peopleList();
    dlg.dataset.editing = e ? e.id : '';
    var payer = e ? e.payerId : (S.me || (people[0] && people[0].id));
    dlg.innerHTML = '<form method="dialog" class="dlg" id="expenseForm">' +
      '<h3 id="expTitle">' + (e ? 'Edit expense' : 'Add expense') + '</h3>' +
      '<label class="field"><span class="caption">What was it?</span>' +
        '<input class="input" name="title" maxlength="60" placeholder="Dinner at Jongro BBQ" required value="' + esc(e ? e.title : '') + '"></label>' +
      '<label class="field"><span class="caption">Amount (USD)</span>' +
        '<div class="money"><span>$</span><input class="input num" name="amount" inputmode="decimal" placeholder="0.00" required value="' + (e ? (e.cents / 100).toFixed(2) : '') + '"></div></label>' +
      '<label class="field"><span class="caption">Paid by</span>' +
        '<select class="input" name="payer">' + people.map(function (p) {
          return '<option value="' + esc(p.id) + '"' + (p.id === payer ? ' selected' : '') + '>' + esc(p.name) + '</option>';
        }).join('') + '</select></label>' +
      '<div class="field"><span class="caption">Split among</span><div class="check-list">' + people.map(function (p) {
        var on = e ? (e.among || []).indexOf(p.id) >= 0 : true;
        return '<label class="check-row"><input type="checkbox" name="among" value="' + esc(p.id) + '"' + (on ? ' checked' : '') + '>' + esc(p.name) + '</label>';
      }).join('') + '</div></div>' +
      '<label class="check-row"><input type="checkbox" name="taxTip"' + (e && e.taxTip ? ' checked' : '') + '>Add NYC tax + tip</label>' +
      '<div class="tip-row" data-tip-row' + (e && e.taxTip ? '' : ' hidden') + '>' +
        '<span class="caption">Tax ' + Split.NYC_TAX + '% · tip</span>' +
        '<input class="input num" name="tipPct" inputmode="decimal" value="' + (e && e.tipPct != null ? e.tipPct : 20) + '" aria-label="Tip percent">' +
        '<span class="caption">%</span></div>' +
      '<div class="dlg-actions">' +
        (e ? '<button class="btn btn-danger" type="button" data-act="delete-expense">Delete</button>' : '') +
        '<span class="grow"></span>' +
        '<button class="btn" type="button" data-act="close-dialog">Cancel</button>' +
        '<button class="btn btn-primary" type="submit">Save</button></div>' +
      '</form>';
    dlg.showModal ? dlg.showModal() : dlg.setAttribute('open', '');
    setTimeout(function () { var t = dlg.querySelector('[name=title]'); if (t) t.focus(); }, 30);
  }

  function saveExpenseFromDialog(dlg) {
    var f = dlg.querySelector('#expenseForm');
    var title = f.title.value.trim(), cents = Split.parseMoney(f.amount.value);
    var among = Array.prototype.filter.call(f.querySelectorAll('[name=among]'), function (c) { return c.checked; })
      .map(function (c) { return c.value; });
    if (!title || cents <= 0 || !among.length) { toast(!among.length ? 'Pick who shares this expense.' : 'Add a title and an amount.'); return; }
    var tipPct = parseFloat(f.tipPct.value);
    var e = {
      id: dlg.dataset.editing || uuid(), title: title.slice(0, 60), cents: cents, payerId: f.payer.value, among: among,
      taxTip: f.taxTip.checked, tipPct: f.taxTip.checked && isFinite(tipPct) ? Math.max(0, Math.min(100, tipPct)) : 20,
    };
    var L = ledgerOf(S.data.room), list = L.expenses.slice();
    var i = list.findIndex(function (x) { return x.id === e.id; });
    if (i >= 0) list[i] = e; else list.push(e);
    dlg.close();
    saveLedger({ expenses: list, paid: L.paid });
  }

  function deleteExpense(id) {
    var dlg = document.getElementById('expDlg');
    if (dlg) dlg.close();
    var L = ledgerOf(S.data.room);
    if (!id || !confirm('Delete this expense?')) return;
    saveLedger({ expenses: L.expenses.filter(function (x) { return x.id !== id; }), paid: L.paid });
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function copySummary() {
    var set = ledgerSettle(), r = set.r, people = peopleList(), L = set.L;
    var name = function (id) { return nameOf(id); };
    var lines = [S.data.room.name + ' — ' + Split.money(r.total) + ' total'];
    r.transfers.forEach(function (t) {
      var key = t.from + '>' + t.to, mark = L.paid[key] ? ' (paid)' : '';
      lines.push(name(t.from) + ' → ' + name(t.to) + ': ' + Split.money(t.cents) + mark);
    });
    if (!r.transfers.length) lines.push('All square.');
    lines.push(roomUrl(S.code));
    var text = lines.join('\n');
    navigator.clipboard.writeText(text).then(function () { toast('Summary copied'); })
      .catch(function () { prompt('Copy this:', text); });
  }

  // Trip list money line for a ledger: "You get $X" / "You owe $X" / "Settled".
  function tripMoney(code, d) {
    var row = document.querySelector('[data-trip-money="' + code + '"]');
    if (!row || !d || !d.room.bill || d.room.bill.kind !== 'ledger') return;
    var people = d.people.map(function (p) { return p.id; });
    var me = getMe(code), mine = people.indexOf(me) >= 0 ? me : null;
    var r = Split.settle((d.room.bill.expenses || []), people);
    var total = Split.money(r.total), owed = mine ? (r.balances[mine] || 0) : 0;
    var label = !mine ? 'total ' + total : owed > 0 ? 'You get ' + Split.money(owed) : owed < 0 ? 'You owe ' + Split.money(-owed) : 'Settled';
    var cls = owed > 0 ? 'pink' : owed < 0 ? 'coral' : 'grey';
    row.querySelector('.s').textContent = 'Trip ledger · ' + total;
    var pill = row.querySelector('.pill-money');
    if (pill) { pill.className = 'pill pill-money ' + cls; pill.textContent = label; }
  }


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

  // ------------------------------------------------------------ spinner (local only, no store)
  var WHEEL_TINTS = ['#F4DED3', '#E5EEE7', '#DCE7EC', '#EADFC5', '#F2DDE4'];
  var WHEEL_INKS = ['#C05B3C', '#20584D', '#3E6E8E', '#8F6418', '#A8506E'];
  var SPIN_KEY = 'pintu_spin_people', DECIDE_KEY = 'pintu_spin_decision';

  function spinState() {
    if (!S.spin) {
      var people = [];
      try { people = JSON.parse(lsGet(SPIN_KEY) || 'null') || []; } catch (e) { people = []; }
      S.spin = { people: Array.isArray(people) ? people : [], decision: lsGet(DECIDE_KEY) || 'Who covers dinner tonight',
        angle: 0, busy: false, winner: null, adding: false, seeded: !!people.length };
      if (!S.spin.people.length) seedSpinPeople();
    }
    return S.spin;
  }
  // First visit with nothing saved: start from the people in the most recent trip.
  function seedSpinPeople() {
    var last = loadTrips()[0];
    if (!last) return;
    store.load(last.code).then(function (d) {
      if (!d || S.spin.seeded || S.spin.people.length) return;
      S.spin.people = d.people.map(function (p) { return p.name; });
      S.spin.seeded = true;
      saveSpinPeople();
      if (S.route === 'spin' && !S.spin.busy) renderSpin();
    }).catch(function () {});
  }
  function saveSpinPeople() { lsSet(SPIN_KEY, JSON.stringify(S.spin.people)); }

  function wheelSVG(names) {
    var n = names.length, R = 142, C = 150, html = '';
    if (n === 1) {
      html = '<circle cx="150" cy="150" r="' + R + '" fill="' + WHEEL_TINTS[0] + '"/>';
    } else {
      var A = 360 / n;
      for (var i = 0; i < n; i++) {
        var a0 = i * A * Math.PI / 180, a1 = (i + 1) * A * Math.PI / 180;
        var x0 = C + R * Math.sin(a0), y0 = C - R * Math.cos(a0), x1 = C + R * Math.sin(a1), y1 = C - R * Math.cos(a1);
        html += '<path d="M150 150 L' + x0.toFixed(2) + ' ' + y0.toFixed(2) + ' A' + R + ' ' + R + ' 0 ' + (A > 180 ? 1 : 0) + ' 1 ' +
          x1.toFixed(2) + ' ' + y1.toFixed(2) + ' Z" fill="' + WHEEL_TINTS[i % WHEEL_TINTS.length] + '" stroke="#FFFDF6" stroke-width="3"/>';
      }
      for (var j = 0; j < n; j++) {
        var mid = (j + 0.5) * A * Math.PI / 180, rr = R * 0.66;
        var size = n > 5 ? 13 : n > 3 ? 15 : 17;
        html += '<text x="' + (C + rr * Math.sin(mid)).toFixed(1) + '" y="' + (C - rr * Math.cos(mid) + 6).toFixed(1) +
          '" text-anchor="middle" font-size="' + size + '" font-weight="700" fill="' + WHEEL_INKS[j % WHEEL_INKS.length] + '">' + esc(names[j]) + '</text>';
      }
    }
    html += '<circle cx="150" cy="150" r="' + (R + 4) + '" fill="none" stroke="#DED8C6" stroke-width="2"/>';
    return '<svg viewBox="0 0 300 300" role="img" aria-label="Wheel with ' + esc(names.join(', ')) + '">' + html + '</svg>';
  }

  function renderSpin() {
    var st = spinState(), names = st.people;
    var winnerHTML = st.winner && !st.busy
      ? '<div class="winner" role="status"><span class="avatar sm ' + SLOT[Math.max(0, names.indexOf(st.winner)) % 4] + '">' + initial(st.winner) + '</span>' +
        '<span class="txt">' + decisionSentence(st.winner, st.decision) + '</span>' +
        '<a href="#/ledger">Log it</a></div>'
      : '';
    var chips = names.map(function (n, i) {
      return '<span class="person-chip">' + esc(n) + '<button type="button" data-act="spin-remove" data-i="' + i + '" aria-label="Remove ' + esc(n) + '">×</button></span>';
    }).join('');
    chips += st.adding
      ? '<form class="add-chip-form" id="spinAddForm"><label style="display:block"><span class="sr">Name</span>' +
        '<input class="input" name="name" maxlength="30" placeholder="Name" autocomplete="off" required></label>' +
        '<button class="btn btn-sm btn-primary" type="submit">Add</button></form>'
      : '<button class="add-chip" type="button" data-act="spin-add">+ Add</button>';
    show('<main class="screen">' + topbar('Who pays · Spinner', '#/') +
      '<div class="content">' +
      '<label class="decide"><b>Decide:</b><span class="sr">What are we deciding</span>' +
        '<input name="decide" maxlength="80" value="' + esc(st.decision) + '" autocomplete="off"></label>' +
      '<div class="wheel-wrap">' +
        '<span class="wheel-pointer" aria-hidden="true"><svg viewBox="0 0 20 22"><path d="M10 22L1 4a2 2 0 0 1 2-3h14a2 2 0 0 1 2 3z" fill="currentColor"/></svg></span>' +
        '<div class="wheel" id="wheel" style="transform:rotate(' + st.angle + 'deg)">' + (names.length ? wheelSVG(names) : '') + '</div>' +
        '<button class="spin-btn" type="button" data-act="spin" ' + (names.length < 2 || st.busy ? 'disabled' : '') + '>Spin</button>' +
      '</div>' +
      (names.length < 2 ? '<p class="caption" style="text-align:center">Add at least two people to spin.</p>' : '') +
      winnerHTML +
      '<section class="panel people-card" aria-labelledby="spinPeople">' +
        '<div class="head"><h2 class="heading-sm" id="spinPeople">People</h2><span class="caption num">' + names.length + ' on the wheel</span></div>' +
        '<div class="people-chips">' + chips + '</div>' +
      '</section>' +
      '</div></main>');
  }
  function decisionSentence(name, decision) {
    var rest = (decision || '').replace(/^who\s+/i, '');
    return rest !== (decision || '') ? '<b>' + esc(name) + '</b> ' + esc(rest) : '<b>' + esc(name) + '</b> — ' + esc(decision || '');
  }

  function spin() {
    var st = S.spin;
    if (!st || st.busy || st.people.length < 2) return;
    var n = st.people.length, w = Math.floor(Math.random() * n);
    var slice = 360 / n, centre = (w + 0.5) * slice;
    var current = ((st.angle % 360) + 360) % 360;
    // Turn the wheel so the winner's slice centre lands under the pointer (top), after several full turns.
    var extra = ((360 - centre - current) % 360 + 360) % 360;
    st.angle = st.angle + 360 * 5 + extra;
    st.busy = true; st.winner = null;
    var wheel = document.getElementById('wheel'), btn = $app.querySelector('.spin-btn');
    if (btn) btn.disabled = true;
    if (!wheel) return;
    var still = reducedMotion();
    if (!still) wheel.classList.add('spinning');
    wheel.style.transform = 'rotate(' + st.angle + 'deg)';
    setTimeout(function () {
      if (!S.spin) return;
      S.spin.busy = false; S.spin.winner = st.people[w];
      if (S.route === 'spin') renderSpin();
    }, still ? 0 : 3050);
  }

  function openBackup() {
    var dlg = document.getElementById('backupDlg');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'backupDlg';
      dlg.setAttribute('aria-labelledby', 'backupTitle');
      document.body.appendChild(dlg);
      dlg.addEventListener('click', function (e) {
        var t = e.target.closest('[data-act]');
        if (!t) return;
        if (t.dataset.act === 'close-dialog') dlg.close();
        if (t.dataset.act === 'backup-download') downloadBackup();
        if (t.dataset.act === 'backup-restore') dlg.querySelector('input[type=file]').click();
      });
      dlg.addEventListener('change', function (e) {
        if (e.target.type === 'file' && e.target.files[0]) restoreFromFile(e.target.files[0], dlg);
      });
    }
    var count = loadTrips().length;
    dlg.innerHTML = '<div class="dlg">' +
      '<h3 id="backupTitle">Backup &amp; restore</h3>' +
      '<p class="backup-note">Your trips list lives on this phone. Download it as a file to keep a copy or move to another phone, then restore it there.</p>' +
      '<p class="backup-note small">Rooms are kept on the server when real-time sharing is on. In local demo mode they exist only in this browser.</p>' +
      '<p class="caption num">' + count + ' trip' + (count === 1 ? '' : 's') + ' saved on this phone.</p>' +
      '<button class="btn btn-primary btn-block" type="button" data-act="backup-download">Download backup</button>' +
      '<button class="btn btn-outline btn-block" type="button" data-act="backup-restore">Restore from file…</button>' +
      '<input type="file" accept="application/json,.json" hidden>' +
      '<div class="dlg-actions"><button class="btn" type="button" data-act="close-dialog">Done</button></div></div>';
    dlg.showModal ? dlg.showModal() : dlg.setAttribute('open', '');
  }

  function downloadBackup() {
    var body = JSON.stringify({ app: 'pintu-nyc', version: 1, saved: new Date().toISOString(), trips: loadTrips() }, null, 2);
    var url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url; a.download = 'pintu-trips-' + nyNow().date + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Backup downloaded');
  }

  function restoreFromFile(file, dlg) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result), incoming = Array.isArray(data) ? data : (data && data.trips);
        if (!Array.isArray(incoming)) throw new Error('not a Pintu backup');
        var byCode = {};
        loadTrips().forEach(function (t) { byCode[t.code] = t; });
        var added = 0;
        incoming.forEach(function (t) {
          if (!t || typeof t.code !== 'string' || !/^[A-Z0-9]{6}$/.test(t.code)) return;
          var cur = byCode[t.code], last = typeof t.lastOpened === 'number' ? t.lastOpened : 0;
          if (!cur) added++;
          if (!cur || last > (cur.lastOpened || 0)) {
            byCode[t.code] = { code: t.code, name: String(t.name || 'Trip').slice(0, 60),
              kind: t.kind === 'ledger' ? 'ledger' : 'meetup', lastOpened: last };
          }
        });
        var list = Object.keys(byCode).map(function (k) { return byCode[k]; })
          .sort(function (a, b) { return b.lastOpened - a.lastOpened; }).slice(0, 200);
        saveTrips(list);
        toast(added ? 'Restored ' + added + ' trip' + (added === 1 ? '' : 's') : 'Nothing new in that backup');
        if (dlg) dlg.close();
        if (S.route === 'trips') renderTrips();
      } catch (err) { toast('That file isn\'t a Pintu backup.'); }
    };
    reader.readAsText(file);
  }

  // ------------------------------------------------------------ actions
  var ACTIONS = {
    'trip-filter': function (t) { S.tripFilter = t.dataset.f; renderTrips(); },
    'when-now': function () { S.whenOpen = false; setWhen(null); },
    'when-pick': function () {
      S.whenOpen = !S.whenOpen; render();
      if (S.whenOpen) { var d = $('#whenDate'); if (d) d.focus(); }
    },
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
    'ledger-tab': function (t) { S.ledgerTab = t.dataset.t; render(); },
    'add-expense': function () { openExpenseDialog(null); },
    'edit-expense': function (t) { openExpenseDialog(t.dataset.id); },
    'ledger-remove': async function (t) {
      var p = peopleList()[personIndex(t.dataset.id)];
      if (!p || !confirm('Remove ' + p.name + ' from this trip?')) return;
      try {
        var L = ledgerOf(S.data.room);
        var expenses = L.expenses.map(function (e) {
          var among = (e.among || []).filter(function (id) { return id !== p.id; });
          return Object.assign({}, e, { among: among, payerId: e.payerId === p.id ? (among[0] || e.payerId) : e.payerId });
        });
        await store.removePerson(p.id);
        if (p.id === S.me) { S.me = null; lsSet('pintu_me_' + S.code, ''); }
        if (expenses.length) await store.updateRoom(S.code, { bill: { kind: 'ledger', expenses: expenses, paid: {} } });
        refresh();
      } catch (err) { fail(err); }
    },
    'toggle-paid': function (t) {
      var L = ledgerOf(S.data.room), paid = Object.assign({}, L.paid);
      if (paid[t.dataset.key]) delete paid[t.dataset.key]; else paid[t.dataset.key] = true;
      saveLedger({ expenses: L.expenses, paid: paid });
    },
    'copy-summary': function () { copySummary(); },
    'backup': function () { openBackup(); },
    'spin': function () { spin(); },
    'spin-add': function () { S.spin.adding = true; renderSpin(); },
    'spin-remove': function (t) {
      S.spin.people.splice(+t.dataset.i, 1); saveSpinPeople(); renderSpin();
    },
  };
  $app.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || !ACTIONS[t.dataset.act]) return;
    ACTIONS[t.dataset.act](t, e);
  });
  $app.addEventListener('change', function (e) {
    if (e.target.name === 'decide' && S.spin) {
      S.spin.decision = e.target.value.trim() || 'Who covers dinner tonight';
      lsSet(DECIDE_KEY, S.spin.decision);
      return;
    }
    if (e.target.hasAttribute('data-venmo')) {
      var pid = e.target.getAttribute('data-venmo'), handle = e.target.value.trim().replace(/^@/, '') || null;
      var pp = peopleList()[personIndex(pid)];
      if (pp) pp.venmo = handle;
      store.updatePerson(pid, { venmo: handle }).catch(fail);
      return;
    }
    if (e.target.id !== 'whenDate' && e.target.id !== 'whenTime') return;
    var d = $('#whenDate').value, tm = $('#whenTime').value;
    // Leave the field first so the change redraws now (the pill shows the new time at once).
    if (d && tm) { e.target.blur(); setWhen({ date: d, time: tm }); }
  });
  $app.addEventListener('submit', function (e) {
    var f = e.target;
    e.preventDefault();
    // Typing defers redraws (isBusy); a submitted add-name form is done typing.
    if (/^(addFriendForm|ledgerPersonForm|joinAsForm|spinAddForm)$/.test(f.id) && document.activeElement) document.activeElement.blur();
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
    if (f.id === 'ledgerNewForm') return createLedgerFromForm(f);
    if (f.id === 'spinAddForm') {
      var sn = f.name.value.trim();
      if (!sn) return;
      S.spin.people.push(sn.slice(0, 30)); S.spin.adding = false; saveSpinPeople(); renderSpin();
      return;
    }
    if (f.id === 'ledgerPersonForm') {
      var lname = f.name.value.trim();
      if (!lname) return;
      store.addPerson(S.code, { name: lname }).then(function () { refresh(); }).catch(fail);
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

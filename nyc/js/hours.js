/* Pintu NYC — opening hours. Reads the part of OpenStreetMap's opening_hours
 * syntax that restaurants actually use and answers "is it open at this time?".
 * Pure functions that never throw. Works in the browser (window.PintuHours)
 * and in Node (module.exports).
 *
 * Supported:
 *   "24/7"                              always open
 *   rules separated by ";"              later rules override earlier ones
 *   Mo Tu We Th Fr Sa Su                day ranges "Mo-Fr", wrap-around "Fr-Mo", lists "Sa,Su"
 *   a rule with only times              applies to every day
 *   "11:00-22:00", "11:30-15:00,17:00-22:00"
 *   past midnight                       "18:00-02:00" (open after midnight counts for the next day)
 *   "off" / "closed"                    e.g. "Su off"
 * PH and SH rules are ignored. Anything else is unparseable -> null.
 *
 * dow:     0 = Sunday ... 6 = Saturday (same as Date#getDay)
 * minutes: minutes after midnight, 0..1439
 */
(function (root) {
  'use strict';

  var DAY_MIN = 1440;
  var DAY = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DAY_RANGE = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/;
  var CLOCK = /^(\d{1,2}):(\d{2})$/;
  var RANGE = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/;

  // "HH:MM" -> minutes. Hours up to 28 allow closing times like 26:00.
  function clock(text) {
    var m = CLOCK.exec(text);
    if (!m) return null;
    var h = +m[1], min = +m[2];
    if (h > 28 || min > 59) return null;
    return h * 60 + min;
  }

  // "11:30-15:00,17:00-22:00" -> [[690, 900], [1020, 1320]]; null if malformed.
  function parseTimes(text) {
    var out = [], parts = text.split(',');
    for (var i = 0; i < parts.length; i++) {
      var r = RANGE.exec(parts[i]);
      if (!r) return null;
      var s = clock(r[1]), e = clock(r[2]);
      if (s === null || e === null) return null;
      if (e <= s) e += DAY_MIN;  // closes after midnight
      out.push([s, e]);
    }
    return out;
  }

  // "Mo-Fr,Sa" -> [1, 2, 3, 4, 5, 6]; null if any part is not a day selector.
  function parseDays(text) {
    var out = [], parts = text.split(',');
    for (var i = 0; i < parts.length; i++) {
      var m = DAY_RANGE.exec(parts[i]);
      if (!m) return null;
      var from = DAY[m[1]], to = m[2] ? DAY[m[2]] : from;
      for (var d = from; ; d = (d + 1) % 7) {
        out.push(d);
        if (d === to) break;
      }
    }
    return out;
  }

  // Weekly schedule: spans[d] = [[start, end], ...] in minutes from midnight of day d.
  // An end past 1440 runs into the next day.
  function parse(text) {
    if (typeof text !== 'string') return null;
    var src = text.replace(/"[^"]*"/g, '').replace(/\s+/g, ' ').trim();
    if (!src) return null;
    var all = [0, 1, 2, 3, 4, 5, 6];
    if (src === '24/7') return { spans: all.map(function () { return [[0, DAY_MIN]]; }) };

    var spans = all.map(function () { return []; }), applied = 0;
    var rules = src.split(';');
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i].trim();
      if (!rule || /^(PH|SH)\b/.test(rule)) continue;

      var space = rule.indexOf(' '), first = space < 0 ? rule : rule.slice(0, space);
      var rest = space < 0 ? '' : rule.slice(space + 1).trim();
      var days = parseDays(first);
      if (!days) { days = all; rest = rule; }   // no day selector: every day

      if (!rest) return null;                   // "Mo-Fr" with no times
      var intervals;
      if (/^(off|closed)$/i.test(rest)) intervals = [];
      else {
        intervals = parseTimes(rest);
        if (!intervals) return null;
      }
      for (var k = 0; k < days.length; k++) spans[days[k]] = intervals.map(function (x) { return x.slice(); });
      applied++;
    }
    return applied ? { spans: spans } : null;
  }

  function validTime(dow, minutes) {
    return dow === (dow | 0) && dow >= 0 && dow <= 6 &&
      typeof minutes === 'number' && minutes >= 0 && minutes < DAY_MIN;
  }

  // The open interval containing `minutes` on day `dow`, in today's frame, or null.
  // Also checks yesterday's ranges that run past midnight.
  function intervalAt(sched, dow, minutes) {
    var today = sched.spans[dow], yesterday = sched.spans[(dow + 6) % 7], i, s, e;
    for (i = 0; i < today.length; i++) {
      s = today[i][0]; e = today[i][1];
      if (s <= minutes && minutes < e) return [s, e];
    }
    for (i = 0; i < yesterday.length; i++) {
      s = yesterday[i][0]; e = yesterday[i][1];
      if (s <= minutes + DAY_MIN && minutes + DAY_MIN < e) return [s - DAY_MIN, e - DAY_MIN];
    }
    return null;
  }

  // "8 PM", "8:30 PM", "midnight", "noon". Accepts minutes past 1440 too.
  function formatTime(min) {
    var x = ((min % DAY_MIN) + DAY_MIN) % DAY_MIN;
    if (x === 0) return 'midnight';
    if (x === 720) return 'noon';
    var h = Math.floor(x / 60), m = x % 60;
    return ((h % 12) || 12) + (m ? ':' + (m < 10 ? '0' : '') + m : '') + (h < 12 ? ' AM' : ' PM');
  }

  // Facts about one moment: {open, always, closes, opens} or null.
  //   closes: when the current stretch ends ("10 PM"), null if 24 hours
  //   opens:  the next opening later the same day, or null
  function info(hours, dow, minutes) {
    var sched = parse(hours);
    if (!sched || !validTime(dow, minutes)) return null;
    var iv = intervalAt(sched, dow, minutes);
    if (iv) {
      var always = iv[0] <= 0 && iv[1] >= DAY_MIN;
      return { open: true, always: always, closes: always ? null : formatTime(iv[1]), opens: null };
    }
    var next = null, today = sched.spans[dow];
    for (var i = 0; i < today.length; i++) {
      var s = today[i][0];
      if (s > minutes && s < DAY_MIN && (next === null || s < next)) next = s;
    }
    return { open: false, always: false, closes: null, opens: next === null ? null : formatTime(next) };
  }

  /** true / false, or null when the hours are empty or can't be read. */
  function isOpenAt(hours, dow, minutes) {
    try {
      var i = info(hours, dow, minutes);
      return i ? i.open : null;
    } catch (e) { return null; }
  }

  /** "Open until 10 PM", "Open 24 hours", "Closed then · opens 11 AM", "Closed that day", or null. */
  function describe(hours, dow, minutes) {
    try {
      var i = info(hours, dow, minutes);
      if (!i) return null;
      if (i.open) return i.always ? 'Open 24 hours' : 'Open until ' + i.closes;
      return i.opens ? 'Closed then · opens ' + i.opens : 'Closed that day';
    } catch (e) { return null; }
  }

  var api = {
    isOpenAt: isOpenAt,
    describe: describe,
    info: function (hours, dow, minutes) { try { return info(hours, dow, minutes); } catch (e) { return null; } },
    formatTime: formatTime,
    dayName: function (dow) { return DAY_NAMES[dow] || ''; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PintuHours = api;
})(typeof window !== 'undefined' ? window : this);

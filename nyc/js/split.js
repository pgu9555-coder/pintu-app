/* Pintu NYC — bill splitting. Pure functions, all money in integer cents.
 *
 * bill = {
 *   subtotal: cents before tax/tip (number),
 *   taxPct:   e.g. 8.875 (NYC sales tax),
 *   tipPct:   e.g. 20, applied to the pre-tax subtotal (US custom),
 *   payerId:  who paid the restaurant,
 *   shares:   { personId: weight }  — 1 = an even share, 0 = not in on it,
 *             or extra: { personId: cents } for items only one person had.
 * }
 */
(function (root) {
  'use strict';

  var NYC_TAX = 8.875;

  // Split `total` cents across weights so the parts add up exactly.
  function allocate(total, weights) {
    var ids = Object.keys(weights).filter(function (k) { return weights[k] > 0; });
    var sum = ids.reduce(function (a, k) { return a + weights[k]; }, 0);
    var out = {};
    if (!ids.length || !sum) return out;
    var given = 0;
    var rows = ids.map(function (k) {
      var exact = total * weights[k] / sum, base = Math.floor(exact);
      given += base;
      return { k: k, base: base, frac: exact - base };
    });
    rows.sort(function (a, b) { return b.frac - a.frac || (a.k < b.k ? -1 : 1); });
    for (var i = 0; i < rows.length; i++) out[rows[i].k] = rows[i].base + (i < total - given ? 1 : 0);
    return out;
  }

  /** Returns {tax, tip, total, perPerson: {id: cents}, owes: [{from, to, cents}]}. */
  function compute(bill) {
    var subtotal = Math.max(0, Math.round(bill.subtotal || 0));
    var extra = bill.extra || {};
    var extraSum = Object.keys(extra).reduce(function (a, k) { return a + Math.max(0, extra[k] || 0); }, 0);
    var shared = Math.max(0, subtotal - extraSum);

    var food = allocate(shared, bill.shares || {});
    Object.keys(extra).forEach(function (k) { food[k] = (food[k] || 0) + Math.max(0, extra[k] || 0); });

    var taxPct = bill.taxPct === undefined ? NYC_TAX : bill.taxPct;
    var tipPct = bill.tipPct === undefined ? 20 : bill.tipPct;
    var tax = Math.round(subtotal * taxPct / 100);
    var tip = Math.round(subtotal * tipPct / 100);

    // Tax and tip follow each person's share of the food.
    var weights = {};
    Object.keys(food).forEach(function (k) { weights[k] = food[k]; });
    var taxBy = allocate(tax, weights), tipBy = allocate(tip, weights);
    var perPerson = {};
    Object.keys(food).forEach(function (k) { perPerson[k] = food[k] + (taxBy[k] || 0) + (tipBy[k] || 0); });

    var owes = [];
    if (bill.payerId) {
      Object.keys(perPerson).forEach(function (k) {
        if (k !== bill.payerId && perPerson[k] > 0) owes.push({ from: k, to: bill.payerId, cents: perPerson[k] });
      });
    }
    return { subtotal: subtotal, tax: tax, tip: tip, total: subtotal + tax + tip, perPerson: perPerson, owes: owes };
  }

  function money(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  function parseMoney(text) {
    var n = parseFloat(String(text || '').replace(/[^0-9.]/g, ''));
    return isFinite(n) ? Math.round(n * 100) : 0;
  }

  /** Venmo payment link that opens the app (or the web) prefilled. */
  function venmoLink(username, cents, note) {
    var user = String(username || '').replace(/^@/, '').trim();
    if (!user) return null;
    return 'https://venmo.com/' + encodeURIComponent(user) +
      '?txn=pay&amount=' + (cents / 100).toFixed(2) +
      '&note=' + encodeURIComponent(note || 'Pintu');
  }

  /**
   * Total for one ledger expense, in cents. `cents` is the amount entered
   * (the food subtotal); when `taxTip` is set, NYC tax and a tip percentage
   * on that subtotal are added on top, the same way compute() does.
   */
  function expenseTotal(e) {
    var sub = Math.max(0, Math.round(e.cents || 0));
    if (!e.taxTip) return sub;
    var tipPct = e.tipPct == null ? 20 : e.tipPct;
    return sub + Math.round(sub * NYC_TAX / 100) + Math.round(sub * tipPct / 100);
  }

  /**
   * Trip ledger settlement. expenses: [{cents, payerId, among:[ids], taxTip, tipPct}].
   * Each expense is split exactly across `among` (integer cents, via allocate()).
   * Returns {total, balances:{id: cents}, transfers:[{from, to, cents}]}, where
   * balances are what each person is owed (+) or owes (-), summing to 0. Transfers
   * are greedy: the largest debtor pays the largest creditor, until everyone is square.
   */
  function settle(expenses, peopleIds) {
    var bal = {}, total = 0;
    (peopleIds || []).forEach(function (id) { bal[id] = 0; });
    (expenses || []).forEach(function (e) {
      var among = (e.among || []).filter(function (id) { return id; });
      if (!among.length) return;               // nobody to split with: not a real expense
      var amt = expenseTotal(e), weights = {};
      total += amt;
      among.forEach(function (id) { weights[id] = 1; });
      var shares = allocate(amt, weights);
      bal[e.payerId] = (bal[e.payerId] || 0) + amt;
      Object.keys(shares).forEach(function (id) { bal[id] = (bal[id] || 0) - shares[id]; });
    });
    var debtors = [], creditors = [];
    Object.keys(bal).forEach(function (id) {
      if (bal[id] < 0) debtors.push({ id: id, c: -bal[id] });
      else if (bal[id] > 0) creditors.push({ id: id, c: bal[id] });
    });
    var byAmount = function (a, b) { return b.c - a.c || (a.id < b.id ? -1 : 1); };
    debtors.sort(byAmount); creditors.sort(byAmount);
    var transfers = [], i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      var m = Math.min(debtors[i].c, creditors[j].c);
      transfers.push({ from: debtors[i].id, to: creditors[j].id, cents: m });
      debtors[i].c -= m; creditors[j].c -= m;
      if (debtors[i].c === 0) i++;
      if (creditors[j].c === 0) j++;
    }
    return { total: total, balances: bal, transfers: transfers };
  }

  var api = { NYC_TAX: NYC_TAX, allocate: allocate, compute: compute, expenseTotal: expenseTotal, settle: settle,
    money: money, parseMoney: parseMoney, venmoLink: venmoLink };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PintuSplit = api;
})(typeof window !== 'undefined' ? window : this);

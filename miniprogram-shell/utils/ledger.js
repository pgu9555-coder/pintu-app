function stamp() {
  return Date.now()
}

function empty(name, owner) {
  const now = stamp()
  const id = `member-${now}`
  return {
    name,
    nameUpdatedAt: now,
    members: [{ id, uid: owner.uid, name: owner.name, color: '#0F3D36', createdAt: now, updatedAt: now, updatedBy: owner.uid }],
    expenses: [],
    memberTombstones: {},
    expenseTombstones: {},
    nextMemberId: 2,
    nextExpenseId: 1,
    revision: now,
    updatedAt: now,
    updatedBy: owner.uid
  }
}

function totalCents(ledger) {
  return (ledger.expenses || []).reduce((total, expense) => total + (Number(expense.amountCents) || 0), 0)
}

function balances(ledger) {
  const out = {}
  ;(ledger.members || []).forEach((member) => {
    out[member.id] = { name: member.name, cents: 0 }
  })
  ;(ledger.expenses || []).forEach((expense) => {
    const splitIds = expense.splitIds || []
    const cents = Number(expense.amountCents) || 0
    if (!splitIds.length || !Number.isFinite(cents)) return
    if (out[expense.payerId]) out[expense.payerId].cents += cents
    const share = Math.floor(cents / splitIds.length)
    const extra = cents % splitIds.length
    splitIds.forEach((id, index) => {
      if (out[id]) out[id].cents -= share + (index < extra ? 1 : 0)
    })
  })
  return Object.keys(out).map((id) => Object.assign({ id }, out[id]))
}

function cloneTransfers(transfers) {
  return transfers.map((transfer) => Object.assign({}, transfer))
}

function settlementPlan(ledger) {
  const nodes = balances(ledger)
    .filter((row) => row.cents !== 0)
    .map((row, index) => Object.assign({}, row, { order: index }))
    .sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents) || a.order - b.order)

  function greedyTransfers() {
    const debt = nodes.filter((row) => row.cents < 0).map((row) => Object.assign({}, row, { cents: -row.cents }))
    const credit = nodes.filter((row) => row.cents > 0).map((row) => Object.assign({}, row))
    const rows = []
    let i = 0
    let j = 0
    while (i < debt.length && j < credit.length) {
      const cents = Math.min(debt[i].cents, credit[j].cents)
      rows.push({ from: debt[i].name, to: credit[j].name, cents })
      debt[i].cents -= cents
      credit[j].cents -= cents
      if (!debt[i].cents) i += 1
      if (!credit[j].cents) j += 1
    }
    return rows
  }

  // This explores every valid next transfer for the first non-zero balance.
  // Each branch zeros at least one endpoint, so the shortest result is minimal.
  function exactTransfers() {
    const initial = nodes.map((node) => node.cents)
    const memo = new Map()

    function solve(values) {
      const first = values.findIndex((value) => value !== 0)
      if (first < 0) return []
      const key = values.join(',')
      if (memo.has(key)) return cloneTransfers(memo.get(key))

      const current = values[first]
      let best = null
      const tried = new Set()
      for (let index = first + 1; index < values.length; index += 1) {
        const opposite = values[index]
        if (!opposite || current * opposite >= 0 || tried.has(opposite)) continue
        tried.add(opposite)
        const cents = Math.min(Math.abs(current), Math.abs(opposite))
        const next = values.slice()
        const transfer = current < 0
          ? { from: nodes[first].name, to: nodes[index].name, cents }
          : { from: nodes[index].name, to: nodes[first].name, cents }
        if (current < 0) {
          next[first] += cents
          next[index] -= cents
        } else {
          next[first] -= cents
          next[index] += cents
        }
        const candidate = [transfer].concat(solve(next))
        if (!best || candidate.length < best.length) best = candidate
      }
      const result = best || []
      memo.set(key, cloneTransfers(result))
      return cloneTransfers(result)
    }

    return solve(initial)
  }

  if (nodes.length <= 10) return { rows: exactTransfers(), exact: true }
  return { rows: greedyTransfers(), exact: false }
}

function settlements(ledger) {
  return settlementPlan(ledger).rows
}

module.exports = { stamp, empty, totalCents, balances, settlementPlan, settlements }

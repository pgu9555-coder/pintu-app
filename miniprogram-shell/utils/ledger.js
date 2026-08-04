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

function settlements(ledger) {
  const balanceRows = balances(ledger).map((row) => Object.assign({}, row))
  const debt = balanceRows.filter((row) => row.cents < 0)
  const credit = balanceRows.filter((row) => row.cents > 0)
  const rows = []
  let i = 0
  let j = 0
  while (i < debt.length && j < credit.length) {
    const cents = Math.min(-debt[i].cents, credit[j].cents)
    rows.push({ from: debt[i].name, to: credit[j].name, cents })
    debt[i].cents += cents
    credit[j].cents -= cents
    if (!debt[i].cents) i += 1
    if (!credit[j].cents) j += 1
  }
  return rows
}

module.exports = { stamp, empty, totalCents, balances, settlements }

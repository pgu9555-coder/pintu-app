const FORMAT = 'pintu-ledger-backup'
const MAX_BYTES = 5 * 1024 * 1024
const LOCAL_KEY = 'pintu-local-ledger-trips-v1'

function byteLength(text) {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i += 1 }
    else bytes += 3
  }
  return bytes
}

function safeId(value) {
  return ['string', 'number'].includes(typeof value) && /^[A-Za-z0-9_-]{1,80}$/.test(String(value)) && !['__proto__', 'constructor', 'prototype'].includes(String(value))
}

// Export only portable ledger content. Account identifiers, room permissions,
// tombstones and pending cloud changes never belong in a backup file.
function portableTrip(trip) {
  if (!trip || !Array.isArray(trip.members) || !Array.isArray(trip.expenses) || trip.members.length > 500 || trip.expenses.length > 1000) throw new Error('账本格式或大小无效')
  const seen = new Set()
  const members = trip.members.map((member) => {
    const name = String(member && member.name || '').trim()
    if (!member || !safeId(member.id) || seen.has(String(member.id)) || !name || name.length > 24) throw new Error('成员数据无效')
    const id = String(member.id)
    seen.add(id)
    return { id, name, color: /^#[a-f0-9]{6}$/i.test(member.color || '') ? member.color : '#0F3D36' }
  })
  const expenses = trip.expenses.map((expense, index) => {
    if (!expense || typeof expense !== 'object') throw new Error('支出数据无效')
    const desc = String(expense.desc || '').trim()
    const splitIds = Array.isArray(expense.splitIds) ? expense.splitIds.map(String) : []
    if (!desc || desc.length > 100 || !Number.isSafeInteger(expense.amountCents) || expense.amountCents <= 0 || expense.amountCents > 1e12 || !seen.has(String(expense.payerId)) || !splitIds.length || new Set(splitIds).size !== splitIds.length || !splitIds.every((id) => seen.has(id))) throw new Error('支出数据无效')
    return { id: `import-expense-${index}`, desc, amountCents: expense.amountCents, payerId: String(expense.payerId), splitIds }
  })
  return { name: String(trip.name || '未命名账本').slice(0, 60), members, expenses }
}

function validateBackup(data) {
  if (!data || data.format !== FORMAT || data.version !== 1 || !Array.isArray(data.trips) || data.trips.length > 100) throw new Error('不支持的备份格式')
  return data.trips.map(portableTrip)
}

function parseBackup(text) {
  if (typeof text !== 'string' || byteLength(text) > MAX_BYTES) throw new Error('请选择不超过 5MB 的 JSON 备份')
  return validateBackup(JSON.parse(text.replace(/^\uFEFF/, '')))
}

function createBackup(localEntries, cacheEntries, now) {
  const entries = Array.isArray(localEntries) ? localEntries : []
  const trips = entries.filter((entry) => entry && entry.ledger && Array.isArray(entry.ledger.members) && entry.ledger.members.length).map((entry) => portableTrip(entry.ledger))
  ;(Array.isArray(cacheEntries) ? cacheEntries : []).forEach((entry) => {
    if (!entry || !entry.ledger || !Array.isArray(entry.ledger.members) || !entry.ledger.members.length) return
    const cached = portableTrip(entry.ledger)
    const related = entries.filter((local) => local && local.sourceRoomDocId === entry.docId)
    // A book retained on leaving a room may be older than a new downloaded
    // snapshot, or may have been edited independently. Only identical copies
    // are safe to collapse; otherwise preserve both histories.
    if (related.some((local) => JSON.stringify(portableTrip(local.ledger)) === JSON.stringify(cached))) return
    if (related.length) cached.name = `${cached.name.slice(0, 52)}（共享快照）`
    trips.push(cached)
  })
  if (trips.length > 100) throw new Error('账本超过 100 个，请先分批整理')
  const data = { format: FORMAT, version: 1, exportedAt: new Date(now === undefined ? Date.now() : now).toISOString(), trips }
  const text = JSON.stringify(data, null, 2)
  if (byteLength(text) > MAX_BYTES) throw new Error('备份超过 5MB，请先分批整理')
  return { data, text }
}

function importTrips(storage, portable, options) {
  // Revalidate the whole batch before touching existing storage. Remap every
  // identifier so importing the same file twice always creates independent books.
  const trips = validateBackup({ format: FORMAT, version: 1, trips: portable })
  const now = options && options.now !== undefined ? options.now : Date.now()
  const random = options && options.random || Math.random
  const current = storage.getLocal(LOCAL_KEY, { trips: [] })
  if (!current || !Array.isArray(current.trips)) throw new Error('本机账本索引无效，现有记录未修改')
  const existingIds = new Set(current.trips.map((entry) => entry && entry.tripId))
  const added = trips.map((trip, index) => {
    const base = `trip-${now.toString(36)}-${random().toString(36).slice(2, 10)}-${index}`
    let tripId = base
    let suffix = 0
    while (existingIds.has(tripId)) { suffix += 1; tripId = `${base}-${suffix}` }
    existingIds.add(tripId)
    const ids = new Map()
    const members = trip.members.map((member, memberIndex) => {
      const id = `member-${memberIndex + 1}`
      ids.set(member.id, id)
      return Object.assign({}, member, { id, createdAt: now, updatedAt: now })
    })
    const expenses = trip.expenses.map((expense, expenseIndex) => Object.assign({}, expense, {
      id: `expense-${expenseIndex + 1}`, payerId: ids.get(expense.payerId), splitIds: expense.splitIds.map((id) => ids.get(id)), createdAt: now, updatedAt: now
    }))
    return { tripId, createdAt: now, updatedAt: now, ledger: {
      name: trip.name, nameUpdatedAt: now, members, expenses, memberTombstones: {}, expenseTombstones: {},
      nextMemberId: members.length + 1, nextExpenseId: expenses.length + 1, revision: now, updatedAt: now, updatedBy: 'local-device'
    } }
  })
  if (!added.length) return 0
  if (!storage.setLocal(LOCAL_KEY, { trips: current.trips.concat(added) })) throw new Error('本机空间不足或保存失败，现有账本未修改')
  return added.length
}

module.exports = { FORMAT, MAX_BYTES, LOCAL_KEY, byteLength, portableTrip, validateBackup, parseBackup, createBackup, importTrips }

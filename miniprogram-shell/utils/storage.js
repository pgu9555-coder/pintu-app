const KEY = 'pintu-native-rooms'
const SUPPORTED_TYPES = new Set(['midpoint', 'ledger'])
const LOCAL_KEYS = new Set(['pintu-local-ledger-trips-v1', 'pintu-local-midpoint-v2'])
const LEDGER_CACHE_KEY = 'pintu-ledger-backup-cache-v1'
const backup = require('./ledger-backup')

// Mini-program storage belongs to the device, not to the currently signed-in
// WeChat account. Keep the active account scope in memory only, and prefix
// every persisted key with the server-issued opaque profile hash. This avoids
// showing one WeChat user's local rooms, name, or drafts to another account on
// the same phone.
let accountScope = ''

function scopeFromProfile(profile) {
  const prefix = String(profile && profile.avatarUploadPrefix || '')
  const match = prefix.match(/^avatars\/profile-([a-f0-9]{64})\/$/)
  return match ? match[1] : ''
}

function setAccountScope(profileOrScope) {
  const raw = typeof profileOrScope === 'string'
    ? profileOrScope
    : scopeFromProfile(profileOrScope)
  const match = String(raw || '').match(/^(?:profile-)?([a-f0-9]{64})$/)
  accountScope = match ? match[1] : ''
  return Boolean(accountScope)
}

function clearAccountScope() {
  accountScope = ''
}

function isAccountScoped() {
  return Boolean(accountScope)
}

function scopedKey(key) {
  if (!accountScope) return ''
  return `pintu-account-${accountScope}:${String(key || '')}`
}

function getScoped(key, fallback) {
  const target = scopedKey(key)
  if (!target) return fallback
  try {
    const value = wx.getStorageSync(target)
    return value === undefined || value === null || value === '' ? fallback : value
  } catch (_) {
    return fallback
  }
}

function setScoped(key, value) {
  const target = scopedKey(key)
  if (!target) return false
  try {
    wx.setStorageSync(target, value)
    return true
  } catch (_) {
    return false
  }
}

function removeScoped(key) {
  const target = scopedKey(key)
  if (!target) return false
  try {
    wx.removeStorageSync(target)
    return true
  } catch (_) {
    return false
  }
}

// Only explicitly local drafts may exist before login. Guest storage is a
// separate device space; logging in never merges it into an account.
function localScopeToken() {
  return accountScope || 'guest'
}

function getLocal(key, fallback) {
  if (!LOCAL_KEYS.has(key)) return fallback
  if (accountScope) return getScoped(key, fallback)
  try {
    const value = wx.getStorageSync(`pintu-guest:${key}`)
    return value === undefined || value === null || value === '' ? fallback : value
  } catch (_) { return fallback }
}

function setLocal(key, value) {
  if (!LOCAL_KEYS.has(key)) return false
  if (accountScope) return setScoped(key, value)
  try { wx.setStorageSync(`pintu-guest:${key}`, value); return true } catch (_) { return false }
}

function getLedgerBackupCache() {
  const value = getScoped(LEDGER_CACHE_KEY, [])
  if (!Array.isArray(value)) return []
  return value.slice(0, 20).map((entry) => {
    try {
      if (!entry || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.docId || '')) return null
      return { docId: entry.docId, ledger: backup.portableTrip(entry.ledger), updatedAt: Number(entry.updatedAt) || 0 }
    } catch (_) { return null }
  }).filter(Boolean)
}

function cacheLedgerSnapshot(docId, ledger) {
  if (!accountScope || !/^[A-Za-z0-9_-]{1,128}$/.test(docId || '')) return false
  try {
    const portable = backup.portableTrip(ledger)
    const previous = getLedgerBackupCache()
    const existing = previous.find((entry) => entry.docId === docId)
    if (existing && JSON.stringify(existing.ledger) === JSON.stringify(portable)) return true
    let next = [{ docId, ledger: portable, updatedAt: Date.now() }].concat(previous.filter((entry) => entry.docId !== docId)).slice(0, 20)
    while (next.length && backup.byteLength(JSON.stringify(next)) > backup.MAX_BYTES) next.pop()
    if (!next.length) return false
    return setScoped(LEDGER_CACHE_KEY, next)
  } catch (_) { return false }
}

function isValidEntry(entry) {
  return Boolean(
    entry &&
    typeof entry.docId === 'string' &&
    entry.docId &&
    entry.room &&
    SUPPORTED_TYPES.has(entry.room.toolType)
  )
}

function compactEntry(entry) {
  if (!isValidEntry(entry)) return null
  return {
    docId: entry.docId,
    visitedAt: Number(entry.visitedAt) || Date.now(),
    room: {
      name: String(entry.room.name || '未命名房间').slice(0, 60),
      code: String(entry.room.code || '').slice(0, 8),
      toolType: entry.room.toolType
    }
  }
}

function all() {
  const stored = getScoped(KEY, [])
  return Array.isArray(stored) ? stored.map(compactEntry).filter(Boolean) : []
}

function save(entry) {
  const compact = compactEntry(entry)
  if (!compact) return all()
  const rooms = all().filter((item) => item.docId !== entry.docId)
  rooms.unshift(Object.assign({}, compact, { visitedAt: Date.now() }))
  const limited = rooms.slice(0, 20)
  setScoped(KEY, limited)
  return limited
}

function remove(docId) {
  setScoped(KEY, all().filter((item) => item.docId !== docId))
}

function getName() {
  return getScoped('pintu-name', '')
}

function saveName(name) {
  setScoped('pintu-name', String(name || '').slice(0, 24))
}

module.exports = {
  all,
  save,
  remove,
  getName,
  saveName,
  scopeFromProfile,
  setAccountScope,
  clearAccountScope,
  isAccountScoped,
  getScoped,
  setScoped,
  removeScoped,
  getLocal,
  setLocal,
  localScopeToken,
  cacheLedgerSnapshot,
  getLedgerBackupCache
}

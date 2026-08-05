const KEY = 'pintu-native-rooms'
const SUPPORTED_TYPES = new Set(['midpoint', 'ledger'])

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
  removeScoped
}

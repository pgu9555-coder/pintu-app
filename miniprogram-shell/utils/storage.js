const KEY = 'pintu-native-rooms'
const SUPPORTED_TYPES = new Set(['midpoint', 'ledger'])

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
  try {
    const stored = wx.getStorageSync(KEY)
    return Array.isArray(stored) ? stored.map(compactEntry).filter(Boolean) : []
  } catch (_) {
    return []
  }
}

function save(entry) {
  const compact = compactEntry(entry)
  if (!compact) return all()
  const rooms = all().filter((item) => item.docId !== entry.docId)
  rooms.unshift(Object.assign({}, compact, { visitedAt: Date.now() }))
  const limited = rooms.slice(0, 20)
  try {
    wx.setStorageSync(KEY, limited)
  } catch (_) {}
  return limited
}

function remove(docId) {
  try {
    wx.setStorageSync(KEY, all().filter((item) => item.docId !== docId))
  } catch (_) {}
}

function getName() {
  try {
    return wx.getStorageSync('pintu-name') || ''
  } catch (_) {
    return ''
  }
}

function saveName(name) {
  try {
    wx.setStorageSync('pintu-name', String(name || '').slice(0, 24))
  } catch (_) {}
}

module.exports = { all, save, remove, getName, saveName }

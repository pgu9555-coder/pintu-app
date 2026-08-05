const storage = require('../../utils/storage')
const gateway = require('../../services/roomGateway')
const layout = require('../../utils/layout')

const LOCAL_LEDGER_TRIPS_KEY = 'pintu-local-ledger-trips-v1'
const LEDGER_OUTBOX_KEY = 'pintu-ledger-outbox-v1'

const PAGE_BY_TYPE = {
  midpoint: '/pages/midpoint/index',
  ledger: '/pages/ledger/index'
}

function displayRoom(entry) {
  const isMidpoint = entry.room.toolType === 'midpoint'
  return Object.assign({}, entry, {
    typeLabel: isMidpoint ? '碰面' : '账本',
    typeIcon: isMidpoint ? '/assets/icons/midpoint.svg' : '/assets/icons/receipt.svg',
    iconTone: isMidpoint ? 'meetup' : 'ledger',
    totalYuan: (Number(entry.totalCents || 0) / 100).toFixed(2),
    showTotal: !isMidpoint && Number(entry.totalCents || 0) > 0
  })
}

function uniqueRooms(rooms) {
  const seen = new Set()
  return rooms.filter((entry) => {
    if (!entry || !entry.docId || !entry.room || seen.has(entry.docId)) return false
    seen.add(entry.docId)
    return true
  })
}

function cleanTripId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
}

function localTripEntries() {
  const container = storage.getScoped(LOCAL_LEDGER_TRIPS_KEY, { trips: [] })
  return Array.isArray(container && container.trips)
    ? container.trips.filter((trip) => {
      const ledger = trip && trip.ledger
      return Boolean(
        cleanTripId(trip && trip.tripId) &&
        ledger && Array.isArray(ledger.members) && Array.isArray(ledger.expenses) &&
        (String(ledger.name || '').trim() || ledger.members.length || ledger.expenses.length)
      )
    })
    : []
}

function displayLocalTrip(entry) {
  const ledger = entry.ledger
  const totalCents = ledger.expenses.reduce((sum, expense) => sum + (Number(expense.amountCents) || 0), 0)
  return {
    tripId: entry.tripId,
    name: String(ledger.name || '').trim() || '未命名行程',
    memberCount: ledger.members.length,
    expenseCount: ledger.expenses.length,
    totalYuan: (totalCents / 100).toFixed(2),
    showTotal: totalCents > 0
  }
}

function ledgerOutboxEntries() {
  const container = storage.getScoped(LEDGER_OUTBOX_KEY, { entries: {} })
  return container && container.entries && typeof container.entries === 'object'
    ? container.entries
    : {}
}

function ledgerOutboxEntry(docId) {
  const entry = ledgerOutboxEntries()[docId]
  return entry && entry.ledger && Array.isArray(entry.ledger.expenses) ? entry : null
}

function clearLedgerOutboxEntry(docId, mutationId) {
  const entries = Object.assign({}, ledgerOutboxEntries())
  if (!entries[docId] || (mutationId && entries[docId].mutationId !== mutationId)) return false
  delete entries[docId]
  return storage.setScoped(LEDGER_OUTBOX_KEY, { entries })
}

function isNonRetryableLedgerError(error) {
  return ['INVALID_LEDGER', 'INVALID_REQUEST', 'INVALID_DECISION', 'FORBIDDEN', 'WRONG_ROOM_TYPE', 'ROOM_TYPE_MISMATCH', 'CONTENT_REJECTED'].includes(error && error.code)
}

function blockLedgerOutboxEntry(docId, entry, error) {
  const entries = Object.assign({}, ledgerOutboxEntries())
  if (!entries[docId] || entries[docId].mutationId !== entry.mutationId) return false
  entries[docId] = Object.assign({}, entry, {
    blocked: true,
    blockedCode: String((error && error.code) || 'SYNC_CONFLICT').slice(0, 60),
    blockedMessage: String((error && error.message) || '账本内容和房间状态冲突，请修改后再保存').slice(0, 120),
    blockedAt: Date.now()
  })
  return storage.setScoped(LEDGER_OUTBOX_KEY, { entries })
}

function snapshotTripId(docId) {
  return `room-${cleanTripId(docId)}`.slice(0, 80)
}

function restoreRoomSnapshot(docId, previous) {
  const trips = localTripEntries().filter((entry) => entry.tripId !== snapshotTripId(docId) && entry.sourceRoomDocId !== docId)
  return storage.setScoped(LOCAL_LEDGER_TRIPS_KEY, { trips: previous ? [previous].concat(trips) : trips })
}

function saveRoomSnapshot(docId, roomName, ledger, force) {
  const tripId = snapshotTripId(docId)
  const previous = localTripEntries()
  const existing = previous.find((entry) => entry.tripId === tripId || entry.sourceRoomDocId === docId)
  const others = previous.filter((entry) => entry.tripId !== tripId && entry.sourceRoomDocId !== docId)
  const hasContent = Boolean(
    ledger && Array.isArray(ledger.members) && Array.isArray(ledger.expenses) &&
    (String(ledger.name || '').trim() || ledger.members.length || ledger.expenses.length)
  )
  if (!hasContent || (!force && !ledger.expenses.length)) {
    // A request may time out after CloudBase has accepted it. Preserve an
    // older local recovery copy until a later explicit cleanup instead of
    // deleting it before leave/disband is known to have completed.
    return ''
  }
  const now = Date.now()
  const snapshotLedger = Object.assign({}, ledger, {
    name: String(ledger.name || roomName || '').slice(0, 20)
  })
  const saved = storage.setScoped(LOCAL_LEDGER_TRIPS_KEY, {
    trips: [{
      tripId,
      sourceRoomDocId: docId,
      createdAt: Number(existing && existing.createdAt) || now,
      updatedAt: now,
      ledger: snapshotLedger
    }].concat(others)
  })
  return saved ? tripId : null
}

Page({
  data: {
    localTrips: [],
    rooms: [],
    loading: false,
    loadingMore: false,
    cloudError: '',
    roomActionBusyId: '',
    hasMore: false,
    nextCursor: null,
    headerTopPx: 72
  },

  onLoad() {
    this.setData({ headerTopPx: layout.headerTopPx() })
  },

  onShow() {
    this.refresh()
  },

  async ensureAccountScope() {
    if (this.scopeReady) return true
    try {
      const app = getApp()
      if (!app || typeof app.ensureAccountScope !== 'function' || !await app.ensureAccountScope()) {
        throw new Error('账号身份未就绪')
      }
      this.scopeReady = true
      return true
    } catch (_) {
      this.setData({
        localTrips: [],
        rooms: [],
        loading: false,
        loadingMore: false,
        cloudError: '账号身份未就绪，请返回首页后重试',
        hasMore: false,
        nextCursor: null
      })
      wx.showToast({ title: '账号身份未就绪，请返回首页后重试', icon: 'none' })
      return false
    }
  },

  refreshLocalTrips() {
    if (!this.scopeReady) return
    this.setData({ localTrips: localTripEntries().map(displayLocalTrip) })
  },

  async reconcileLedgerOutbox(requestId) {
    const entries = ledgerOutboxEntries()
    const docIds = Object.keys(entries)
    if (!docIds.length) return
    let restoredCount = 0
    let syncedCount = 0

    for (const docId of docIds) {
      if (requestId !== this.myRoomsRequestId) return
      const entry = ledgerOutboxEntry(docId)
      if (!entry) continue
      if (entry.blocked) continue
      try {
        const result = await gateway.getRoom(docId)
        if (requestId !== this.myRoomsRequestId) return
        if (!result.room || !result.viewer || entry.membershipEpoch !== result.viewer.membershipEpoch) {
          const snapshotId = saveRoomSnapshot(docId, entry.roomName, entry.ledger, true)
          if (snapshotId === null) continue
          if (!clearLedgerOutboxEntry(docId, entry.mutationId)) continue
          storage.remove(docId)
          if (snapshotId) restoredCount += 1
          continue
        }

        const synced = await gateway.syncLedger(docId, entry.ledger, entry.membershipEpoch)
        if (!synced || !synced.ledger || !clearLedgerOutboxEntry(docId, entry.mutationId)) continue
        syncedCount += 1
        const totalCents = synced.ledger.expenses.reduce((sum, expense) => sum + (Number(expense.amountCents) || 0), 0)
        this.setData({
          rooms: this.data.rooms.map((roomEntry) => roomEntry.docId === docId
            ? Object.assign({}, roomEntry, {
              room: Object.assign({}, roomEntry.room, { ledger: synced.ledger }),
              totalCents,
              totalYuan: (totalCents / 100).toFixed(2),
              showTotal: totalCents > 0
            })
            : roomEntry)
        })
      } catch (error) {
        if (isNonRetryableLedgerError(error)) {
          blockLedgerOutboxEntry(docId, entry, error)
          continue
        }
        if (!['ROOM_NOT_FOUND', 'STALE_MEMBERSHIP'].includes(error && error.code)) continue
        const snapshotId = saveRoomSnapshot(docId, entry.roomName, entry.ledger, true)
        if (snapshotId === null) continue
        if (!clearLedgerOutboxEntry(docId, entry.mutationId)) continue
        storage.remove(docId)
        if (snapshotId) restoredCount += 1
      }
    }

    if (requestId !== this.myRoomsRequestId) return
    this.refreshLocalTrips()
    if (restoredCount) {
      wx.showToast({ title: `已保留 ${restoredCount} 个未同步账本`, icon: 'none' })
    } else if (syncedCount) {
      wx.showToast({ title: '待同步账本已上传', icon: 'success' })
    }
  },

  async refresh() {
    const requestId = (this.myRoomsRequestId || 0) + 1
    this.myRoomsRequestId = requestId
    this.setData({ loading: true, cloudError: '' })
    if (!await this.ensureAccountScope() || requestId !== this.myRoomsRequestId) return
    this.refreshLocalTrips()
    this.setData({
      rooms: [],
      loadingMore: false,
      cloudError: '',
      hasMore: false,
      nextCursor: null
    })
    try {
      const result = await gateway.listMyRooms(null, 50)
      if (requestId !== this.myRoomsRequestId) return
      const rooms = uniqueRooms(Array.isArray(result.rooms) ? result.rooms : [])
      this.setData({
        rooms: rooms.map(displayRoom),
        loading: false,
        cloudError: '',
        hasMore: Boolean(result.hasMore),
        nextCursor: result.nextCursor && typeof result.nextCursor === 'object' ? result.nextCursor : null
      })
      await this.reconcileLedgerOutbox(requestId)
    } catch (error) {
      if (requestId !== this.myRoomsRequestId) return
      this.setData({
        rooms: [],
        loading: false,
        cloudError: error.message || '云端房间暂时无法加载',
        hasMore: false,
        nextCursor: null
      })
    }
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return
    if (!await this.ensureAccountScope()) return
    const requestId = this.myRoomsRequestId || 0
    const cursor = this.data.nextCursor
    if (!cursor || !Number.isSafeInteger(cursor.createdAt) || !cursor.docId) return
    this.setData({ loadingMore: true, cloudError: '' })
    try {
      const result = await gateway.listMyRooms(cursor, 50)
      if (requestId !== this.myRoomsRequestId) return
      const rooms = uniqueRooms(this.data.rooms.concat(Array.isArray(result.rooms) ? result.rooms : []))
      this.setData({
        rooms: rooms.map(displayRoom),
        loadingMore: false,
        hasMore: Boolean(result.hasMore),
        nextCursor: result.nextCursor && typeof result.nextCursor === 'object' ? result.nextCursor : null
      })
    } catch (error) {
      if (requestId !== this.myRoomsRequestId) return
      this.setData({
        loadingMore: false,
        cloudError: error.message || '更多云端房间暂时无法加载'
      })
    }
  },

  open(event) {
    if (!this.scopeReady) return
    const { id } = event.currentTarget.dataset
    const entry = this.data.rooms.find((item) => item.docId === id)
    const page = entry && PAGE_BY_TYPE[entry.room.toolType]
    if (!page || !id || !entry) {
      wx.showToast({ title: '房间记录已失效', icon: 'none' })
      return
    }
    storage.save({ docId: entry.docId, room: entry.room })
    wx.navigateTo({
      url: `${page}?docId=${encodeURIComponent(id)}`,
      fail: () => wx.showToast({ title: '暂时无法打开房间', icon: 'none' })
    })
  },

  async roomAction(event) {
    if (!await this.ensureAccountScope()) return
    const docId = String(event.currentTarget.dataset.id || '')
    const summary = this.data.rooms.find((entry) => entry.docId === docId)
    if (!summary || this.data.roomActionBusyId) return
    this.setData({ roomActionBusyId: docId })
    let snapshotId = ''
    try {
      const result = await gateway.getRoom(docId)
      if (!result.room || !result.viewer) {
        storage.remove(docId)
        wx.showToast({ title: '房间已结束或你已退出', icon: 'none' })
        await this.refresh()
        return
      }
      const room = result.room
      const viewer = result.viewer
      const isOwner = Boolean(viewer.isOwner)
      const action = isOwner ? 'disband' : 'leave'
      const pending = ledgerOutboxEntry(docId)
      const stalePending = pending && pending.membershipEpoch !== viewer.membershipEpoch ? pending : null
      const ledger = (pending && pending.ledger) || room.ledger
      const hasExpenses = Boolean(ledger && ledger.expenses && ledger.expenses.length)
      const confirmed = await new Promise((resolve) => wx.showModal({
        title: isOwner ? '解散这个房间？' : '退出这个房间？',
        content: `${isOwner ? '解散后所有成员都无法再进入。' : '退出后房间会从你的列表移除，其他成员仍可继续使用。'}${hasExpenses ? ' 已有支出会保留为本机历史行程。' : ''}`,
        success: (choice) => resolve(Boolean(choice.confirm)),
        fail: () => resolve(false)
      }))
      if (!confirmed) return

      snapshotId = saveRoomSnapshot(docId, room.name, ledger, Boolean(pending))
      if (snapshotId === null) throw new Error('无法保存账本快照，请清理本机空间后重试')
      if (stalePending) clearLedgerOutboxEntry(docId, stalePending.mutationId)
      await gateway[action](docId)
      clearLedgerOutboxEntry(docId, pending && pending.mutationId)
      storage.remove(docId)
      wx.showToast({ title: isOwner ? '房间已解散' : '已退出房间', icon: 'success' })
      await this.refresh()
    } catch (error) {
      // The request may have reached CloudBase even when its response was
      // interrupted. Preserve the newest recovery snapshot in that case.
      wx.showToast({ title: error.message || '操作失败，房间仍然保留', icon: 'none' })
    } finally {
      this.setData({ roomActionBusyId: '' })
    }
  },

  async newLocal() {
    if (!await this.ensureAccountScope()) return
    wx.navigateTo({
      url: '/pages/ledger/index',
      fail: () => wx.showToast({ title: '暂时无法新建行程', icon: 'none' })
    })
  },

  async openLocal(event) {
    if (!await this.ensureAccountScope()) return
    const tripId = cleanTripId(event.currentTarget.dataset.id)
    if (!tripId || !localTripEntries().some((entry) => entry.tripId === tripId)) {
      wx.showToast({ title: '本地行程已不存在', icon: 'none' })
      this.refreshLocalTrips()
      return
    }
    wx.navigateTo({
      url: `/pages/ledger/index?tripId=${encodeURIComponent(tripId)}`,
      fail: () => wx.showToast({ title: '暂时无法打开行程', icon: 'none' })
    })
  },

  async deleteLocal(event) {
    if (!await this.ensureAccountScope()) return
    const tripId = cleanTripId(event.currentTarget.dataset.id)
    const entry = localTripEntries().find((item) => item.tripId === tripId)
    if (!entry) {
      this.refreshLocalTrips()
      return
    }
    const name = String(entry.ledger.name || '').trim() || '这趟本地行程'
    wx.showModal({
      title: '删除本地行程？',
      content: `删除“${name}”后，其中的成员和支出无法恢复。`,
      success: (result) => {
        if (!result.confirm) return
        const trips = localTripEntries().filter((item) => item.tripId !== tripId)
        if (!storage.setScoped(LOCAL_LEDGER_TRIPS_KEY, { trips })) {
          wx.showToast({ title: '本机存储异常，删除未完成', icon: 'none' })
          return
        }
        this.refreshLocalTrips()
        wx.showToast({ title: '已删除本地行程', icon: 'success' })
      }
    })
  }
})

const gateway = require('../../services/roomGateway')
const storage = require('../../utils/storage')
const math = require('../../utils/ledger')
const layout = require('../../utils/layout')
const LOCAL_LEDGER_TRIPS_KEY = 'pintu-local-ledger-trips-v1'
const LEDGER_OUTBOX_KEY = 'pintu-ledger-outbox-v1'
const PENDING_CREATE_KEY = 'pintu-ledger-pending-create-v1'

function cleanCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, '')
    .slice(0, 8)
}

function roomInput(name) {
  return { name: `${name} 发起的账本`, toolType: 'ledger', members: [{ name }] }
}

function requestId() {
  return `mini_ledger_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function message(error, fallback) {
  return (error && error.message) || fallback
}

function emptyLocalLedger() {
  const now = math.stamp()
  return {
    name: '', nameUpdatedAt: now, members: [], expenses: [],
    memberTombstones: {}, expenseTombstones: {}, nextMemberId: 1,
    nextExpenseId: 1, revision: now, updatedAt: now, updatedBy: 'local-device'
  }
}

function cleanTripId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
}

function newTripId() {
  return `trip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function isLedger(value) {
  return Boolean(value && Array.isArray(value.members) && Array.isArray(value.expenses))
}

function hasLocalTripContent(ledger) {
  return Boolean(
    String(ledger && ledger.name || '').trim() ||
    (ledger && ledger.members && ledger.members.length) ||
    (ledger && ledger.expenses && ledger.expenses.length)
  )
}

function localTripEntries() {
  const container = storage.getScoped(LOCAL_LEDGER_TRIPS_KEY, { trips: [] })
  return Array.isArray(container && container.trips)
    ? container.trips.filter((trip) => cleanTripId(trip && trip.tripId) && isLedger(trip.ledger))
    : []
}

function localLedgerForTrip(tripId) {
  const trip = localTripEntries().find((entry) => entry.tripId === tripId)
  return trip && trip.ledger
}

function saveLocalLedger(tripId, ledger) {
  const previous = localTripEntries()
  const existing = previous.find((entry) => entry.tripId === tripId)
  const others = previous.filter((entry) => entry.tripId !== tripId)
  const trips = hasLocalTripContent(ledger)
    ? [{
      tripId,
      createdAt: Number(existing && existing.createdAt) || math.stamp(),
      updatedAt: Number(ledger.updatedAt) || math.stamp(),
      ledger
    }].concat(others)
    : others
  return storage.setScoped(LOCAL_LEDGER_TRIPS_KEY, { trips })
}

function ledgerOutboxEntries() {
  const container = storage.getScoped(LEDGER_OUTBOX_KEY, { entries: {} })
  return container && container.entries && typeof container.entries === 'object'
    ? container.entries
    : {}
}

function ledgerOutboxEntry(docId) {
  const entry = ledgerOutboxEntries()[docId]
  return entry && isLedger(entry.ledger) ? entry : null
}

function saveLedgerOutboxEntry(docId, entry) {
  const entries = Object.assign({}, ledgerOutboxEntries(), { [docId]: entry })
  return storage.setScoped(LEDGER_OUTBOX_KEY, { entries })
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

function blockLedgerOutboxEntry(docId, mutationId, error) {
  const entry = ledgerOutboxEntry(docId)
  if (!entry || (mutationId && entry.mutationId !== mutationId)) return false
  return saveLedgerOutboxEntry(docId, Object.assign({}, entry, {
    blocked: true,
    blockedCode: String((error && error.code) || 'SYNC_CONFLICT').slice(0, 60),
    blockedMessage: String(message(error, '账本内容和房间状态冲突，请修改后再保存')).slice(0, 120),
    blockedAt: math.stamp()
  }))
}

function roomSnapshotTripId(docId) {
  return `room-${cleanTripId(docId)}`.slice(0, 80)
}

function restoreRoomSnapshot(docId, previous) {
  const trips = localTripEntries().filter((entry) => entry.tripId !== roomSnapshotTripId(docId) && entry.sourceRoomDocId !== docId)
  return storage.setScoped(LOCAL_LEDGER_TRIPS_KEY, { trips: previous ? [previous].concat(trips) : trips })
}

function saveRoomSnapshot(docId, roomName, ledger, force) {
  const tripId = roomSnapshotTripId(docId)
  const previous = localTripEntries()
  const existing = previous.find((entry) => entry.tripId === tripId || entry.sourceRoomDocId === docId)
  const others = previous.filter((entry) => entry.tripId !== tripId && entry.sourceRoomDocId !== docId)
  if (!isLedger(ledger) || (!force && !ledger.expenses.length) || (force && !hasLocalTripContent(ledger))) {
    // Do not erase an older recovery copy before leave/disband is confirmed.
    // A response timeout is ambiguous: the server may already have acted.
    return ''
  }
  const snapshotLedger = Object.assign({}, ledger, {
    name: String(ledger.name || roomName || '').slice(0, 20)
  })
  const saved = storage.setScoped(LOCAL_LEDGER_TRIPS_KEY, {
    trips: [{
      tripId,
      sourceRoomDocId: docId,
      createdAt: Number(existing && existing.createdAt) || math.stamp(),
      updatedAt: math.stamp(),
      ledger: snapshotLedger
    }].concat(others)
  })
  return saved ? tripId : null
}

function validMembershipEpoch(value) {
  return /^[A-Za-z0-9_-]{16,80}$/.test(String(value || ''))
}

function savedPendingCreateId() {
  const pending = storage.getScoped(PENDING_CREATE_KEY, null)
  return pending && /^[A-Za-z0-9_-]{16,100}$/.test(String(pending.requestId || ''))
    ? pending.requestId
    : ''
}

function ledgerFingerprint(ledger) {
  return JSON.stringify(ledger || {})
}

Page({
  data: {
    name: '',
    code: '',
    room: null,
    ledger: { members: [], expenses: [] },
    step: 1,
    tripName: '',
    memberName: '',
    desc: '',
    amount: '',
    payerIndex: 0,
    splitIds: [],
    editingId: '',
    memberNamesArray: [],
    memberNames: '',
    settlements: [],
    settlementExact: true,
    settlementVerifyText: '',
    settlementUpdated: false,
    balanceRows: [],
    totalYuan: '0.00',
    syncText: '已同步',
    syncPending: false,
    isOwner: false,
    busy: false,
    headerTopPx: 72
  },

  async onLoad(options) {
    this.docId = (options && options.docId) || ''
    this.tripId = cleanTripId(options && options.tripId) || newTripId()
    this.formDirty = false
    this.viewer = null
    this.initialRoomApplied = false
    this.scopeReady = false
    this.setData({ headerTopPx: layout.headerTopPx() })
    if (!await this.ensureAccountScope()) return
    this.pendingCreateId = savedPendingCreateId()
    this.setData({ name: storage.getName() })
    if (this.docId) {
      this.startPolling()
    } else {
      const saved = localLedgerForTrip(this.tripId)
      const ledger = isLedger(saved) ? saved : emptyLocalLedger()
      this.applyStandaloneLedger(ledger, false)
      this.resetExpenseForm(ledger)
      this.setData({ step: saved ? 2 : 1 })
    }
  },

  onShow() {
    if (this.docId && this.scopeReady) {
      this.flushLedgerOutbox(false)
      this.startPolling()
    }
  },

  onHide() {
    this.stopPolling()
  },

  onUnload() {
    this.stopPolling()
    this.clearSettlementNotice()
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
      this.setData({ syncText: '账号身份未就绪' })
      wx.showToast({ title: '账号身份未就绪，请返回首页后重试', icon: 'none' })
      return false
    }
  },

  onShareAppMessage() {
    const room = this.data.room
    if (!room) return { title: '共享账本', path: '/pages/home/index' }
    return {
      title: `邀请你加入${room.name}`,
      path: `/pages/home/index?code=${room.code}`
    }
  },

  startPolling() {
    this.stopPolling()
    this.flushLedgerOutbox(false)
    this.fetchRoom()
    this.timer = setInterval(() => this.fetchRoom(), 2000)
  },

  stopPolling() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  },

  nameInput(event) {
    this.setData({ name: event.detail.value })
  },

  codeInput(event) {
    this.setData({ code: cleanCode(event.detail.value) })
  },

  memberInput(event) {
    this.setData({ memberName: String(event.detail.value || '').slice(0, 12) })
  },

  tripNameInput(event) {
    this.setData({ tripName: String(event.detail.value || '').slice(0, 20) })
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) })
  },

  goStep(event) {
    const next = Number(event.currentTarget.dataset.step)
    if (![1, 2, 3].includes(next) || next === this.data.step) return
    if (next > 1 && this.data.ledger.members.length < 2) {
      wx.showToast({ title: '先添加至少 2 位同行人', icon: 'none' })
      this.setData({ step: 1 })
      return
    }
    if (next === 3 && !this.data.ledger.expenses.length) {
      wx.showToast({ title: '还没有任何支出，先去加一笔', icon: 'none' })
      this.setData({ step: 2, settlementUpdated: false })
      return
    }
    if (next === 3) this.clearSettlementNotice()
    this.setData({ step: next, settlementUpdated: next === 3 ? false : this.data.settlementUpdated })
  },

  nextStep() {
    const step = Math.min(3, this.data.step + 1)
    this.goStep({ currentTarget: { dataset: { step } } })
  },

  previousStep() {
    this.setData({ step: Math.max(1, this.data.step - 1) })
  },

  finishTrip() {
    wx.switchTab({
      url: '/pages/trips/index',
      fail: () => wx.showToast({ title: '暂时无法返回行程列表', icon: 'none' })
    })
  },

  descInput(event) {
    this.formDirty = true
    this.setData({ desc: String(event.detail.value || '').slice(0, 20) })
  },

  amountInput(event) {
    this.formDirty = true
    this.setData({ amount: event.detail.value })
  },

  payerChange(event) {
    this.formDirty = true
    this.setData({ payerIndex: Number(event.detail.value) || 0 })
  },

  splitChange(event) {
    this.formDirty = true
    this.setData({ splitIds: event.detail.value || [] })
  },

  selectPayer(event) {
    if (this.data.busy) return
    const payerIndex = Number(event.currentTarget.dataset.index)
    if (!Number.isInteger(payerIndex) || !this.data.ledger.members[payerIndex]) return
    this.formDirty = true
    this.setData({
      payerIndex,
      ledger: Object.assign({}, this.data.ledger, {
        members: this.data.ledger.members.map((member, index) => Object.assign({}, member, {
          payerSelected: index === payerIndex
        }))
      })
    })
  },

  toggleSplit(event) {
    if (this.data.busy) return
    const id = String(event.currentTarget.dataset.id || '')
    if (!id) return
    const selected = this.data.splitIds.map(String)
    const splitIds = selected.includes(id) ? selected.filter((item) => item !== id) : selected.concat(id)
    this.formDirty = true
    this.setData({
      splitIds,
      ledger: Object.assign({}, this.data.ledger, {
        members: this.data.ledger.members.map((member) => Object.assign({}, member, {
          checked: splitIds.includes(String(member.id))
        }))
      })
    })
  },

  async create() {
    if (this.data.busy) return
    if (!await this.ensureAccountScope()) return
    const name = this.data.name.trim()
    if (!name) {
      wx.showToast({ title: '先填写名字', icon: 'none' })
      return
    }

    this.pendingCreateId = this.pendingCreateId || requestId()
    if (!storage.setScoped(PENDING_CREATE_KEY, { requestId: this.pendingCreateId })) {
      wx.showToast({ title: '无法保存创建进度，请清理本机空间后重试', icon: 'none' })
      return
    }
    this.setData({ busy: true, syncText: '创建中' })
    try {
      const result = await gateway.create(roomInput(name), this.pendingCreateId)
      this.pendingCreateId = ''
      if (!storage.removeScoped(PENDING_CREATE_KEY)) storage.setScoped(PENDING_CREATE_KEY, null)
      storage.saveName(name)
      this.docId = result.docId
      storage.save({ docId: result.docId, room: result.room })
      this.applyRoom(result.room, result.viewer, false)
      this.resetExpenseForm(result.room.ledger)
      this.initialRoomApplied = true
      this.lastRemoteLedgerFingerprint = ledgerFingerprint(result.room.ledger)
      this.setData({ step: 1, syncText: '已同步', syncPending: false })
      this.startPolling()
    } catch (error) {
      this.setData({ syncText: '创建失败' })
      wx.showToast({ title: message(error, '创建失败，请重试'), icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  async join() {
    if (this.data.busy) return
    if (!await this.ensureAccountScope()) return
    const name = this.data.name.trim()
    const code = cleanCode(this.data.code)
    if (!name || code.length !== 8) {
      wx.showToast({ title: '请填写名字和 8 位房间码', icon: 'none' })
      return
    }

    this.setData({ busy: true, syncText: '加入中' })
    try {
      const result = await gateway.join(code, 'ledger', name)
      storage.saveName(name)
      this.docId = result.docId
      storage.save({ docId: result.docId, room: result.room })
      this.applyRoom(result.room, result.viewer, false)
      this.resetExpenseForm(result.room.ledger)
      this.initialRoomApplied = true
      this.lastRemoteLedgerFingerprint = ledgerFingerprint(result.room.ledger)
      this.setData({ step: 2, syncText: '已同步', syncPending: false })
      this.startPolling()
    } catch (error) {
      this.setData({ syncText: '加入失败' })
      wx.showToast({ title: message(error, '加入失败，请重试'), icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  async fetchRoom() {
    if (!this.scopeReady || !this.docId || this.fetchBusy || this.data.busy) return
    this.fetchBusy = true
    try {
      const result = await gateway.getRoom(this.docId)
      this.lastFetchError = false
      if (!result.room) {
        const removedId = this.docId
        const pending = ledgerOutboxEntry(removedId)
        const snapshotLedger = (pending && pending.ledger) || this.data.ledger
        const snapshotId = saveRoomSnapshot(removedId, this.data.room && this.data.room.name, snapshotLedger, Boolean(pending))
        if (snapshotId === null) {
          this.setData({ syncText: '本机保存失败' })
          wx.showToast({ title: '无法保存账本快照，请清理本机空间后重试', icon: 'none' })
          return
        }
        clearLedgerOutboxEntry(removedId)
        this.docId = ''
        this.stopPolling()
        storage.remove(removedId)
        this.viewer = null
        this.setData({ room: null, syncText: '房间已结束', syncPending: false })
        wx.showToast({ title: snapshotId ? '房间已结束，已有支出已保留到本机' : '房间已解散或你已退出', icon: 'none' })
        wx.switchTab({ url: '/pages/trips/index' })
        return
      }
      storage.save({ docId: this.docId, room: result.room })
      const nextFingerprint = ledgerFingerprint(result.room.ledger)
      const remoteUpdated = Boolean(this.lastRemoteLedgerFingerprint && this.lastRemoteLedgerFingerprint !== nextFingerprint)
      this.lastRemoteLedgerFingerprint = nextFingerprint
      this.applyRoom(result.room, result.viewer, true, remoteUpdated)
      if (!this.initialRoomApplied) {
        this.initialRoomApplied = true
        this.setData({ step: 2 })
      }
      await this.flushLedgerOutbox(false)
      if (!ledgerOutboxEntry(this.docId)) this.setData({ syncText: '已同步', syncPending: false })
    } catch (error) {
      const pending = ledgerOutboxEntry(this.docId)
      this.setData({
        syncText: pending ? '等待同步' : '同步重试中',
        syncPending: Boolean(pending)
      })
      if (!this.lastFetchError) wx.showToast({ title: message(error, '同步暂时中断'), icon: 'none' })
      this.lastFetchError = true
    } finally {
      this.fetchBusy = false
    }
  },

  rememberViewer(viewer) {
    if (!viewer || !viewer.uid) return this.viewer || null
    this.viewer = viewer
    return viewer
  },

  viewerUid() {
    return (this.viewer && this.viewer.uid) || (this.docId ? '' : 'local-device')
  },

  viewerMembershipEpoch() {
    return (this.viewer && this.viewer.membershipEpoch) || ''
  },

  defaultPayerIndex(members) {
    const viewer = this.viewer || {}
    const index = (members || []).findIndex((member) => (
      (viewer.uid && member.uid === viewer.uid) ||
      (viewer.memberId && String(member.id) === String(viewer.memberId))
    ))
    return index >= 0 ? index : 0
  },

  applyLedger(source, preserveForm, room, viewer) {
    const members = source.members || []
    const currentPayerId = this.data.ledger.members[this.data.payerIndex] && this.data.ledger.members[this.data.payerIndex].id
    const shouldKeepForm = Boolean(preserveForm && (this.formDirty || this.data.editingId))
    const activeViewer = room ? this.rememberViewer(viewer) : null

    let payerIndex = shouldKeepForm
      ? members.findIndex((member) => String(member.id) === String(currentPayerId))
      : this.defaultPayerIndex(members)
    if (payerIndex < 0) payerIndex = this.defaultPayerIndex(members)
    const validSplitIds = this.data.splitIds.filter((id) => members.some((member) => String(member.id) === String(id)))
    const checkedIds = shouldKeepForm ? validSplitIds : members.map((member) => String(member.id))
    const decorated = Object.assign({}, source, {
      members: members.map((member) => Object.assign({}, member, {
        checked: checkedIds.map(String).includes(String(member.id)),
        payerSelected: String(member.id) === String(members[payerIndex] && members[payerIndex].id),
        initial: String(member.name || '?').slice(0, 1)
      })),
      expenses: (source.expenses || []).map((expense) => Object.assign({}, expense, {
        amountYuan: (Number(expense.amountCents || 0) / 100).toFixed(2),
        payerName: (members.find((member) => String(member.id) === String(expense.payerId)) || {}).name || '未知',
        payerInitial: String(((members.find((member) => String(member.id) === String(expense.payerId)) || {}).name || '?')).slice(0, 1),
        splitNames: (expense.splitIds || []).map((id) => {
          const member = members.find((item) => String(item.id) === String(id))
          return member ? member.name : '未知'
        }).join('、')
      }))
    })
    const settlementPlan = math.settlementPlan(source)
    const patch = {
      room: room || null,
      ledger: decorated,
      tripName: source.name || '',
      memberNamesArray: members.map((member) => member.name),
      memberNames: members.map((member) => member.name).join('、'),
      settlements: settlementPlan.rows.map((row, index) => Object.assign(row, {
        key: `${row.from}-${row.to}-${index}`,
        yuan: (row.cents / 100).toFixed(2)
      })),
      settlementExact: settlementPlan.exact,
      settlementVerifyText: `${settlementPlan.exact ? '已找到最少' : '已生成'} ${settlementPlan.rows.length} 笔转账，转完大家就都两清了`,
      balanceRows: math.balances(source).map((row) => ({
        id: row.id,
        name: row.name,
        initial: String(row.name || '?').slice(0, 1),
        status: row.cents > 0 ? '应收' : row.cents < 0 ? '应付' : '已结清',
        yuan: (Math.abs(row.cents) / 100).toFixed(2),
        tone: row.cents > 0 ? 'positive' : row.cents < 0 ? 'negative' : 'neutral'
      })),
      totalYuan: (math.totalCents(source) / 100).toFixed(2),
      isOwner: Boolean(activeViewer && activeViewer.isOwner),
      syncText: room ? this.data.syncText : '本机保存'
    }
    if (shouldKeepForm) {
      patch.payerIndex = payerIndex
      patch.splitIds = validSplitIds
    } else {
      patch.payerIndex = payerIndex
      patch.splitIds = checkedIds
    }
    this.setData(patch)
  },

  applyRoom(room, viewer, preserveForm, fromRemote) {
    const epoch = viewer && viewer.membershipEpoch
    let pending = this.docId ? ledgerOutboxEntry(this.docId) : null
    if (pending && (!validMembershipEpoch(epoch) || pending.membershipEpoch !== epoch)) {
      const snapshotId = saveRoomSnapshot(this.docId, room && room.name, pending.ledger, true)
      if (snapshotId === null) {
        blockLedgerOutboxEntry(this.docId, pending.mutationId, {
          code: 'STALE_MEMBERSHIP',
          message: '成员身份已更新，旧修改仍保留在待恢复区'
        })
        this.setData({ syncPending: false, syncText: '恢复副本保存失败' })
        return
      }
      clearLedgerOutboxEntry(this.docId, pending.mutationId)
      pending = null
      this.setData({ syncPending: false, syncText: snapshotId ? '旧修改已保留到本地行程' : '成员身份已更新' })
      if (!this.staleOutboxNotified) {
        this.staleOutboxNotified = true
        wx.showToast({ title: snapshotId ? '成员身份已更新，旧修改已保留到本地行程' : '成员身份已更新', icon: 'none' })
      }
    }
    const source = (pending && pending.ledger) || room.ledger || { members: [], expenses: [], memberTombstones: {}, expenseTombstones: {} }
    // A remote delete must win over a stale edit form. Saving a missing item
    // would otherwise silently recreate an expense another member deleted.
    if (fromRemote && this.data.editingId && !(source.expenses || []).some((expense) => String(expense.id) === String(this.data.editingId))) {
      this.resetExpenseForm(source)
      wx.showToast({ title: '这笔支出已被其他成员删除，已退出编辑', icon: 'none' })
    }
    const visibleRoom = Object.assign({}, room, { ledger: source })
    this.applyLedger(source, preserveForm, visibleRoom, viewer)
    if (pending) this.setData({
      syncPending: !pending.blocked,
      syncText: pending.blocked ? '同步冲突，待修改' : '等待同步'
    })
    if (!fromRemote || this.data.step !== 3) return
    if (!source.expenses.length) {
      this.clearSettlementNotice()
      this.setData({ step: 2, settlementUpdated: false })
      wx.showToast({ title: '账本已没有支出，请先添加一笔', icon: 'none' })
      return
    }
    this.showSettlementNotice()
  },

  clearSettlementNotice() {
    if (this.settlementNoticeTimer) clearTimeout(this.settlementNoticeTimer)
    this.settlementNoticeTimer = null
  },

  showSettlementNotice() {
    this.clearSettlementNotice()
    this.setData({ settlementUpdated: true })
    this.settlementNoticeTimer = setTimeout(() => this.setData({ settlementUpdated: false }), 3500)
  },

  applyStandaloneLedger(ledger, preserveForm) {
    this.applyLedger(ledger, preserveForm, null, null)
  },

  resetExpenseForm(ledger) {
    const members = (ledger && ledger.members) || []
    const payerIndex = this.defaultPayerIndex(members)
    this.formDirty = false
    this.setData({
      desc: '',
      amount: '',
      editingId: '',
      payerIndex,
      splitIds: members.map((member) => String(member.id)),
      ledger: Object.assign({}, this.data.ledger, {
        members: this.data.ledger.members.map((member, index) => Object.assign({}, member, {
          checked: true,
          payerSelected: index === payerIndex
        }))
      })
    })
  },

  writeSharedLedger(next) {
    return gateway.syncLedger(this.docId, next, this.viewerMembershipEpoch())
  },

  flushLedgerOutbox(notifyFailure) {
    if (this.outboxFlushPromise) return this.outboxFlushPromise
    if (!this.scopeReady || !this.docId) return Promise.resolve(false)
    const entry = ledgerOutboxEntry(this.docId)
    if (!entry) return Promise.resolve(true)
    if (entry.blocked) {
      this.setData({ syncPending: false, syncText: '同步冲突，待修改' })
      return Promise.resolve(false)
    }
    const membershipEpoch = this.viewerMembershipEpoch()
    if (!validMembershipEpoch(membershipEpoch)) return Promise.resolve(false)
    if (entry.membershipEpoch !== membershipEpoch) {
      clearLedgerOutboxEntry(this.docId, entry.mutationId)
      this.setData({ syncPending: false, syncText: '成员身份已更新' })
      return Promise.resolve(false)
    }

    const docId = this.docId
    const task = Promise.resolve()
      .then(() => this.writeSharedLedger(entry.ledger))
      .then((result) => {
        if (!result || !isLedger(result.ledger)) throw new Error('服务器没有返回有效账本')
        if (!clearLedgerOutboxEntry(docId, entry.mutationId)) return false
        if (this.docId !== docId) return true
        const room = Object.assign({}, this.data.room, { ledger: result.ledger })
        this.lastRemoteLedgerFingerprint = ledgerFingerprint(result.ledger)
        storage.save({ docId, room })
        this.applyRoom(room, this.viewer, true)
        this.setData({ syncText: '已同步', syncPending: false })
        this.lastOutboxNoticeMutationId = ''
        return true
      })
      .catch((error) => {
        if (['STALE_MEMBERSHIP', 'ROOM_NOT_FOUND'].includes(error && error.code)) {
          const snapshotId = saveRoomSnapshot(
            docId,
            this.data.room && this.data.room.name,
            entry.ledger,
            true
          )
          if (snapshotId === null) {
            if (this.docId === docId) this.setData({ syncPending: true, syncText: '本机保存失败' })
            wx.showToast({ title: '待同步账本的恢复副本保存失败，请勿关闭页面', icon: 'none' })
            return false
          }
          clearLedgerOutboxEntry(docId, entry.mutationId)
          if (this.docId === docId) {
            this.setData({
              syncPending: false,
              syncText: snapshotId ? '旧修改已保留到本地行程' : (error.code === 'STALE_MEMBERSHIP' ? '成员身份已更新' : '房间已结束')
            })
            setTimeout(() => this.fetchRoom(), 0)
          }
          wx.showToast({ title: snapshotId ? '未同步修改已保留到本地行程' : (error.message || '待同步修改已失效'), icon: 'none' })
          return false
        }
        if (isNonRetryableLedgerError(error)) {
          blockLedgerOutboxEntry(docId, entry.mutationId, error)
          if (this.docId === docId) this.setData({ syncText: '同步冲突，待修改', syncPending: false })
          if (this.lastOutboxNoticeMutationId !== entry.mutationId) {
            this.lastOutboxNoticeMutationId = entry.mutationId
            wx.showToast({ title: '未同步的账本已保留，请修改后重新保存', icon: 'none' })
          }
          return false
        }
        if (this.docId === docId) this.setData({ syncText: '等待同步', syncPending: true })
        if (notifyFailure && this.lastOutboxNoticeMutationId !== entry.mutationId) {
          this.lastOutboxNoticeMutationId = entry.mutationId
          wx.showToast({ title: '已保存在本机，联网后会自动同步', icon: 'none' })
        }
        return false
      })
      .finally(() => {
        if (this.outboxFlushPromise === task) this.outboxFlushPromise = null
      })
    this.outboxFlushPromise = task
    return task
  },

  async syncLedger(next) {
    if (!await this.ensureAccountScope()) throw new Error('账号身份未就绪')
    if (!this.docId) {
      if (!saveLocalLedger(this.tripId, next)) {
        wx.showToast({ title: '本机存储空间不足，修改未保存', icon: 'none' })
        throw new Error('无法保存本地账本')
      }
      this.applyStandaloneLedger(next, true)
      this.setData({ syncText: '本机保存' })
      return next
    }
    const membershipEpoch = this.viewerMembershipEpoch()
    if (!validMembershipEpoch(membershipEpoch)) throw new Error('成员身份正在同步，请稍后重试')
    const entry = {
      mutationId: requestId(),
      membershipEpoch,
      queuedAt: math.stamp(),
      roomName: String((this.data.room && this.data.room.name) || next.name || '').slice(0, 20),
      ledger: next
    }
    if (!saveLedgerOutboxEntry(this.docId, entry)) {
      wx.showToast({ title: '本机存储空间不足，修改未保存', icon: 'none' })
      throw new Error('无法保存待同步账本')
    }
    const room = Object.assign({}, this.data.room, { ledger: next })
    this.applyRoom(room, this.viewer, true)
    this.setData({ syncText: '等待同步', syncPending: true })
    await this.flushLedgerOutbox(true)
    const pending = ledgerOutboxEntry(this.docId)
    return pending ? pending.ledger : this.data.ledger
  },

  async saveTripName(event) {
    if (this.data.busy) return
    const name = String((event && event.detail && event.detail.value) || this.data.tripName || '').trim().slice(0, 20)
    if (name === String(this.data.ledger.name || '')) return
    const now = math.stamp()
    const next = Object.assign({}, this.data.ledger, {
      name,
      nameUpdatedAt: now,
      updatedAt: now,
      updatedBy: this.viewerUid(),
      revision: now
    })
    this.setData({ busy: true, tripName: name })
    try { await this.syncLedger(next) } finally { this.setData({ busy: false }) }
  },

  async addMember() {
    if (this.data.busy) return
    const name = this.data.memberName.trim().slice(0, 12)
    if (!name) {
      wx.showToast({ title: '请填写成员名字', icon: 'none' })
      return
    }
    if (this.data.ledger.members.some((member) => member.name === name)) {
      wx.showToast({ title: '这个成员已经在账本里', icon: 'none' })
      return
    }
    if (!this.viewerUid()) {
      wx.showToast({ title: '成员身份正在同步，请稍后重试', icon: 'none' })
      return
    }
    const ledger = this.data.ledger
    const now = math.stamp()
    const id = `member-${now}-${Math.random().toString(36).slice(2)}`
    const next = Object.assign({}, ledger, {
      members: ledger.members.concat({ id, name, color: '#B8842A', createdAt: now, updatedAt: now, updatedBy: this.viewerUid() }),
      nextMemberId: (ledger.nextMemberId || 1) + 1,
      updatedAt: now,
      updatedBy: this.viewerUid(),
      revision: now
    })
    this.setData({ busy: true })
    try {
      await this.syncLedger(next)
      this.setData({ memberName: '' })
    } finally {
      this.setData({ busy: false })
    }
  },

  renameMember(event) {
    if (this.data.busy) return
    const id = String(event.currentTarget.dataset.id || '')
    const member = this.data.ledger.members.find((item) => String(item.id) === id)
    if (!member) return
    if (this.docId && member.uid) {
      wx.showToast({ title: '房间成员不能在账本中改名', icon: 'none' })
      return
    }
    wx.showModal({
      title: '修改成员名称', editable: true, placeholderText: '成员名称', content: member.name,
      success: async (result) => {
        if (!result.confirm) return
        const name = String(result.content || '').trim()
        if (!name || name.length > 12) {
          wx.showToast({ title: '请输入 1 至 12 个字符的名称', icon: 'none' })
          return
        }
        if (this.data.ledger.members.some((item) => String(item.id) !== id && item.name === name)) {
          wx.showToast({ title: '这个成员名称已存在', icon: 'none' })
          return
        }
        const now = math.stamp()
        const next = Object.assign({}, this.data.ledger, {
          members: this.data.ledger.members.map((item) => String(item.id) === id
            ? Object.assign({}, item, { name, updatedAt: now, updatedBy: this.viewerUid() }) : item),
          updatedAt: now, updatedBy: this.viewerUid(), revision: now
        })
        this.setData({ busy: true })
        try { await this.syncLedger(next) } finally { this.setData({ busy: false }) }
      }
    })
  },

  async removeMember(event) {
    if (this.data.busy) return
    const id = String(event.currentTarget.dataset.id || '')
    const member = this.data.ledger.members.find((item) => String(item.id) === id)
    if (!member) return
    if (this.docId && member.uid) {
      wx.showToast({ title: '真实房间成员不能在账本中移除', icon: 'none' })
      return
    }
    if (this.data.ledger.expenses.some((expense) => String(expense.payerId) === id || (expense.splitIds || []).map(String).includes(id))) {
      wx.showToast({ title: '该成员仍被支出引用，请先修改或删除相关支出', icon: 'none' })
      return
    }
    const result = await new Promise((resolve) => wx.showModal({
      title: '移除成员？', content: this.docId ? `将移除“${member.name}”，此操作会同步到所有成员。` : `将从本机账本移除“${member.name}”。`,
      success: resolve, fail: () => resolve({ confirm: false })
    }))
    if (!result.confirm) return
    const now = math.stamp()
    const next = Object.assign({}, this.data.ledger, {
      members: this.data.ledger.members.filter((item) => String(item.id) !== id),
      memberTombstones: Object.assign({}, this.data.ledger.memberTombstones || {}, {
        [id]: { deletedAt: now, deletedBy: this.viewerUid() }
      }),
      updatedAt: now, updatedBy: this.viewerUid(), revision: now
    })
    this.setData({ busy: true })
    try { await this.syncLedger(next) } finally { this.setData({ busy: false }) }
  },

  async saveExpense() {
    if (this.data.busy) return
    const ledger = this.data.ledger
    const cents = Math.round(Number(this.data.amount) * 100)
    const splitIds = this.data.splitIds
    const payer = ledger.members[this.data.payerIndex]
    if (!this.viewerUid()) {
      wx.showToast({ title: '成员身份正在同步，请稍后重试', icon: 'none' })
      return
    }
    const desc = this.data.desc.trim().slice(0, 20)
    if (!desc || !Number.isSafeInteger(cents) || cents <= 0 || cents > 1000000000000 || !payer || !splitIds.length) {
      wx.showToast({ title: '填写支出、金额、付款人和分摊人', icon: 'none' })
      return
    }
    const now = math.stamp()
    const editingId = this.data.editingId
    const editing = ledger.expenses.find((expense) => String(expense.id) === String(editingId))
    if (editingId && !editing) {
      this.resetExpenseForm(ledger)
      wx.showToast({ title: '这笔支出已被其他成员删除，请重新添加', icon: 'none' })
      return
    }
    const expense = {
      id: editing ? editing.id : `expense-${now}-${Math.random().toString(36).slice(2)}`,
      desc,
      amountCents: cents,
      payerId: payer.id,
      splitIds,
      createdAt: editing ? editing.createdAt : now,
      updatedAt: now,
      updatedBy: this.viewerUid()
    }
    const next = Object.assign({}, ledger, {
      expenses: ledger.expenses.filter((item) => String(item.id) !== String(expense.id)).concat(expense),
      nextExpenseId: editing ? (ledger.nextExpenseId || 1) : (ledger.nextExpenseId || 1) + 1,
      updatedAt: now,
      updatedBy: this.viewerUid(),
      revision: now
    })
    this.setData({ busy: true })
    try {
      const savedLedger = await this.syncLedger(next)
      this.resetExpenseForm(savedLedger)
    } finally {
      this.setData({ busy: false })
    }
  },

  editExpense(event) {
    if (this.data.busy) return
    const expense = this.data.ledger.expenses.find((item) => String(item.id) === String(event.currentTarget.dataset.id))
    if (!expense) return
    const payerIndex = this.data.ledger.members.findIndex((member) => String(member.id) === String(expense.payerId))
    this.formDirty = true
    this.setData({
      editingId: expense.id,
      desc: expense.desc,
      amount: (expense.amountCents / 100).toFixed(2),
      payerIndex: payerIndex < 0 ? 0 : payerIndex,
      splitIds: (expense.splitIds || []).map(String),
      ledger: Object.assign({}, this.data.ledger, {
        members: this.data.ledger.members.map((member, index) => Object.assign({}, member, {
          checked: (expense.splitIds || []).map(String).includes(String(member.id)),
          payerSelected: index === (payerIndex < 0 ? 0 : payerIndex)
        }))
      })
    })
    this.setData({ step: 2 })
  },

  cancelEdit() {
    if (this.data.busy) return
    this.formDirty = false
    if (this.data.room) {
      this.applyRoom(this.data.room, this.viewer, false)
      this.resetExpenseForm(this.data.room.ledger)
    } else {
      this.applyStandaloneLedger(this.data.ledger, false)
      this.resetExpenseForm(this.data.ledger)
    }
  },

  deleteExpense(event) {
    if (this.data.busy) return
    const id = event.currentTarget.dataset.id
    wx.showModal({
      title: '删除这笔支出？',
      content: this.docId ? '删除后会同步给所有成员。' : '删除后会从本机账本移除。',
      success: async (result) => {
        if (!result.confirm || this.data.busy) return
        const ledger = this.data.ledger
        const now = math.stamp()
        const expenseTombstones = Object.assign({}, ledger.expenseTombstones || {}, {
          [id]: { deletedAt: now, deletedBy: this.viewerUid() }
        })
        const next = Object.assign({}, ledger, {
          expenses: ledger.expenses.filter((expense) => String(expense.id) !== String(id)),
          expenseTombstones,
          updatedAt: now,
          updatedBy: this.viewerUid(),
          revision: now
        })
        this.setData({ busy: true })
        try {
          await this.syncLedger(next)
          if (String(this.data.editingId) === String(id)) this.resetExpenseForm(this.data.ledger)
        } finally {
          this.setData({ busy: false })
        }
      }
    })
  },

  copyCode() {
    if (!this.data.room) return
    wx.setClipboardData({
      data: this.data.room.code,
      fail: () => wx.showToast({ title: '复制失败，请手动记下房间码', icon: 'none' })
    })
  },

  exitRoom() {
    const room = this.data.room
    if (!room || this.data.busy) return
    const isOwner = this.data.isOwner
    const action = isOwner ? 'disband' : 'leave'
    const hasExpenses = Boolean(this.data.ledger.expenses && this.data.ledger.expenses.length)
    wx.showModal({
      title: isOwner ? '解散这个房间？' : '退出这个房间？',
      content: `${isOwner ? '解散后所有成员都无法再进入。' : '退出后可凭房间码重新加入。'}${hasExpenses ? ' 已有支出会保留为本机历史行程。' : ''}`,
      success: async (result) => {
        if (!result.confirm || this.data.busy) return
        this.setData({ busy: true, syncText: isOwner ? '解散中' : '退出中' })
        const docId = this.docId
        const pending = ledgerOutboxEntry(docId)
        const snapshotLedger = pending && pending.membershipEpoch === this.viewerMembershipEpoch()
          ? pending.ledger
          : this.data.ledger
        let snapshotId = ''
        try {
          snapshotId = saveRoomSnapshot(docId, room.name, snapshotLedger, Boolean(pending))
          if (snapshotId === null) throw new Error('无法保存账本快照，请清理本机空间后重试')
          await gateway[action](docId)
          clearLedgerOutboxEntry(docId)
          storage.remove(docId)
          this.viewer = null
          this.stopPolling()
          this.docId = ''
          wx.switchTab({ url: '/pages/trips/index' })
        } catch (error) {
          // A timeout may still mean leave/disband completed. Keep the latest
          // snapshot instead of replacing it with an older recovery copy.
          this.setData({ syncText: '操作失败' })
          wx.showToast({ title: message(error, '操作失败，请重试'), icon: 'none' })
        } finally {
          this.setData({ busy: false })
        }
      }
    })
  }
})

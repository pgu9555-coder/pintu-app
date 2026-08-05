const gateway = require('../../services/roomGateway')
const storage = require('../../utils/storage')
const math = require('../../utils/ledger')
const layout = require('../../utils/layout')
const LOCAL_LEDGER_KEY = 'pintu-local-ledger-v3'

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
    balanceRows: [],
    totalYuan: '0.00',
    syncText: '已同步',
    isOwner: false,
    busy: false,
    headerTopPx: 72
  },

  onLoad(options) {
    this.docId = (options && options.docId) || ''
    this.formDirty = false
    this.viewer = null
    this.setData({ name: storage.getName(), headerTopPx: layout.headerTopPx() })
    if (this.docId) {
      this.fetchRoom()
    } else {
      const saved = wx.getStorageSync(LOCAL_LEDGER_KEY)
      const ledger = saved && Array.isArray(saved.members) && Array.isArray(saved.expenses) ? saved : emptyLocalLedger()
      this.applyStandaloneLedger(ledger, false)
      this.resetExpenseForm(ledger)
    }
  },

  onShow() {
    if (this.docId) this.startPolling()
  },

  onHide() {
    this.stopPolling()
  },

  onUnload() {
    this.stopPolling()
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
    this.setData({ memberName: event.detail.value })
  },

  tripNameInput(event) {
    this.setData({ tripName: event.detail.value })
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
    this.setData({ step: next })
  },

  nextStep() {
    const step = Math.min(3, this.data.step + 1)
    this.goStep({ currentTarget: { dataset: { step } } })
  },

  previousStep() {
    this.setData({ step: Math.max(1, this.data.step - 1) })
  },

  descInput(event) {
    this.formDirty = true
    this.setData({ desc: event.detail.value })
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
    const name = this.data.name.trim()
    if (!name) {
      wx.showToast({ title: '先填写名字', icon: 'none' })
      return
    }

    this.pendingCreateId = this.pendingCreateId || requestId()
    this.setData({ busy: true, syncText: '创建中' })
    try {
      const result = await gateway.create(roomInput(name), this.pendingCreateId)
      this.pendingCreateId = ''
      storage.saveName(name)
      this.docId = result.docId
      storage.save({ docId: result.docId, room: result.room })
      this.applyRoom(result.room, result.viewer, false)
      this.resetExpenseForm(result.room.ledger)
      this.setData({ syncText: '已同步' })
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
      this.setData({ syncText: '已同步' })
      this.startPolling()
    } catch (error) {
      this.setData({ syncText: '加入失败' })
      wx.showToast({ title: message(error, '加入失败，请重试'), icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  async fetchRoom() {
    if (!this.docId || this.fetchBusy || this.data.busy) return
    this.fetchBusy = true
    try {
      const result = await gateway.getRoom(this.docId)
      this.lastFetchError = false
      if (!result.room) {
        const removedId = this.docId
        this.docId = ''
        this.stopPolling()
        storage.remove(removedId)
        this.viewer = null
        this.setData({ room: null, syncText: '房间已结束' })
        wx.showToast({ title: '房间已解散或你已退出', icon: 'none' })
        return
      }
      storage.save({ docId: this.docId, room: result.room })
      this.applyRoom(result.room, result.viewer, true)
      this.setData({ syncText: '已同步' })
    } catch (error) {
      this.setData({ syncText: '同步重试中' })
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

  applyLedger(source, preserveForm, room, viewer) {
    const members = source.members || []
    const currentPayerId = this.data.ledger.members[this.data.payerIndex] && this.data.ledger.members[this.data.payerIndex].id
    const shouldKeepForm = Boolean(preserveForm && (this.formDirty || this.data.editingId))
    const activeViewer = room ? this.rememberViewer(viewer) : null

    let payerIndex = members.findIndex((member) => String(member.id) === String(currentPayerId))
    if (payerIndex < 0) payerIndex = 0
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
    const patch = {
      room: room || null,
      ledger: decorated,
      tripName: source.name || '',
      memberNamesArray: members.map((member) => member.name),
      memberNames: members.map((member) => member.name).join('、'),
      settlements: math.settlements(source).map((row, index) => Object.assign(row, {
        key: `${row.from}-${row.to}-${index}`,
        yuan: (row.cents / 100).toFixed(2)
      })),
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
      patch.payerIndex = members.length ? 0 : 0
      patch.splitIds = checkedIds
    }
    this.setData(patch)
  },

  applyRoom(room, viewer, preserveForm) {
    const source = room.ledger || { members: [], expenses: [], memberTombstones: {}, expenseTombstones: {} }
    this.applyLedger(source, preserveForm, room, viewer)
  },

  applyStandaloneLedger(ledger, preserveForm) {
    this.applyLedger(ledger, preserveForm, null, null)
  },

  resetExpenseForm(ledger) {
    const members = (ledger && ledger.members) || []
    this.formDirty = false
    this.setData({
      desc: '',
      amount: '',
      editingId: '',
      payerIndex: 0,
      splitIds: members.map((member) => String(member.id)),
      ledger: Object.assign({}, this.data.ledger, {
        members: this.data.ledger.members.map((member, index) => Object.assign({}, member, {
          checked: true,
          payerSelected: index === 0
        }))
      })
    })
  },

  async syncLedger(next) {
    if (!this.docId) {
      wx.setStorageSync(LOCAL_LEDGER_KEY, next)
      this.applyStandaloneLedger(next, true)
      this.setData({ syncText: '本机保存' })
      return next
    }
    this.setData({ syncText: '同步中' })
    try {
      const result = await gateway.syncLedger(this.docId, next, this.viewerMembershipEpoch())
      const room = Object.assign({}, this.data.room, { ledger: result.ledger })
      storage.save({ docId: this.docId, room })
      this.applyRoom(room, this.viewer, true)
      this.setData({ syncText: '已同步' })
      return result.ledger
    } catch (error) {
      this.setData({ syncText: '同步失败' })
      wx.showToast({ title: message(error, '保存失败，请重试'), icon: 'none' })
      throw error
    }
  },

  async saveTripName(event) {
    if (this.data.busy) return
    const name = String((event && event.detail && event.detail.value) || this.data.tripName || '').trim().slice(0, 80)
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
    const name = this.data.memberName.trim()
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
    if (member.uid) {
      wx.showToast({ title: '房间成员不能在账本中改名', icon: 'none' })
      return
    }
    wx.showModal({
      title: '修改成员名称', editable: true, placeholderText: '成员名称', content: member.name,
      success: async (result) => {
        if (!result.confirm) return
        const name = String(result.content || '').trim()
        if (!name || name.length > 24) {
          wx.showToast({ title: '请输入 1 至 24 个字符的名称', icon: 'none' })
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
    if (member.uid) {
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
    if (!this.data.desc.trim() || !Number.isSafeInteger(cents) || cents <= 0 || cents > 1000000000000 || !payer || !splitIds.length) {
      wx.showToast({ title: '填写支出、金额、付款人和分摊人', icon: 'none' })
      return
    }
    const now = math.stamp()
    const editing = ledger.expenses.find((expense) => String(expense.id) === String(this.data.editingId))
    const expense = {
      id: editing ? editing.id : `expense-${now}-${Math.random().toString(36).slice(2)}`,
      desc: this.data.desc.trim(),
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
    wx.showModal({
      title: isOwner ? '解散这个房间？' : '退出这个房间？',
      content: isOwner ? '解散后所有成员都无法再进入。' : '退出后可凭房间码重新加入。',
      success: async (result) => {
        if (!result.confirm || this.data.busy) return
        this.setData({ busy: true, syncText: isOwner ? '解散中' : '退出中' })
        try {
          await gateway[action](this.docId)
          storage.remove(this.docId)
          this.viewer = null
          this.stopPolling()
          this.docId = ''
          wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) })
        } catch (error) {
          this.setData({ syncText: '操作失败' })
          wx.showToast({ title: message(error, '操作失败，请重试'), icon: 'none' })
        } finally {
          this.setData({ busy: false })
        }
      }
    })
  }
})

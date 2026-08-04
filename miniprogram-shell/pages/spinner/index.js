const STORAGE_KEY = 'pintu-spinner-v2'

Page({
  data: {
    names: [],
    newName: '',
    decision: '谁来决定',
    result: '',
    spinning: false
  },

  onLoad() {
    const saved = wx.getStorageSync(STORAGE_KEY) || {}
    this.setData({
      names: Array.isArray(saved.names) ? saved.names.slice(0, 50) : [],
      decision: typeof saved.decision === 'string' ? saved.decision : '谁来决定'
    })
  },

  onUnload() {
    if (this.spinTimer) clearTimeout(this.spinTimer)
  },

  persist() {
    wx.setStorageSync(STORAGE_KEY, {
      names: this.data.names,
      decision: this.data.decision
    })
  },

  nameInput(event) {
    this.setData({ newName: event.detail.value })
  },

  decisionInput(event) {
    if (this.data.spinning) return
    this.setData({ decision: event.detail.value })
    this.persist()
  },

  add() {
    if (this.data.spinning) return
    const name = this.data.newName.trim().slice(0, 24)
    if (!name) return
    if (this.data.names.includes(name)) {
      wx.showToast({ title: '这个名字已经在转盘里', icon: 'none' })
      return
    }
    if (this.data.names.length >= 50) {
      wx.showToast({ title: '最多添加 50 人', icon: 'none' })
      return
    }
    this.setData({ names: this.data.names.concat(name), newName: '' })
    this.persist()
  },

  remove(event) {
    if (this.data.spinning) return
    const names = this.data.names.slice()
    names.splice(Number(event.currentTarget.dataset.index), 1)
    this.setData({ names, result: '' })
    this.persist()
  },

  spin() {
    if (this.data.spinning) return
    if (!this.data.names.length) {
      wx.showToast({ title: '请先添加参与者', icon: 'none' })
      return
    }
    const candidates = this.data.names.slice()
    const decision = this.data.decision.trim() || '决定事项'
    this.setData({ spinning: true, result: '' })
    this.spinTimer = setTimeout(() => {
      const name = candidates[Math.floor(Math.random() * candidates.length)]
      this.setData({
        spinning: false,
        result: `${decision}：${name}`
      })
      this.spinTimer = null
    }, 2000)
  }
})

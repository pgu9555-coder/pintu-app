const STORAGE_KEY = 'pintu-spinner-v3'
const layout = require('../../utils/layout')
const DEFAULT_NAMES = ['我', '朋友A', '朋友B']
const COLORS = ['#7E958E', '#D8B878', '#91AFBF', '#C96F54', '#A8506E', '#9DA9A5']

Page({
  data: {
    names: DEFAULT_NAMES,
    newName: '',
    decision: '谁买单',
    result: '',
    spinning: false,
    wheelRotation: 0,
    spinDuration: 0,
    headerTopPx: 72
  },

  onLoad() {
    const saved = wx.getStorageSync(STORAGE_KEY) || {}
    const names = Array.isArray(saved.names) && saved.names.length ? saved.names.slice(0, 8) : DEFAULT_NAMES
    this.rotation = 0
    this.setData({
      names,
      headerTopPx: layout.headerTopPx(),
      decision: typeof saved.decision === 'string' && saved.decision.trim() ? saved.decision.slice(0, 10) : '谁买单'
    })
  },

  onReady() {
    this.drawWheel()
  },

  onUnload() {
    if (this.spinTimer) clearTimeout(this.spinTimer)
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) })
  },

  persist() {
    wx.setStorageSync(STORAGE_KEY, { names: this.data.names, decision: this.data.decision })
  },

  nameInput(event) { this.setData({ newName: event.detail.value }) },

  decisionInput(event) {
    if (this.data.spinning) return
    this.setData({ decision: event.detail.value.slice(0, 10), result: '' })
    this.persist()
  },

  add() {
    if (this.data.spinning) return
    const name = this.data.newName.trim().slice(0, 8)
    if (!name) return
    if (this.data.names.includes(name)) {
      wx.showToast({ title: '这个名字已经在转盘里', icon: 'none' })
      return
    }
    if (this.data.names.length >= 8) {
      wx.showToast({ title: '最多添加 8 人', icon: 'none' })
      return
    }
    this.setData({ names: this.data.names.concat(name), newName: '', result: '' }, () => this.drawWheel())
    this.persist()
  },

  remove(event) {
    if (this.data.spinning) return
    const names = this.data.names.slice()
    names.splice(Number(event.currentTarget.dataset.index), 1)
    this.setData({ names, result: '' }, () => this.drawWheel())
    this.persist()
  },

  drawWheel() {
    const names = this.data.names
    const ctx = wx.createCanvasContext('spinnerCanvas', this)
    const size = 280
    const radius = 136
    const center = size / 2
    ctx.clearRect(0, 0, size, size)
    if (!names.length) {
      ctx.setFillStyle('#DCE7EC')
      ctx.beginPath()
      ctx.arc(center, center, radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.draw()
      return
    }
    const arc = Math.PI * 2 / names.length
    names.forEach((name, index) => {
      const start = -Math.PI / 2 + index * arc
      const end = start + arc
      ctx.beginPath()
      ctx.moveTo(center, center)
      ctx.arc(center, center, radius, start, end)
      ctx.closePath()
      ctx.setFillStyle(COLORS[index % COLORS.length])
      ctx.fill()

      ctx.save()
      ctx.translate(center, center)
      ctx.rotate(start + arc / 2)
      ctx.setFillStyle('#FFFDF6')
      ctx.setFontSize(names.length > 12 ? 10 : names.length > 8 ? 12 : 14)
      ctx.setTextAlign('right')
      ctx.setTextBaseline('middle')
      const label = name.length > 6 ? `${name.slice(0, 6)}…` : name
      ctx.fillText(label, radius - 16, 0)
      ctx.restore()
    })
    ctx.setStrokeStyle('#FFFDF6')
    ctx.setLineWidth(2)
    ctx.beginPath()
    ctx.arc(center, center, radius, 0, Math.PI * 2)
    ctx.stroke()
    ctx.draw()
  },

  spin() {
    if (this.data.spinning) return
    const names = this.data.names
    if (!names.length) {
      wx.showToast({ title: '请先添加参与者', icon: 'none' })
      return
    }
    const winnerIndex = Math.floor(Math.random() * names.length)
    const segment = 360 / names.length
    const target = (360 - ((winnerIndex + 0.5) * segment % 360)) % 360
    const current = ((this.rotation % 360) + 360) % 360
    const delta = (target - current + 360) % 360
    const duration = 3000
    this.rotation += 5 * 360 + delta
    this.setData({ spinning: true, result: '', spinDuration: duration, wheelRotation: this.rotation })
    this.spinTimer = setTimeout(() => {
      const decision = this.data.decision.trim() || '谁买单'
      const name = names[winnerIndex]
      const result = /^谁/.test(decision) ? `${name} ${decision.replace(/^谁/, '') || '来决定'}！` : `${name}：${decision}！`
      this.setData({ spinning: false, result })
      this.spinTimer = null
    }, duration + 80)
  }
})

const layout = require('../../utils/layout')

const DEFAULT_NAMES = []
// Keep this in the same order as the web spinner so a person's list colour
// always agrees with their wheel segment.
const COLORS = ['#0F3D36', '#B8842A', '#3E6E8E', '#A8506E', '#C05B3C', '#4C5C5B', '#6B8E7A', '#C99A3C']
const SPIN_MIN_DURATION = 4300
const SPIN_DURATION_VARIANCE = 450

Page({
  data: {
    names: DEFAULT_NAMES,
    newName: '',
    decision: '谁买单',
    result: '',
    resultMode: 'idle',
    spinning: false,
    spinButtonText: '转',
    wheelRotation: 0,
    spinDuration: 0,
    motionReduced: false,
    headerTopPx: 72,
    canvasSize: 280
  },

  onLoad() {
    const system = this.getSystemInfo()
    this.rotation = 0
    this.spinSequence = 0
    // The web spinner is intentionally local to the current visit. Do not
    // restore the old fixed storage key: it could expose another account's list.
    this.statusTickMs = Number(system.benchmarkLevel) > 0 && Number(system.benchmarkLevel) <= 5 ? 140 : 90
    const windowWidth = Number(system.windowWidth) || 375
    // Legacy WeChat canvas drawing coordinates use CSS pixels. Matching the
    // actual 560rpx viewport size avoids iOS clipping while the compositor
    // handles rotation; multiplying by DPR breaks the legacy canvas context.
    const wheelCssPx = windowWidth * 560 / 750
    const canvasSize = Math.max(1, Math.round(wheelCssPx))
    this.setData({
      names: DEFAULT_NAMES.slice(),
      decision: '谁买单',
      headerTopPx: layout.headerTopPx(),
      motionReduced: Boolean(system.prefersReducedMotion || system.reduceMotion || system.reducedMotion),
      canvasSize
    })
    this.readMotionPreference()
  },

  onReady() {
    this.drawWheel()
  },

  onUnload() {
    this.spinSequence += 1
    this.clearSpinTimers()
  },

  getSystemInfo() {
    try {
      return wx.getSystemInfoSync() || {}
    } catch (error) {
      return {}
    }
  },

  readMotionPreference() {
    if (typeof wx.getSystemSetting !== 'function') return
    wx.getSystemSetting({
      success: (settings) => {
        if (settings && (settings.prefersReducedMotion || settings.reduceMotion || settings.reducedMotion || settings.screenReaderEnabled)) {
          this.setData({ motionReduced: true })
        }
      }
    })
  },

  clearSpinTimers() {
    if (this.spinStartTimer) clearTimeout(this.spinStartTimer)
    if (this.spinFinishTimer) clearTimeout(this.spinFinishTimer)
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.spinStartTimer = null
    this.spinFinishTimer = null
    this.statusTimer = null
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) })
  },

  nameInput(event) {
    this.setData({ newName: event.detail.value })
  },

  decisionInput(event) {
    if (this.data.spinning) return
    this.setData({ decision: event.detail.value.slice(0, 10), result: '', resultMode: 'idle' })
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
    this.setData({ names: this.data.names.concat(name), newName: '', result: '', resultMode: 'idle' }, () => this.drawWheel())
  },

  remove(event) {
    if (this.data.spinning) return
    const index = Number(event.currentTarget.dataset.index)
    const names = this.data.names.slice()
    if (!Number.isInteger(index) || index < 0 || index >= names.length) return
    names.splice(index, 1)
    this.setData({ names, result: '', resultMode: 'idle' }, () => this.drawWheel())
  },

  drawWheel() {
    const names = this.data.names
    const ctx = wx.createCanvasContext('spinnerCanvas', this)
    const size = Number(this.data.canvasSize) || 280
    const scale = size / 280
    const radius = size / 2 - 4 * scale
    const center = size / 2
    ctx.clearRect(0, 0, size, size)

    if (!names.length) {
      ctx.setFillStyle('#EDE8DA')
      ctx.beginPath()
      ctx.arc(center, center, radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.setFillStyle('#8B928D')
      ctx.setFontSize(14 * scale)
      ctx.setTextAlign('center')
      ctx.setTextBaseline('middle')
      ctx.fillText('先加人', center, center)
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
      ctx.setFontSize((names.length > 6 ? 12 : 14) * scale)
      ctx.setTextAlign('right')
      ctx.setTextBaseline('middle')
      ctx.fillText(name.length > 6 ? `${name.slice(0, 6)}…` : name, radius - 16 * scale, 0)
      ctx.restore()
    })

    ctx.beginPath()
    ctx.arc(center, center, 23 * scale, 0, Math.PI * 2)
    ctx.setFillStyle('rgba(255,255,255,0.14)')
    ctx.fill()
    ctx.setStrokeStyle('#FFFDF6')
    ctx.setLineWidth(2 * scale)
    ctx.beginPath()
    ctx.arc(center, center, radius, 0, Math.PI * 2)
    ctx.stroke()
    ctx.draw()
  },

  spin() {
    if (this.data.spinning) return
    const names = this.data.names.slice()
    if (names.length < 2) {
      wx.showToast({ title: '至少要有 2 个人才能转哦', icon: 'none' })
      return
    }

    const winnerIndex = Math.floor(Math.random() * names.length)
    const segment = 360 / names.length
    const targetMod = (360 - ((winnerIndex + 0.5) * segment % 360)) % 360
    const currentMod = ((this.rotation % 360) + 360) % 360
    const delta = (targetMod - currentMod + 360) % 360
    const turns = 5 + Math.floor(Math.random() * 2)
    const startAngle = this.rotation
    const targetAngle = this.rotation + turns * 360 + delta
    const duration = this.data.motionReduced ? 240 : SPIN_MIN_DURATION + Math.floor(Math.random() * SPIN_DURATION_VARIANCE)
    const sequence = ++this.spinSequence
    const decision = this.data.decision.trim() || '谁买单'
    const plan = { sequence, names, winnerIndex, segment, startAngle, targetAngle, duration, decision }

    this.clearSpinTimers()
    this.setData({
      spinning: true,
      result: `正在掠过：${names[0]}`,
      resultMode: 'running',
      spinButtonText: '转动中',
      // Establish the starting position with transitions disabled before
      // setting the target. This avoids a jump after the second spin.
      spinDuration: 0,
      wheelRotation: startAngle
    })

    this.spinStartTimer = setTimeout(() => this.startSpin(plan), 30)
  },

  startSpin(plan) {
    if (plan.sequence !== this.spinSequence || !this.data.spinning) return
    this.rotation = plan.targetAngle
    this.setData({ spinDuration: plan.duration, wheelRotation: plan.targetAngle })
    this.startStatusTicker(plan)
    this.spinFinishTimer = setTimeout(() => this.finishSpin(plan), plan.duration + 40)
  },

  startStatusTicker(plan) {
    const startedAt = Date.now()
    let lastIndex = -1
    const updateStatus = () => {
      if (plan.sequence !== this.spinSequence || !this.data.spinning) return
      const progress = Math.min(1, (Date.now() - startedAt) / plan.duration)
      // Match the web's fast-start, slow-stop feel. The CSS transition moves
      // the wheel on the compositor; this low-frequency update only changes text.
      const eased = 1 - Math.pow(1 - progress, 5)
      const angle = plan.startAngle + (plan.targetAngle - plan.startAngle) * eased
      const pointerOnWheel = ((360 - (angle % 360)) + 360) % 360
      const index = Math.floor(pointerOnWheel / plan.segment) % plan.names.length
      if (index !== lastIndex || progress >= 0.7) {
        lastIndex = index
        this.setData({ result: `${progress < 0.7 ? '正在掠过：' : '慢慢停下… '}${plan.names[index]}` })
      }
    }
    updateStatus()
    this.statusTimer = setInterval(updateStatus, this.statusTickMs)
  },

  finishSpin(plan) {
    if (plan.sequence !== this.spinSequence || !this.data.spinning) return
    this.clearSpinTimers()
    const name = plan.names[plan.winnerIndex]
    const result = /^谁/.test(plan.decision)
      ? `🎉 ${name} ${plan.decision.replace(/^谁/, '') || '来决定'}！`
      : `🎉 ${name}：${plan.decision}！`
    this.setData({
      spinning: false,
      result,
      resultMode: 'final',
      spinButtonText: '再转',
      spinDuration: 0,
      wheelRotation: plan.targetAngle
    })
  }
})

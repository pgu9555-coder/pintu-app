const gateway = require('../../services/roomGateway')
const storage = require('../../utils/storage')

function cleanCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, '')
    .slice(0, 8)
}

Page({
  data: {
    name: '',
    code: '',
    busy: false
  },

  onLoad(options) {
    this.setData({ code: cleanCode(options && options.code) })
  },

  onShow() {
    this.setData({ name: storage.getName() })
  },

  nameInput(event) {
    this.setData({ name: event.detail.value })
  },

  codeInput(event) {
    this.setData({ code: cleanCode(event.detail.value) })
  },

  openMidpoint() {
    this.rememberName()
    wx.navigateTo({ url: '/pages/midpoint/index' })
  },

  openLedger() {
    this.rememberName()
    wx.navigateTo({ url: '/pages/ledger/index' })
  },

  openSpinner() {
    wx.navigateTo({ url: '/pages/spinner/index' })
  },

  openTrips() {
    wx.switchTab({ url: '/pages/trips/index' })
  },

  rememberName() {
    const name = this.data.name.trim()
    if (name) storage.saveName(name)
  },

  openPrivacy() {
    if (!wx.openPrivacyContract) {
      wx.showToast({ title: '请在微信中查看小程序隐私保护指引', icon: 'none' })
      return
    }
    wx.openPrivacyContract({
      fail: () => wx.showToast({ title: '暂时无法打开隐私保护指引', icon: 'none' })
    })
  },

  async join() {
    if (this.data.busy) return
    const name = this.data.name.trim()
    const code = cleanCode(this.data.code)
    if (!name || code.length !== 8) {
      wx.showToast({ title: '请填写名字和 8 位房间码', icon: 'none' })
      return
    }

    this.setData({ busy: true })
    wx.showLoading({ title: '加入中' })
    try {
      const result = await gateway.join(code, 'auto', name)
      storage.saveName(name)
      storage.save({ docId: result.docId, room: result.room })
      await new Promise((resolve, reject) => {
        wx.navigateTo({
          url: `/pages/${result.room.toolType}/index?docId=${result.docId}`,
          success: resolve,
          fail: reject
        })
      })
    } catch (error) {
      wx.showToast({ title: error.message || '加入失败，请稍后重试', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  }
})

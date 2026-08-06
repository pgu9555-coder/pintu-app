const gateway = require('./services/roomGateway')
const storage = require('./utils/storage')

App({
  globalData: {
    accountProfile: null,
    accountPromise: null
  },

  onLaunch() {
    if (!wx.cloud) { console.warn('当前基础库不支持云开发'); return }
    wx.cloud.init({ env: 'pintu-d4g77ecn24b674fa0', traceUser: true })
  },

  resetAccountScope() {
    storage.clearAccountScope()
    this.globalData.accountProfile = null
    this.globalData.accountPromise = null
  },

  // Keep the trusted profile returned by CloudBase in one place. Pages that
  // have just saved a profile use this too, so room pages do not retain an
  // out-of-date avatar or nickname in memory.
  applyAccountProfile(profile) {
    const nextProfile = Object.assign({}, this.globalData.accountProfile || {}, profile || {})
    if (!storage.setAccountScope(nextProfile)) {
      throw new Error('微信账号识别凭据无效，请重新打开小程序')
    }
    this.globalData.accountProfile = nextProfile
    this.globalData.accountPromise = null
    return nextProfile
  },

  ensureAccountScope() {
    if (storage.isAccountScoped() && this.globalData.accountProfile) {
      return Promise.resolve(this.globalData.accountProfile)
    }
    if (this.globalData.accountPromise) return this.globalData.accountPromise

    this.globalData.accountPromise = gateway.getProfile()
      .then((profile) => this.applyAccountProfile(profile))
      .catch((error) => {
        storage.clearAccountScope()
        this.globalData.accountProfile = null
        this.globalData.accountPromise = null
        throw error
      })
    return this.globalData.accountPromise
  }
})

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

  ensureAccountScope() {
    if (storage.isAccountScoped() && this.globalData.accountProfile) {
      return Promise.resolve(this.globalData.accountProfile)
    }
    if (this.globalData.accountPromise) return this.globalData.accountPromise

    this.globalData.accountPromise = gateway.getProfile()
      .then((profile) => {
        if (!storage.setAccountScope(profile)) {
          throw new Error('微信账号识别凭据无效，请重新打开小程序')
        }
        this.globalData.accountProfile = profile
        this.globalData.accountPromise = null
        return profile
      })
      .catch((error) => {
        storage.clearAccountScope()
        this.globalData.accountProfile = null
        this.globalData.accountPromise = null
        throw error
      })
    return this.globalData.accountPromise
  }
})

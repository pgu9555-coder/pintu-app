const gateway = require('./services/roomGateway')
const storage = require('./utils/storage')
const environment = require('./environment')

App({
  globalData: {
    accountProfile: null,
    accountPromise: null,
    accountConsentGranted: false
  },

  onLaunch() {
    if (!wx.cloud) { console.warn('当前基础库不支持云开发'); return }
    // CloudBase is initialized at launch so guest pages can call cloud
    // functions later, but launch itself must not enable user tracing. The
    // trusted OpenID scope is established only after the user explicitly
    // chooses a collaborative action and completes the consent flow.
    wx.cloud.init({ env: environment.cloudbaseEnvId, traceUser: false })
  },

  resetAccountScope() {
    storage.clearAccountScope()
    this.globalData.accountProfile = null
    this.globalData.accountPromise = null
    this.globalData.accountConsentGranted = false
  },

  grantAccountConsent() {
    this.globalData.accountConsentGranted = true
  },

  hasAccountConsent() {
    return this.globalData.accountConsentGranted === true
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
    if (!this.hasAccountConsent()) {
      return Promise.reject(new Error('请先阅读协议并主动登录'))
    }
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

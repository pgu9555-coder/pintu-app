const gateway = require('./services/roomGateway')
const storage = require('./utils/storage')
const environment = require('./environment')

App({
  globalData: {
    accountProfile: null,
    accountPromise: null,
    accountConsentGranted: false,
    accountGeneration: 0
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
    this.globalData.accountGeneration = (this.globalData.accountGeneration || 0) + 1
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

  accountGenerationToken() {
    return this.globalData.accountGeneration || 0
  },

  // Keep the trusted profile returned by CloudBase in one place. Pages that
  // have just saved a profile use this too, so room pages do not retain an
  // out-of-date avatar or nickname in memory.
  applyAccountProfile(profile) {
    const previousScope = storage.localScopeToken()
    const nextProfile = Object.assign({}, this.globalData.accountProfile || {}, profile || {})
    if (!storage.setAccountScope(nextProfile)) {
      throw new Error('微信账号识别凭据无效，请重新打开小程序')
    }
    this.globalData.accountProfile = nextProfile
    if (previousScope !== storage.localScopeToken()) this.globalData.accountGeneration = this.accountGenerationToken() + 1
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

    const generation = this.accountGenerationToken()
    const scope = storage.localScopeToken()
    const current = () => generation === this.accountGenerationToken() && scope === storage.localScopeToken() && this.hasAccountConsent()
    const pending = gateway.getProfile()
      .then((profile) => {
        if (!current()) {
          const error = new Error('账号空间已切换，请重新登录')
          error.code = 'ACCOUNT_SCOPE_CHANGED'
          throw error
        }
        return this.applyAccountProfile(profile)
      })
      .catch((error) => {
        if (current()) {
          storage.clearAccountScope()
          this.globalData.accountProfile = null
          this.globalData.accountPromise = null
        }
        throw error
      })
    this.globalData.accountPromise = pending
    return pending
  }
})

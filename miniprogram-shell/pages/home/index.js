const gateway = require('../../services/roomGateway')
const storage = require('../../utils/storage')
const invite = require('../../utils/invite')

function cleanCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, '')
    .slice(0, 8)
}

function joinMessage(error) {
  const code = String(error && error.code || '')
  const raw = String(error && error.message || '')
  const byCode = {
    ROOM_NOT_FOUND: '邀请已失效，或房间已被解散',
    ROOM_LEGACY_UNSUPPORTED: '这个旧版房间暂不支持从邀请加入',
    WRONG_ROOM_TYPE: '邀请类型与房间不一致，请让房主重新分享',
    ROOM_TYPE_MISMATCH: '邀请类型与房间不一致，请让房主重新分享',
    ROOM_FULL: '房间人数已满',
    ROOM_HISTORY_FULL: '房间历史成员已达上限',
    LEDGER_HISTORY_FULL: '账本历史成员已达上限',
    DUPLICATE_NAME: '这个名字已被使用，请换一个名字',
    NAME_REQUIRED: '请填写你的名字',
    UNAUTHENTICATED: '请先完成登录后再加入'
  }
  return byCode[code] || raw || '加入失败，请稍后重试'
}

async function deleteUnsavedAvatarUpload(fileID) {
  if (!fileID || !wx.cloud || typeof wx.cloud.deleteFile !== 'function') {
    return { deleted: false, error: '未保存的新头像文件需要稍后由系统清理' }
  }
  try {
    const response = await wx.cloud.deleteFile({ fileList: [fileID] })
    const fileList = Array.isArray(response && response.fileList) ? response.fileList : []
    const deleted = fileList.some((item) => item && item.fileID === fileID && (item.code === 'SUCCESS' || item.status === 0))
    return deleted
      ? { deleted: true, error: '' }
      : { deleted: false, error: '未保存的新头像文件尚未清理' }
  } catch (error) {
    return { deleted: false, error: error && error.message ? error.message : '未保存的新头像文件尚未清理' }
  }
}

function cleanupPendingCount(result) {
  const cleanup = result && result.avatarCleanup
  return Math.max(0, Number(cleanup && cleanup.pendingCount) || Number(result && result.avatarCleanupPendingCount) || 0)
}

function cleanupNeedsManualAttention(result) {
  return Boolean(result && result.avatarCleanup && result.avatarCleanup.status === 'unmanaged')
}

function isAmbiguousProfileUpdateError(error) {
  const code = String(error && error.code || '')
  const message = String(error && (error.diagnostic || error.message) || '')
  return code === 'NETWORK_ERROR' || /^-?\d+$/.test(code) || /network|timeout|request:fail|socket|连接|超时/i.test(message)
}

function accountOperation(page) {
  const app = typeof getApp === 'function' ? getApp() : null
  return {
    app,
    generation: app && typeof app.accountGenerationToken === 'function' ? app.accountGenerationToken() : 0,
    scope: storage.localScopeToken(),
    pageGeneration: page.accountPageGeneration || 0
  }
}

function accountOperationCurrent(page, operation) {
  const generation = operation.app && typeof operation.app.accountGenerationToken === 'function' ? operation.app.accountGenerationToken() : 0
  return !page.accountPageGone && (page.accountPageGeneration || 0) === operation.pageGeneration &&
    generation === operation.generation && storage.localScopeToken() === operation.scope
}

Page({
  data: {
    name: '',
    code: '',
    inviteType: '',
    inviteLabel: '',
    busy: false,
    joinError: '',
    profileLoaded: false,
    profileError: '',
    profileBusy: false,
    profileExists: false,
    profileNickname: '',
    profileAvatarFileId: '',
    profileAvatarPreview: '',
    pendingAvatarUrl: '',
    profileAvatarCleanupPending: 0,
    avatarUploadPrefix: '',
    canChooseAvatar: false,
    profilePanelOpen: false,
    wechatLoginVisible: false,
    loginPurpose: '',
    wechatLoginBusy: false,
    privacyConsentChecked: false,
    serviceAgreementOpened: false,
    privacyContractOpened: false
  },

  onLoad(options) {
    this.accountPageGone = false
    this.accountPageGeneration = (this.accountPageGeneration || 0) + 1
    this.nameDirty = false
    const incomingInvite = invite.fromOptions(options)
    this.setData({
      code: incomingInvite.code || cleanCode(options && options.code),
      inviteType: incomingInvite.type,
      inviteLabel: incomingInvite.valid ? invite.INVITE_TYPES[incomingInvite.type].label : ''
    })
    // Mini-program storage is shared by every WeChat account that uses this
    // app on the same device. Clear the old room-name default before resolving
    // the current account's trusted cloud profile so another account's
    // nickname is never flashed or reused.
    const app = getApp()
    if (app && typeof app.resetAccountScope === 'function') app.resetAccountScope()
    else storage.clearAccountScope()
    storage.saveName('')
    this.setData({
      canChooseAvatar: Boolean(wx.canIUse && wx.canIUse('button.open-type.chooseAvatar'))
    })
  },

  ensurePrivacyAuthorized() {
    return new Promise((resolve, reject) => {
      if (typeof wx.getPrivacySetting !== 'function') {
        resolve()
        return
      }
      wx.getPrivacySetting({
        success: (setting) => {
          if (!setting || !setting.needAuthorization) {
            resolve()
            return
          }
          if (typeof wx.requirePrivacyAuthorize !== 'function') {
            reject(new Error('当前微信版本无法完成隐私授权，请更新微信后重试'))
            return
          }
          wx.requirePrivacyAuthorize({
            success: resolve,
            fail: () => reject(new Error('需要同意隐私保护指引后才能使用云端房间'))
          })
        },
        fail: () => reject(new Error('暂时无法确认隐私授权，请检查网络后重试'))
      })
    })
  },

  async confirmWechatLogin() {
    if (this.data.wechatLoginBusy) return
    if (!this.data.privacyConsentChecked) {
      wx.showToast({ title: '请先阅读并勾选协议', icon: 'none' })
      return
    }
    const request = this.loginRequest = (this.loginRequest || 0) + 1
    let operation = accountOperation(this)
    this.setData({ wechatLoginBusy: true })
    try {
      // This native privacy authorization happens only after the user selected
      // the agreement checkbox and tapped Continue. It authorizes
      // the declared account/room data processing; location remains separately
      // requested only after the later "从地图选点" action.
      await this.ensurePrivacyAuthorized()
      if (request !== this.loginRequest || !accountOperationCurrent(this, operation)) return
      const app = getApp()
      if (!app || typeof app.grantAccountConsent !== 'function') throw new Error('登录服务暂时不可用')
      app.grantAccountConsent()
      if (app && typeof app.ensureAccountScope === 'function') {
        const profile = await app.ensureAccountScope()
        if (request !== this.loginRequest || this.accountPageGone ||
            (app.globalData && app.globalData.accountProfile !== profile)) return
      }
      operation = accountOperation(this)
      const loaded = await this.loadProfile()
      if (request !== this.loginRequest || !accountOperationCurrent(this, operation)) return
      if (!loaded || this.data.profileError) {
        if (typeof app.resetAccountScope === 'function') app.resetAccountScope()
        operation = accountOperation(this)
        return
      }
      const afterLogin = this.afterWechatLogin
      this.afterWechatLogin = null
      this.setData({ wechatLoginVisible: false, privacyConsentChecked: false })
      if (!loaded.exists || !String(loaded.nickname || '').trim() || !String(loaded.avatarFileId || '').trim()) {
        this.pendingProfileContinuation = afterLogin
        wx.navigateTo({ url: '/pages/profile/index?onboarding=1', fail: () => {
          this.pendingProfileContinuation = afterLogin
          this.setData({ profileRouteError: '资料页未能打开。请重试后再继续。' })
          wx.showToast({ title: '资料页暂时无法打开，请从我的行程编辑资料', icon: 'none' })
        }, success: () => this.setData({ profileRouteError: '' }) })
        return
      }
      if (typeof afterLogin === 'function') afterLogin()
    } catch (error) {
      if (request !== this.loginRequest || !accountOperationCurrent(this, operation)) return
      const app = getApp()
      if (app && typeof app.resetAccountScope === 'function') app.resetAccountScope()
      operation = accountOperation(this)
      wx.showToast({
        title: error && error.message ? error.message : '微信登录暂时失败，请重试',
        icon: 'none'
      })
    } finally {
      if (request === this.loginRequest && accountOperationCurrent(this, operation)) this.setData({ wechatLoginBusy: false })
    }
  },

  requestWechatLogin(afterLogin, purpose, afterCancel) {
    this.loginRequest = (this.loginRequest || 0) + 1
    this.afterWechatLogin = typeof afterLogin === 'function' ? afterLogin : null
    this.afterWechatLoginCancel = typeof afterCancel === 'function' ? afterCancel : null
    this.setData({
      wechatLoginVisible: true,
      loginPurpose: purpose || '多人协作',
      privacyConsentChecked: false,
      serviceAgreementOpened: false,
      privacyContractOpened: false,
      profileError: ''
    })
  },

  cancelWechatLogin() {
    if (this.data.wechatLoginBusy) return
    this.afterWechatLogin = null
    const afterCancel = this.afterWechatLoginCancel
    this.afterWechatLoginCancel = null
    this.setData({
      wechatLoginVisible: false,
      privacyConsentChecked: false,
      serviceAgreementOpened: false,
      privacyContractOpened: false
    })
    if (typeof afterCancel === 'function') afterCancel()
  },

  togglePrivacyConsent() {
    if (this.data.wechatLoginBusy) return
    this.setData({ privacyConsentChecked: !this.data.privacyConsentChecked })
  },

  openServiceAgreement() {
    wx.navigateTo({
      url: '/pages/agreement/index?type=terms',
      success: () => this.setData({ serviceAgreementOpened: true })
    })
  },

  openPrivacyNotice() {
    wx.navigateTo({ url: '/pages/agreement/index?type=privacy' })
  },

  openDataTools() {
    wx.navigateTo({ url: '/pages/data-tools/index' })
  },

  contactDeveloper() {
    wx.showModal({ title: '联系开发者', content: 'pgu9555@gmail.com', confirmText: '复制邮箱', success: (result) => {
      if (result.confirm) wx.setClipboardData({ data: 'pgu9555@gmail.com' })
    } })
  },

  openProfilePanel(afterClose) {
    if (!this.accountReady(false)) {
      this.requestWechatLogin(() => this.openProfilePanel())
      return
    }
    this.profilePanelAfterClose = typeof afterClose === 'function' ? afterClose : null
    if (wx.hideTabBar) wx.hideTabBar({ animation: false, fail() {} })
    this.setData({ profilePanelOpen: true })
  },

  openProfileEditor(fromTrips) {
    wx.navigateTo({ url: `/pages/profile/index${fromTrips ? '?fromTrips=1' : ''}`, fail: () => wx.showToast({ title: '资料页暂时无法打开', icon: 'none' }) })
  },

  retryPendingProfile() {
    if (typeof this.pendingProfileContinuation !== 'function') return
    wx.navigateTo({ url: '/pages/profile/index?onboarding=1', success: () => this.setData({ profileRouteError: '' }), fail: () => this.setData({ profileRouteError: '资料页未能打开。请重试后再继续。' }) })
  },

  closeProfilePanel() {
    const afterClose = this.profilePanelAfterClose
    this.profilePanelAfterClose = null
    if (wx.showTabBar) wx.showTabBar({ animation: false, fail() {} })
    this.setData({ profilePanelOpen: false })
    if (typeof afterClose === 'function') afterClose()
  },

  onUnload() {
    this.accountPageGone = true
    this.accountPageGeneration = (this.accountPageGeneration || 0) + 1
    this.profileLoadRequest = (this.profileLoadRequest || 0) + 1
    this.loginRequest = (this.loginRequest || 0) + 1
    if (wx.showTabBar) wx.showTabBar({ animation: false, fail() {} })
  },

  preventClose() {},

  nameInput(event) {
    this.nameDirty = true
    this.setData({ name: event.detail.value, joinError: '' })
  },

  profileNicknameInput(event) {
    this.setData({ profileNickname: event.detail.value })
  },

  async loadProfile() {
    const request = this.profileLoadRequest = (this.profileLoadRequest || 0) + 1
    const operation = accountOperation(this)
    try {
      const app = getApp()
      if (!app || typeof app.hasAccountConsent !== 'function' || !app.hasAccountConsent()) {
        throw new Error('请先阅读协议并主动登录')
      }
      const profile = app && typeof app.ensureAccountScope === 'function'
        ? await app.ensureAccountScope()
        : await gateway.getProfile()
      if (request !== this.profileLoadRequest || this.accountPageGone ||
          (app.globalData && app.globalData.accountProfile !== profile)) return null
      const targetScope = storage.scopeFromProfile(profile)
      if (targetScope !== storage.localScopeToken() && !accountOperationCurrent(this, operation)) return null
      if (!storage.setAccountScope(profile)) {
        throw new Error('微信账号识别凭据无效，请重新打开小程序')
      }
      this.profileScope = storage.localScopeToken()
      const nickname = profile.nickname || ''
      if (profile.exists && profile.nickname) storage.saveName(profile.nickname)
      const savedName = storage.getName()
      const nextName = this.nameDirty
        ? this.data.name
        : (profile.exists && nickname ? nickname : savedName)
      this.setData({
        profileBusy: false,
        profileLoaded: true,
        profileError: '',
        profileExists: Boolean(profile.exists),
        profileNickname: nickname,
        profileAvatarFileId: profile.avatarFileId || '',
        profileAvatarPreview: profile.avatarFileId || '',
        pendingAvatarUrl: '',
        profileAvatarCleanupPending: Number(profile.avatarCleanupPendingCount) || 0,
        avatarUploadPrefix: profile.avatarUploadPrefix || '',
        name: nextName
      })
      return profile
    } catch (error) {
      if (request !== this.profileLoadRequest || !accountOperationCurrent(this, operation)) return null
      storage.clearAccountScope()
      this.setData({
        profileLoaded: true,
        profileError: error && error.message ? error.message : '微信账号暂时无法识别'
      })
      wx.showToast({ title: '微信账号暂时无法识别', icon: 'none' })
      return null
    }
  },

  accountReady(showMessage = true) {
    const app = getApp()
    if (!app || typeof app.hasAccountConsent !== 'function' || !app.hasAccountConsent()) {
      if (showMessage) wx.showToast({ title: '请先登录微信账号', icon: 'none' })
      return false
    }
    if (!this.data.profileLoaded) {
      if (showMessage) wx.showToast({ title: '请先登录微信账号', icon: 'none' })
      return false
    }
    if (!storage.isAccountScoped()) {
      if (showMessage) wx.showToast({ title: this.data.profileError || '请先登录微信账号', icon: 'none' })
      return false
    }
    if (this.profileScope && this.profileScope !== storage.localScopeToken()) {
      if (showMessage) wx.showToast({ title: '账号空间已切换，请重新登录', icon: 'none' })
      return false
    }
    return true
  },

  async retryProfile() {
    const app = getApp()
    if (app && typeof app.resetAccountScope === 'function') app.resetAccountScope()
    else storage.clearAccountScope()
    this.setData({ profileLoaded: false, profileError: '' })
    this.requestWechatLogin()
  },

  async saveProfile() {
    if (this.data.profileBusy || !this.data.profileLoaded) return
    if (!this.accountReady(false)) return
    const operation = accountOperation(this)
    const nickname = String(this.data.profileNickname || '').trim()
    if (!nickname) {
      wx.showToast({ title: '请填写昵称后保存', icon: 'none' })
      return
    }
    this.setData({ profileBusy: true })
    let uploadedFileId = ''
    let cleanupUploadedOnFailure = true
    try {
      let avatarFileId = this.data.profileAvatarFileId || ''
      const pendingAvatarUrl = this.data.pendingAvatarUrl
      if (pendingAvatarUrl) {
        const avatarUploadPrefix = String(this.data.avatarUploadPrefix || '')
        if (!/^avatars\/profile-[a-f0-9]{64}\/$/.test(avatarUploadPrefix)) {
          throw new Error('头像上传凭据加载失败，请重新打开页面')
        }
        const suffix = String(pendingAvatarUrl).match(/\.[A-Za-z0-9]{1,8}(?:\?.*)?$/)
        const cloudPath = `${avatarUploadPrefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}${suffix ? suffix[0].replace(/\?.*/, '') : '.png'}`
        const upload = await wx.cloud.uploadFile({ cloudPath, filePath: pendingAvatarUrl })
        if (!accountOperationCurrent(this, operation)) return
        uploadedFileId = upload && upload.fileID
        if (!uploadedFileId) throw new Error('头像上传失败，请稍后重试')
        avatarFileId = uploadedFileId
        cleanupUploadedOnFailure = false
      }
      let profile
      try {
        profile = await gateway.updateProfile({ nickname, avatarFileId })
        if (!accountOperationCurrent(this, operation)) return
      } catch (updateError) {
        if (!accountOperationCurrent(this, operation)) return
        if (!isAmbiguousProfileUpdateError(updateError)) {
          cleanupUploadedOnFailure = true
          throw updateError
        }

        let latestProfile = null
        try {
          latestProfile = await gateway.getProfile()
        } catch (_) {}
        if (!accountOperationCurrent(this, operation)) return
        if (
          latestProfile &&
          String(latestProfile.nickname || '') === nickname &&
          String(latestProfile.avatarFileId || '') === String(avatarFileId || '')
        ) {
          // The function committed but its response was lost. Reconcile from
          // the authoritative profile instead of deleting the referenced file.
          profile = latestProfile
        } else if (latestProfile) {
          // The server is reachable and confirms that this upload is unused.
          cleanupUploadedOnFailure = true
          throw updateError
        } else {
          const uncertainError = new Error('资料保存结果暂时无法确认，请稍后重新打开查看')
          uncertainError.code = 'PROFILE_UPDATE_UNCONFIRMED'
          uncertainError.cause = updateError
          throw uncertainError
        }
      }
      // The server has accepted the uploaded FileID at this point. Do not
      // clean it up if a later local UI/cache operation happens to fail.
      uploadedFileId = ''
      const app = getApp()
      if (app && typeof app.applyAccountProfile === 'function') app.applyAccountProfile(profile)
      storage.saveName(profile.nickname)
      this.setData({
        profileExists: Boolean(profile.exists),
        profileNickname: profile.nickname,
        profileAvatarFileId: profile.avatarFileId || '',
        profileAvatarPreview: profile.avatarFileId || '',
        pendingAvatarUrl: '',
        profileAvatarCleanupPending: cleanupPendingCount(profile),
        name: profile.nickname
      })
      this.closeProfilePanel()
      const pendingCount = cleanupPendingCount(profile)
      wx.showToast({
        title: cleanupNeedsManualAttention(profile) ? '资料已保存，旧头像未自动删除' : pendingCount ? '资料已保存，旧头像待清理' : '微信资料已保存',
        icon: cleanupNeedsManualAttention(profile) || pendingCount ? 'none' : 'success'
      })
    } catch (error) {
      if (!accountOperationCurrent(this, operation)) return
      const cleanup = cleanupUploadedOnFailure
        ? await deleteUnsavedAvatarUpload(uploadedFileId)
        : { deleted: false, error: '' }
      if (!accountOperationCurrent(this, operation)) return
      const message = error.message || '资料保存失败，请稍后重试'
      const title = !cleanupUploadedOnFailure && uploadedFileId
        ? `${message}；头像已保留，避免损坏云端资料`
        : (cleanup.deleted || !uploadedFileId ? message : `${message}；新头像待清理`)
      wx.showToast({ title, icon: 'none' })
    } finally {
      if (accountOperationCurrent(this, operation)) this.setData({ profileBusy: false })
    }
  },

  chooseAvatar(event) {
    if (this.data.profileBusy || !this.data.profileLoaded) return
    const avatarUrl = event && event.detail && event.detail.avatarUrl
    if (!avatarUrl) return
    this.setData({ profileAvatarPreview: avatarUrl, pendingAvatarUrl: avatarUrl })
  },

  async removeAvatar() {
    if (this.data.profileBusy || !this.data.profileLoaded) return
    if (!this.accountReady(false)) return
    const operation = accountOperation(this)
    const previousAvatarFileId = this.data.profileAvatarFileId
    if (!previousAvatarFileId && !this.data.pendingAvatarUrl) {
      wx.showToast({ title: '当前没有头像可移除', icon: 'none' })
      return
    }
    if (!previousAvatarFileId) {
      this.setData({ profileAvatarPreview: '', pendingAvatarUrl: '' })
      wx.showToast({ title: '头像已移除', icon: 'success' })
      return
    }
    this.setData({ profileBusy: true })
    try {
      const profile = await gateway.updateProfile({ avatarFileId: '' })
      if (!accountOperationCurrent(this, operation)) return
      const app = getApp()
      if (app && typeof app.applyAccountProfile === 'function') app.applyAccountProfile(profile)
      this.setData({
        profileExists: Boolean(profile.exists),
        profileAvatarFileId: '',
        profileAvatarPreview: '',
        pendingAvatarUrl: '',
        profileAvatarCleanupPending: cleanupPendingCount(profile)
      })
      const pendingCount = cleanupPendingCount(profile)
      wx.showToast({ title: cleanupNeedsManualAttention(profile) ? '头像资料已移除，旧文件未自动删除' : pendingCount ? '头像已移除，文件待清理' : '头像已移除', icon: cleanupNeedsManualAttention(profile) || pendingCount ? 'none' : 'success' })
    } catch (error) {
      if (!accountOperationCurrent(this, operation)) return
      wx.showToast({ title: error.message || '头像移除失败，请稍后重试', icon: 'none' })
    } finally {
      if (accountOperationCurrent(this, operation)) this.setData({ profileBusy: false })
    }
  },

  deleteProfile() {
    if (this.data.profileBusy || !this.data.profileLoaded) return
    if (!this.accountReady(false)) return
    const operation = accountOperation(this)
    wx.showModal({
      title: '删除云端资料？',
      content: '将删除你的昵称和头像资料；已加入的房间不会受影响。',
      confirmText: '删除资料',
      success: async (result) => {
        if (!result.confirm || this.data.profileBusy || !accountOperationCurrent(this, operation)) return
        this.setData({ profileBusy: true })
        try {
          const result = await gateway.deleteProfile()
          if (!accountOperationCurrent(this, operation)) return
          const app = getApp()
          if (app && typeof app.applyAccountProfile === 'function') {
            app.applyAccountProfile({ exists: false, nickname: '', avatarFileId: '' })
          }
          storage.saveName('')
          this.setData({
            name: '',
            profileExists: false,
            profileNickname: '',
            profileAvatarFileId: '',
            profileAvatarPreview: '',
            pendingAvatarUrl: '',
            profileAvatarCleanupPending: cleanupPendingCount(result)
          })
          this.closeProfilePanel()
          const pendingCount = cleanupPendingCount(result)
          wx.showToast({ title: cleanupNeedsManualAttention(result) ? '资料已删除，旧头像未自动删除' : pendingCount ? '资料已删除，头像待清理' : '云端资料已删除', icon: cleanupNeedsManualAttention(result) || pendingCount ? 'none' : 'success' })
        } catch (error) {
          if (!accountOperationCurrent(this, operation)) return
          wx.showToast({ title: error.message || '资料删除失败，请稍后重试', icon: 'none' })
        } finally {
          if (accountOperationCurrent(this, operation)) this.setData({ profileBusy: false })
        }
      }
    })
  },

  async retryAvatarCleanup() {
    if (this.data.profileBusy || !this.data.profileLoaded) return
    if (!this.accountReady(false)) return
    const operation = accountOperation(this)
    this.setData({ profileBusy: true })
    try {
      const result = await gateway.retryAvatarCleanup()
      if (!accountOperationCurrent(this, operation)) return
      const pendingCount = cleanupPendingCount(result)
      this.setData({ profileAvatarCleanupPending: pendingCount })
      wx.showToast({ title: pendingCount ? '头像文件仍待清理，请稍后重试' : '头像文件已清理', icon: pendingCount ? 'none' : 'success' })
    } catch (error) {
      if (!accountOperationCurrent(this, operation)) return
      wx.showToast({ title: error.message || '头像文件暂时无法清理，请稍后重试', icon: 'none' })
    } finally {
      if (accountOperationCurrent(this, operation)) this.setData({ profileBusy: false })
    }
  },

  codeInput(event) {
    this.setData({ code: cleanCode(event.detail.value), inviteType: '', inviteLabel: '', joinError: '' })
  },

  openMidpoint() {
    const app = getApp()
    if (!app || !app.hasAccountConsent || !app.hasAccountConsent() || !storage.isAccountScoped()) {
      this.requestWechatLogin(() => this.openMidpoint(), '公平碰面')
      return
    }
    this.rememberName()
    wx.navigateTo({ url: '/pages/midpoint/index' })
  },

  openLedger() {
    const app = getApp()
    if (!app || !app.hasAccountConsent || !app.hasAccountConsent() || !storage.isAccountScoped()) {
      this.requestWechatLogin(() => this.openLedger(), '行程账本')
      return
    }
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
    const app = getApp()
    const savedProfileName = String(app && app.globalData && app.globalData.accountProfile && app.globalData.accountProfile.nickname || '').trim()
    const name = (savedProfileName || this.data.name).trim()
    if (name) storage.saveName(name)
  },

  openPrivacy() {
    if (!wx.openPrivacyContract) {
      wx.showToast({ title: '请在微信中查看小程序隐私保护指引', icon: 'none' })
      return
    }
    wx.openPrivacyContract({
      success: () => this.setData({ privacyContractOpened: true }),
      fail: () => wx.showToast({ title: '暂时无法打开隐私保护指引', icon: 'none' })
    })
  },

  async join() {
    if (this.data.busy) return
    const code = cleanCode(this.data.code)
    if (code.length !== 8) {
      wx.showToast({ title: '请填写 8 位房间码', icon: 'none' })
      return
    }
    if (!this.accountReady(false)) {
      this.requestWechatLogin(() => this.join())
      return
    }
    const app = getApp()
    const name = String(app && app.globalData && app.globalData.accountProfile && app.globalData.accountProfile.nickname || storage.getName() || this.data.name || '微信用户').trim()
    if (!name) {
      this.setData({ joinError: '请填写你的名字后再加入' })
      wx.showToast({ title: '请填写你的名字', icon: 'none' })
      return
    }

    const operation = accountOperation(this)
    this.setData({ busy: true, joinError: '' })
    wx.showLoading({ title: '加入中' })
    try {
      const requestedType = invite.inviteType(this.data.inviteType) || 'auto'
      const result = await gateway.join(code, requestedType, name)
      if (!accountOperationCurrent(this, operation)) return
      const toolType = invite.inviteType(result && result.room && result.room.toolType)
      const docId = String(result && result.docId || '')
      if (!toolType || !docId) throw new Error('房间返回的数据不完整，请稍后重试')
      storage.saveName(name)
      storage.save({ docId: result.docId, room: result.room })
      await new Promise((resolve, reject) => {
        wx.navigateTo({
          url: `/pages/${toolType}/index?docId=${encodeURIComponent(docId)}`,
          success: resolve,
          fail: reject
        })
      })
    } catch (error) {
      if (!accountOperationCurrent(this, operation)) return
      const message = joinMessage(error)
      console.error('[home join]', error)
      this.setData({ joinError: message })
      wx.showToast({ title: message, icon: 'none' })
    } finally {
      if (accountOperationCurrent(this, operation)) {
        wx.hideLoading()
        this.setData({ busy: false })
      }
    }
  }
})

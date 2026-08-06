const gateway = require('../../services/roomGateway')
const storage = require('../../utils/storage')

function cleanCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, '')
    .slice(0, 8)
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

Page({
  data: {
    name: '',
    code: '',
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
    wechatLoginVisible: true,
    wechatLoginBusy: false,
    wechatProfileConfirming: false,
    headerTopPx: 52
  },

  onLoad(options) {
    this.nameDirty = false
    this.setData({ code: cleanCode(options && options.code) })
    // Mini-program storage is shared by every WeChat account that uses this
    // app on the same device. Clear the old room-name default before resolving
    // the current account's trusted cloud profile so another account's
    // nickname is never flashed or reused.
    const app = getApp()
    if (app && typeof app.resetAccountScope === 'function') app.resetAccountScope()
    else storage.clearAccountScope()
    storage.saveName('')
    const systemInfo = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
    const fallbackHeaderTop = Number(systemInfo.statusBarHeight || 20) + 52
    let headerTopPx = fallbackHeaderTop
    try {
      const menuButton = wx.getMenuButtonBoundingClientRect && wx.getMenuButtonBoundingClientRect()
      if (menuButton && menuButton.bottom) headerTopPx = Number(menuButton.bottom) + 8
    } catch (_) {}
    this.setData({
      canChooseAvatar: Boolean(wx.canIUse && wx.canIUse('button.open-type.chooseAvatar')),
      headerTopPx
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
    this.setData({ wechatLoginBusy: true })
    try {
      await this.ensurePrivacyAuthorized()
      // This tap establishes the CloudBase account scope, but it never asks
      // WeChat to disclose an avatar or nickname automatically.
      const app = getApp()
      if (app && typeof app.ensureAccountScope === 'function') await app.ensureAccountScope()
      const profile = await this.loadProfile()
      if (this.data.profileError) return
      if (profile && profile.exists) {
        // Returning users have already confirmed and saved their profile. The
        // identity explanation still appears at launch, but they are not
        // forced to rewrite the same cloud profile on every visit.
        this.setData({ wechatLoginVisible: false, wechatProfileConfirming: false })
      } else {
        // Keep the blocking overlay in place until a first-time user actively
        // confirms the profile with the official WeChat controls.
        this.setData({ wechatProfileConfirming: true })
      }
    } catch (error) {
      wx.showToast({
        title: error && error.message ? error.message : '微信登录暂时失败，请重试',
        icon: 'none'
      })
    } finally {
      this.setData({ wechatLoginBusy: false })
    }
  },

  openProfilePanel() {
    if (wx.hideTabBar) wx.hideTabBar({ animation: false, fail() {} })
    this.setData({ profilePanelOpen: true })
  },

  closeProfilePanel() {
    if (wx.showTabBar) wx.showTabBar({ animation: false, fail() {} })
    this.setData({ profilePanelOpen: false })
  },

  onUnload() {
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
    try {
      const app = getApp()
      const profile = app && typeof app.ensureAccountScope === 'function'
        ? await app.ensureAccountScope()
        : await gateway.getProfile()
      if (!storage.setAccountScope(profile)) {
        throw new Error('微信账号识别凭据无效，请重新打开小程序')
      }
      const nickname = profile.nickname || ''
      if (profile.exists && profile.nickname) storage.saveName(profile.nickname)
      const savedName = storage.getName()
      const nextName = this.nameDirty
        ? this.data.name
        : (profile.exists && nickname ? nickname : savedName)
      this.setData({
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
      storage.clearAccountScope()
      this.setData({
        profileLoaded: true,
        profileError: error && error.message ? error.message : '微信账号暂时无法识别'
      })
      wx.showToast({ title: '微信账号暂时无法识别', icon: 'none' })
      return null
    }
  },

  accountReady() {
    if (!this.data.profileLoaded) {
      wx.showToast({ title: '正在识别微信账号，请稍候', icon: 'none' })
      return false
    }
    if (!storage.isAccountScoped()) {
      wx.showToast({ title: this.data.profileError || '微信账号暂时无法识别，请重试', icon: 'none' })
      return false
    }
    return true
  },

  async retryProfile() {
    if (!this.data.profileLoaded) return
    const app = getApp()
    if (app && typeof app.resetAccountScope === 'function') app.resetAccountScope()
    else storage.clearAccountScope()
    this.setData({ profileLoaded: false, profileError: '' })
    await this.loadProfile()
  },

  async saveProfile() {
    if (this.data.profileBusy || !this.data.profileLoaded) return
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
        uploadedFileId = upload && upload.fileID
        if (!uploadedFileId) throw new Error('头像上传失败，请稍后重试')
        avatarFileId = uploadedFileId
        cleanupUploadedOnFailure = false
      }
      let profile
      try {
        profile = await gateway.updateProfile({ nickname, avatarFileId })
      } catch (updateError) {
        if (!isAmbiguousProfileUpdateError(updateError)) {
          cleanupUploadedOnFailure = true
          throw updateError
        }

        let latestProfile = null
        try {
          latestProfile = await gateway.getProfile()
        } catch (_) {}
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
      const completesWechatLogin = this.data.wechatProfileConfirming
      this.setData({
        profileExists: Boolean(profile.exists),
        profileNickname: profile.nickname,
        profileAvatarFileId: profile.avatarFileId || '',
        profileAvatarPreview: profile.avatarFileId || '',
        pendingAvatarUrl: '',
        profileAvatarCleanupPending: cleanupPendingCount(profile),
        name: profile.nickname,
        wechatLoginVisible: completesWechatLogin ? false : this.data.wechatLoginVisible,
        wechatProfileConfirming: completesWechatLogin ? false : this.data.wechatProfileConfirming
      })
      if (!completesWechatLogin) this.closeProfilePanel()
      const pendingCount = cleanupPendingCount(profile)
      wx.showToast({
        title: cleanupNeedsManualAttention(profile) ? '资料已保存，旧头像未自动删除' : pendingCount ? '资料已保存，旧头像待清理' : '微信资料已保存',
        icon: cleanupNeedsManualAttention(profile) || pendingCount ? 'none' : 'success'
      })
    } catch (error) {
      const cleanup = cleanupUploadedOnFailure
        ? await deleteUnsavedAvatarUpload(uploadedFileId)
        : { deleted: false, error: '' }
      const message = error.message || '资料保存失败，请稍后重试'
      const title = !cleanupUploadedOnFailure && uploadedFileId
        ? `${message}；头像已保留，避免损坏云端资料`
        : (cleanup.deleted || !uploadedFileId ? message : `${message}；新头像待清理`)
      wx.showToast({ title, icon: 'none' })
    } finally {
      this.setData({ profileBusy: false })
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
      wx.showToast({ title: error.message || '头像移除失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ profileBusy: false })
    }
  },

  deleteProfile() {
    if (this.data.profileBusy || !this.data.profileLoaded) return
    wx.showModal({
      title: '删除云端资料？',
      content: '将删除你的昵称和头像资料；已加入的房间不会受影响。',
      confirmText: '删除资料',
      success: async (result) => {
        if (!result.confirm || this.data.profileBusy) return
        this.setData({ profileBusy: true })
        try {
          const result = await gateway.deleteProfile()
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
          wx.showToast({ title: error.message || '资料删除失败，请稍后重试', icon: 'none' })
        } finally {
          this.setData({ profileBusy: false })
        }
      }
    })
  },

  async retryAvatarCleanup() {
    if (this.data.profileBusy || !this.data.profileLoaded) return
    this.setData({ profileBusy: true })
    try {
      const result = await gateway.retryAvatarCleanup()
      const pendingCount = cleanupPendingCount(result)
      this.setData({ profileAvatarCleanupPending: pendingCount })
      wx.showToast({ title: pendingCount ? '头像文件仍待清理，请稍后重试' : '头像文件已清理', icon: pendingCount ? 'none' : 'success' })
    } catch (error) {
      wx.showToast({ title: error.message || '头像文件暂时无法清理，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ profileBusy: false })
    }
  },

  codeInput(event) {
    this.setData({ code: cleanCode(event.detail.value), joinError: '' })
  },

  openMidpoint() {
    if (!this.accountReady()) return
    this.rememberName()
    wx.navigateTo({ url: '/pages/midpoint/index' })
  },

  openLedger() {
    if (!this.accountReady()) return
    this.rememberName()
    wx.navigateTo({ url: '/pages/ledger/index' })
  },

  openSpinner() {
    wx.navigateTo({ url: '/pages/spinner/index' })
  },

  openTrips() {
    if (!this.accountReady()) return
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
    if (!this.accountReady()) return
    const name = this.data.name.trim()
    const code = cleanCode(this.data.code)
    if (!name || code.length !== 8) {
      wx.showToast({ title: '请填写名字和 8 位房间码', icon: 'none' })
      return
    }

    this.setData({ busy: true, joinError: '' })
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
      const message = error.message || '加入失败，请稍后重试'
      console.error('[home join]', error)
      this.setData({ joinError: message })
      wx.showToast({ title: message, icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  }
})

const gateway = require('../../services/roomGateway')
const storage = require('../../utils/storage')

function operationSnapshot(page) {
  const app = getApp()
  return { app, generation: app.accountGenerationToken(), scope: storage.localScopeToken(), page: page.requestId }
}
function current(page, op) {
  return !page.closed && page.requestId === op.page && page.scope === op.scope && page.generation === op.generation && op.generation === op.app.accountGenerationToken() && op.scope === storage.localScopeToken() && op.app.hasAccountConsent() && storage.isAccountScoped()
}

Page({
  data: { onboarding: false, nickname: '', avatar: '', pendingAvatar: '', uploadPrefix: '', busy: false, canChooseAvatar: false, error: '', moreOpen: false, cleanupPending: 0 },
  onLoad(options) {
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: String(options && options.onboarding) === '1' ? '完善资料' : '编辑资料' })
    this.closed = false
    this.requestId = 1
    const pageStack = getCurrentPages()
    this.openerPage = pageStack[pageStack.length - 1] === this ? pageStack[pageStack.length - 2] : pageStack[pageStack.length - 1]
    const app = getApp()
    if (!app || !app.hasAccountConsent() || !storage.isAccountScoped()) {
      wx.showToast({ title: '请先登录微信账号', icon: 'none' })
      wx.navigateBack({ delta: 1 })
      return
    }
    this.scope = storage.localScopeToken()
    this.generation = app.accountGenerationToken()
    this.fromTrips = String(options && options.fromTrips) === '1'
    const profile = app.globalData.accountProfile || {}
    this.setData({
      onboarding: String(options && options.onboarding) === '1',
      nickname: String(profile.nickname || ''),
      avatar: String(profile.avatarFileId || ''),
      uploadPrefix: String(profile.avatarUploadPrefix || ''),
      cleanupPending: Number(profile.avatarCleanupPendingCount) || 0,
      canChooseAvatar: Boolean(wx.canIUse && wx.canIUse('button.open-type.chooseAvatar'))
    })
    if (String(options && options.onboarding) === '1' && !String(profile.nickname || '').trim()) storage.saveName('微信用户')
  },
  onUnload() {
    this.closed = true
    this.requestId += 1
    if (!this.continueRequested) {
      if (this.openerPage) this.openerPage.pendingProfileContinuation = null
    }
  },
  nicknameInput(event) { this.setData({ nickname: String(event.detail.value || '').slice(0, 24), error: '' }) },
  chooseAvatar(event) {
    if (this.data.busy) return
    const avatar = event && event.detail && event.detail.avatarUrl
    if (avatar) this.setData({ avatar, pendingAvatar: avatar })
  },
  async saveAndContinue() {
    if (this.data.busy) return
    const nickname = String(this.data.nickname || '').trim()
    if (!nickname) { this.setData({ error: '请填写昵称后继续' }); return }
    const op = operationSnapshot(this)
    if (!current(this, op)) { this.setData({ error: '账号空间已变化，请重新打开资料页' }); return }
    this.setData({ busy: true, error: '' })
    let uploaded = ''
    let cleanupUploadedOnFailure = true
    try {
      let avatarFileId = this.data.avatar || ''
      if (this.data.pendingAvatar) {
        if (!/^avatars\/profile-[a-f0-9]{64}\/$/.test(this.data.uploadPrefix)) throw new Error('头像上传凭据无效，请重新打开资料页')
        const file = this.data.pendingAvatar
        const suffix = String(file).match(/\.[A-Za-z0-9]{1,8}(?:\?.*)?$/)
        const cloudPath = `${this.data.uploadPrefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}${suffix ? suffix[0].replace(/\?.*/, '') : '.png'}`
        const response = await wx.cloud.uploadFile({ cloudPath, filePath: file })
        if (!current(this, op)) return
        uploaded = response && response.fileID
        if (!uploaded) throw new Error('头像上传失败，请重试')
        avatarFileId = uploaded
        cleanupUploadedOnFailure = false
      }
      let profile
      try {
        profile = await gateway.updateProfile({ nickname, avatarFileId })
      } catch (updateError) {
        if (!current(this, op)) return
        const code = String(updateError && updateError.code || '')
        const message = String(updateError && (updateError.diagnostic || updateError.message) || '')
        const ambiguous = code === 'NETWORK_ERROR' || /^-?\d+$/.test(code) || /network|timeout|request:fail|socket|连接|超时/i.test(message)
        if (!ambiguous) { cleanupUploadedOnFailure = true; throw updateError }
        let latest
        try { latest = await gateway.getProfile() } catch (_) {}
        if (!current(this, op)) return
        if (latest && String(latest.nickname || '') === nickname && String(latest.avatarFileId || '') === String(avatarFileId || '')) profile = latest
        else if (latest) { cleanupUploadedOnFailure = true; throw updateError }
        else throw new Error('资料保存结果暂时无法确认，请稍后重新打开查看')
      }
      if (!current(this, op)) return
      op.app.applyAccountProfile(profile)
      storage.saveName(profile.nickname)
      uploaded = ''
      const pages = getCurrentPages(), previous = pages[pages.length - 2]
      if (previous && typeof previous.setData === 'function') previous.setData({ name: profile.nickname, profileNickname: profile.nickname, profileAvatarFileId: profile.avatarFileId || '', profileAvatarPreview: profile.avatarFileId || '' })
      this.setData({ avatar: profile.avatarFileId || '', pendingAvatar: '', cleanupPending: Number(profile.avatarCleanup && profile.avatarCleanup.pendingCount) || Number(profile.avatarCleanupPendingCount) || 0 })
      this.finish(true)
      wx.showToast({ title: '微信资料已保存', icon: 'success' })
    } catch (error) {
      if (!current(this, op)) return
      let suffix = ''
      if (uploaded && cleanupUploadedOnFailure && wx.cloud && typeof wx.cloud.deleteFile === 'function') {
        try {
          const response = await wx.cloud.deleteFile({ fileList: [uploaded] })
          const item = Array.isArray(response && response.fileList) && response.fileList.find((entry) => entry && entry.fileID === uploaded)
          if (!item || !(item.code === 'SUCCESS' || item.status === 0)) suffix = '；新头像文件待清理'
        } catch (_) { suffix = '；新头像文件待清理' }
      } else if (uploaded) suffix = cleanupUploadedOnFailure ? '；新头像文件待清理' : '；头像已保留，避免损坏云端资料'
      if (!current(this, op)) return
      this.setData({ error: (error && error.message || '保存失败，请稍后重试') + suffix })
    } finally {
      if (current(this, op)) this.setData({ busy: false })
    }
  },
  continueLater() {
    if (this.data.busy) return
    const op = operationSnapshot(this)
    if (!current(this, op)) { this.setData({ error: '账号空间已变化，请重新打开资料页' }); return }
    if (!storage.getName()) storage.saveName(String(getApp().globalData.accountProfile && getApp().globalData.accountProfile.nickname || '微信用户'))
    const pages = getCurrentPages(), previous = pages[pages.length - 2]
    if (previous && typeof previous.setData === 'function' && this.data.onboarding) previous.setData({ name: storage.getName() || '微信用户' })
    this.finish(true)
  },
  cancel() { if (!this.data.busy) this.finish(false) },
  deleteProfile() {
    if (this.data.busy) return
    const op = operationSnapshot(this)
    if (!current(this, op)) { this.setData({ error: '账号空间已变化，请重新打开资料页' }); return }
    wx.showModal({ title: '删除云端资料？', content: '将删除你的昵称和头像资料；已加入的房间不会受影响。', confirmText: '删除资料', success: async (result) => {
      if (!result.confirm || !current(this, op)) return
      this.setData({ busy: true, error: '' })
      try {
        const result = await gateway.deleteProfile()
        if (!current(this, op)) return
        op.app.applyAccountProfile({ exists: false, nickname: '', avatarFileId: '' })
        storage.saveName('')
        this.setData({ cleanupPending: Number(result.avatarCleanup && result.avatarCleanup.pendingCount) || Number(result.avatarCleanupPendingCount) || 0 })
        const pages = getCurrentPages(), previous = pages[pages.length - 2]
        if (previous && typeof previous.setData === 'function') previous.setData({ name: '', profileNickname: '', profileAvatarFileId: '', profileAvatarPreview: '' })
        this.setData({ nickname: '', avatar: '', pendingAvatar: '' })
        wx.showToast({ title: result.avatarCleanup && result.avatarCleanup.pendingCount ? '资料已删除，旧头像待清理' : '云端资料已删除', icon: 'none' })
      } catch (error) { if (current(this, op)) this.setData({ error: error && error.message || '删除资料失败，请重试' }) }
      finally { if (current(this, op)) this.setData({ busy: false }) }
    } })
  },
  removeAvatar() {
    if (this.data.busy || !this.data.avatar) return
    if (this.data.pendingAvatar) {
      this.setData({ avatar: '', pendingAvatar: '' })
      return
    }
    const op = operationSnapshot(this)
    if (!current(this, op)) { this.setData({ error: '账号空间已变化，请重新打开资料页' }); return }
    this.setData({ busy: true, error: '' })
    gateway.updateProfile({ avatarFileId: '' }).then((profile) => {
      if (!current(this, op)) return
      op.app.applyAccountProfile(profile)
      const pages = getCurrentPages(), previous = pages[pages.length - 2]
      if (previous && typeof previous.setData === 'function') previous.setData({ profileAvatarFileId: '', profileAvatarPreview: '' })
      this.setData({ avatar: '', pendingAvatar: '', uploadPrefix: profile.avatarUploadPrefix || this.data.uploadPrefix, cleanupPending: Number(profile.avatarCleanupPendingCount) || 0 })
      wx.showToast({ title: '头像已移除', icon: 'success' })
    }).catch((error) => { if (current(this, op)) this.setData({ error: error && error.message || '头像移除失败，请重试' }) })
      .finally(() => { if (current(this, op)) this.setData({ busy: false }) })
  },
  toggleMore() { this.setData({ moreOpen: !this.data.moreOpen }) },
  async retryAvatarCleanup() {
    if (this.data.busy) return
    const op = operationSnapshot(this)
    if (!current(this, op)) { this.setData({ error: '账号空间已变化，请重新打开资料页' }); return }
    this.setData({ busy: true, error: '' })
    try {
      const result = await gateway.retryAvatarCleanup()
      if (!current(this, op)) return
      const count = Number(result && result.avatarCleanup && result.avatarCleanup.pendingCount) || 0
      this.setData({ cleanupPending: count })
      wx.showToast({ title: count ? '头像文件仍待清理，请稍后重试' : '头像文件已清理', icon: count ? 'none' : 'success' })
    } catch (error) { if (current(this, op)) this.setData({ error: error && error.message || '头像文件暂时无法清理，请重试' }) }
    finally { if (current(this, op)) this.setData({ busy: false }) }
  },
  finish(continueFlow) {
    if (!continueFlow) {
      this.continueRequested = false
      if (this.openerPage) this.openerPage.pendingProfileContinuation = null
    } else this.continueRequested = true
    if (!this.data.onboarding && this.fromTrips) {
      wx.navigateBack({ delta: 1, success: () => {
        const app = getApp()
        if (app.hasAccountConsent() && app.accountGenerationToken() === this.generation && storage.localScopeToken() === this.scope) wx.switchTab({ url: '/pages/trips/index' })
      }, fail: () => { this.continueRequested = false; wx.showToast({ title: '暂时无法返回，请重试', icon: 'none' }) } })
      return
    }
    const previous = this.openerPage
    const continuation = previous && previous.pendingProfileContinuation
    const scope = this.scope, generation = this.generation
    wx.navigateBack({ delta: 1, success: () => {
      if (!continueFlow || !previous || typeof continuation !== 'function' || previous.pendingProfileContinuation !== continuation) return
      const app = getApp()
      if (!app.hasAccountConsent() || app.accountGenerationToken() !== generation || storage.localScopeToken() !== scope) return
      previous.pendingProfileContinuation = null
      continuation()
    }, fail: () => { this.continueRequested = false; wx.showToast({ title: '暂时无法返回，请重试', icon: 'none' }) } })
  }
})

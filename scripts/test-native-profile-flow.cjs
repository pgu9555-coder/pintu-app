'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '../miniprogram-shell')
const uid = 'a'.repeat(64)
const profile = (nickname = '', avatarFileId = '') => ({ exists: Boolean(nickname), nickname, avatarFileId, avatarUploadPrefix: `avatars/profile-${uid}/` })
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture() {
  let definition, page, name = '', generation = 3, consent = true, scoped = true
  const events = { updates: [], gets: 0, uploads: [], deletes: [], navigations: [], toasts: [], savedNames: [], back: [] }
  const app = {
    globalData: { accountProfile: profile('', '') },
    hasAccountConsent: () => consent,
    accountGenerationToken: () => generation,
    applyAccountProfile(value) { this.globalData.accountProfile = Object.assign({}, this.globalData.accountProfile, value); return this.globalData.accountProfile },
    reset() { generation++; consent = false; scoped = false; this.globalData.accountProfile = null }
  }
  const storage = {
    localScopeToken: () => scoped ? uid : 'guest', isAccountScoped: () => scoped,
    getName: () => name, saveName(value) { name = value; events.savedNames.push(value) }
  }
  let latestProfile = profile('A', 'old-avatar')
  const gateway = {
    updateProfile(value) { events.updates.push(value); return Promise.resolve(Object.assign({}, latestProfile, value, { exists: true })) },
    getProfile() { events.gets++; return Promise.resolve(latestProfile) },
    deleteProfile() { return Promise.resolve({ avatarCleanup: { pendingCount: 0 } }) },
    retryAvatarCleanup() { return Promise.resolve({ avatarCleanup: { pendingCount: 0 } }) }
  }
  const wx = {
    canIUse: () => true,
    cloud: { uploadFile: (value) => { events.uploads.push(value); return Promise.resolve({ fileID: 'cloud-new' }) }, deleteFile: (value) => { events.deletes.push(value); return Promise.resolve({ fileList: [{ fileID: 'cloud-new', code: 'SUCCESS' }] }) } },
    showToast: (value) => events.toasts.push(value), showModal: (value) => events.modals = value,
    navigateBack(value) { events.back.push(value); if (value.success) value.success() }, switchTab(value) { events.navigations.push(value) }
  }
  const home = { pendingProfileContinuation: null, data: {}, setData(value) { Object.assign(this.data, value) } }
  const pages = [home]
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/profile/index.js'), 'utf8'), {
    Page(value) { definition = value }, wx, getApp: () => app, getCurrentPages: () => pages,
    require(request) { if (request.includes('roomGateway')) return gateway; if (request.includes('storage')) return storage; throw Error(request) },
    setTimeout(callback) { callback(); return 1 }, console
  })
  page = Object.assign({}, definition, { data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value) } })
  pages.push(page)
  page.onLoad({ onboarding: '1' })
  return { app, storage, gateway, events, wx, home, page, pages, setProfile(value) { latestProfile = value }, switchScope() { generation++; app.globalData.accountProfile = profile('B', 'b-avatar'); scoped = true; consent = true }, revoke() { consent = false; scoped = false } }
}

async function localLedgerSelfMember() {
  const file = path.join(root, 'pages/ledger/index.js')
  const accountProfile = profile('林', 'avatar-lin')
  const local = new Map()
  let activeScope = uid
  const storage = {
    localScopeToken: () => activeScope, isAccountScoped: () => activeScope !== 'guest',
    getLocal(key, fallback) { return local.has(key) ? local.get(key) : fallback },
    setLocal(key, value) { local.set(key, value); return true }, getName: () => '林', saveName() {},
    getScoped: (_key, fallback) => fallback, setScoped: () => true, removeScoped: () => true, save() {}, remove() {},
    cacheLedgerSnapshot: () => true, getLedgerBackupCache: () => []
  }
  const app = { globalData: { accountProfile }, hasAccountConsent: () => true, ensureAccountScope: async () => accountProfile }
  const wx = { getSystemInfoSync: () => ({ windowWidth: 375, statusBarHeight: 20 }), showToast(value) { this.lastToast = value }, showModal() {}, navigateTo() {}, navigateBack() {}, switchTab() {}, setNavigationBarTitle() {}, showLoading() {}, hideLoading() {} }
  let definition
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page(value) { definition = value }, wx, getApp: () => app, setInterval: () => 1, clearInterval() {}, console,
    require(request) {
      if (request === '../../utils/storage') return storage
      if (request === '../../utils/layout') return { headerTopPx: () => 72 }
      if (request === '../../services/roomGateway') return new Proxy({}, { get: (_target, key) => () => { throw Error('unexpected cloud call: ' + String(key)) } })
      return require(path.resolve(path.dirname(file), request))
    }
  })
  const page = Object.assign({}, definition, { data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value) } })
  await page.onLoad({})
  assert.equal(page.data.name, '林', 'a new local ledger starts with the saved profile name')
  assert.equal(page.data.ledger.members.length, 1, 'a new local ledger seeds one explicit self member')
  assert.equal(page.data.ledger.members[0].selfProfileScope, uid, 'the self marker is a trusted account scope, never a nickname guess')
  assert.equal(page.data.ledger.members[0].ownAvatar, 'avatar-lin', 'the own avatar is rendered only for the marked account member')
  assert.equal(page.data.payerIndex, 0, 'the new account member is the default payer')
  activeScope = 'guest'
  page.onShow()
  assert.equal(page.data.accessBlocked, true, 'a page cached under an account cannot become an editable guest ledger after logout')
  assert.equal(page.data.guestMode, false)
  assert.equal(page.data.ledger.members.length, 0, 'account members are cleared when scope changes')
}

async function homeFirstLoginRoute() {
  let definition, scope = uid, generation = 2, consent = false, navigations = []
  const pendingProfile = profile('林', '')
  const app = {
    globalData: { accountProfile: pendingProfile },
    hasAccountConsent: () => consent, grantAccountConsent() { consent = true },
    accountGenerationToken: () => generation,
    ensureAccountScope: async () => pendingProfile,
    resetAccountScope() { generation++; scope = 'guest'; consent = false; this.globalData.accountProfile = null }
  }
  const storage = { localScopeToken: () => scope, isAccountScoped: () => scope !== 'guest', setAccountScope: () => true, clearAccountScope() {}, saveName() {}, getName: () => '' }
  const gateway = { getProfile: async () => pendingProfile }
  const wx = { navigateTo(options) { navigations.push(options) }, showToast() {}, getPrivacySetting: ({ success }) => success({ needAuthorization: false }), showTabBar() {} }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/home/index.js'), 'utf8'), {
    Page(value) { definition = value }, wx, getApp: () => app,
    require(request) { if (request.includes('roomGateway')) return gateway; if (request.includes('storage')) return storage; if (request.includes('invite')) return { fromOptions: () => ({}) }; return { headerTopPx: () => 72 } }, console
  })
  const home = Object.assign({}, definition, { data: structuredClone(definition.data), accountPageGeneration: 1, accountPageGone: false, setData(value) { Object.assign(this.data, value) } })
  home.ensurePrivacyAuthorized = async () => {}
  home.loadProfile = async () => { home.setData({ profileLoaded: true, profileError: '', profileNickname: '林' }); return pendingProfile }
  let continued = 0
  home.requestWechatLogin(() => continued++, '公平碰面')
  home.setData({ privacyConsentChecked: true })
  await home.confirmWechatLogin()
  assert.equal(navigations.length, 1, 'incomplete first-login profile opens the separate editor page')
  assert.match(navigations[0].url, /pages\/profile\/index\?onboarding=1/)
  navigations[0].fail()
  assert.equal(typeof home.pendingProfileContinuation, 'function', 'a failed route preserves the pending continuation for retry')
  assert.equal(continued, 0, 'failed route does not run the requested action')
  assert.match(home.data.profileRouteError, /重试/)
  home.retryPendingProfile()
  assert.equal(navigations.length, 2, 'profile editor can be opened again after navigation failure')
}

async function logoutBehavior() {
  let definition, scope = uid, generation = 8, consent = true, resets = 0, modal, retained = true
  const profileValue = profile('林', 'avatar-lin')
  const app = { globalData: { accountProfile: profileValue }, hasAccountConsent: () => consent, accountGenerationToken: () => generation,
    resetAccountScope() { generation++; scope = 'guest'; consent = false; this.globalData.accountProfile = null; resets++ } }
  const accountTrips = { trips: [{ tripId: 'saved-a', ledger: { name: '保留本地账本', members: [], expenses: [] } }] }
  const storage = { localScopeToken: () => scope, isAccountScoped: () => scope !== 'guest', clearAccountScope() { scope = 'guest' },
    getLocal: (_key, fallback) => scope === uid ? accountTrips : fallback,
    getScoped: (_key, fallback) => fallback, getName: () => '', localScope: uid }
  const wx = { showModal(options) { modal = options }, showToast() {} }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/trips/index.js'), 'utf8'), {
    Page(value) { definition = value }, wx, getApp: () => app, getCurrentPages: () => [],
    require(request) { if (request.includes('roomGateway')) return {}; if (request.includes('storage')) return storage; if (request.includes('layout')) return { headerTopPx: () => 72 }; return {} }, console
  })
  const page = Object.assign({}, definition, { data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value) } })
  page.data.accountSignedIn = true
  page.onLoad()
  page.logoutAccount()
  scope = 'b'.repeat(64); generation++; consent = true; app.globalData.accountProfile = profile('B', 'avatar-b')
  modal.success({ confirm: true })
  assert.equal(resets, 0, 'an old logout confirmation cannot sign out a newly selected account')
  scope = uid; generation++; app.globalData.accountProfile = profileValue
  page.data.accountSignedIn = true
  page.logoutAccount(); modal.success({ confirm: true })
  assert.equal(resets, 1, 'confirmed logout clears consent and the active identity')
  assert.equal(page.data.accountSignedIn, false)
  assert.equal(page.data.localTrips.length, 0, 'logout hides account A local trips while signed out')
  assert.equal(accountTrips.trips[0].tripId, 'saved-a', 'logout keeps account A local trips stored for its next login')
  scope = uid
  assert.equal(storage.getLocal('pintu-local-ledger-trips-v1', { trips: [] }).trips[0].tripId, 'saved-a', 'logging back into A can still read its own local trips')
}

async function main() {
  {
    const f = fixture()
    f.app.globalData.accountProfile = profile('已保存的昵称', 'saved-avatar')
    f.page.onLoad({})
    assert.equal(f.page.data.nickname, '已保存的昵称', 'editing prefills the saved nickname')
    assert.equal(f.page.data.avatar, 'saved-avatar', 'editing prefills the saved avatar')
    assert.equal(f.events.uploads.length, 0, 'opening the editor does not collect or upload a new avatar')
    f.page.nicknameInput({ detail: { value: '新昵称' } })
    assert.equal(f.page.data.nickname, '新昵称', 'prefilled nickname remains editable')
  }
  {
    const f = fixture(); let continued = 0; f.home.pendingProfileContinuation = () => continued++
    f.page.setData({ nickname: '林', pendingAvatar: '/tmp/a.png', avatar: '/tmp/a.png' })
    await f.page.saveAndContinue()
    assert.equal(f.events.uploads.length, 1, 'explicit avatar choice uploads the file')
    assert.equal(f.events.updates.length, 1, 'save writes the chosen profile')
    assert.equal(f.events.back.length, 1, 'save returns from the independent profile page')
    assert.equal(continued, 1, 'the original collaborative action continues only after successful return')
    assert.equal(f.home.data.name, '林', 'the home page picks up the saved nickname before continuation')
  }
  {
    const f = fixture(); let continued = 0; f.home.pendingProfileContinuation = () => continued++
    f.page.finish(false)
    assert.equal(continued, 0, 'cancel never enters the pending operation')
    assert.equal(f.home.pendingProfileContinuation, null, 'cancel clears the pending operation so a later editor visit cannot trigger it')
  }
  {
    const f = fixture(); let continued = 0; f.home.pendingProfileContinuation = () => continued++
    f.page.continueLater()
    assert.equal(continued, 1, 'continue later enters the pending operation')
    assert.equal(f.storage.getName(), '微信用户', 'deferred completion uses a clear default name')
  }
  {
    const f = fixture(), uploading = deferred(); let updates = 0
    f.wx.cloud.uploadFile = () => uploading.promise
    f.gateway.updateProfile = () => { updates++; return Promise.resolve(profile('A', 'cloud-new')) }
    f.page.setData({ nickname: 'A', avatar: '/tmp/a.png', pendingAvatar: '/tmp/a.png' })
    const saving = f.page.saveAndContinue(); f.switchScope(); uploading.resolve({ fileID: 'cloud-new' }); await saving
    assert.equal(updates, 0, 'an old account page cannot write into the new account after its upload finishes')
  }
  {
    const f = fixture(); f.gateway.updateProfile = () => { const error = Error('network timeout'); error.code = 'NETWORK_ERROR'; throw error }
    f.gateway.getProfile = () => { f.events.gets++; return Promise.reject(Error('profile read timed out')) }
    f.page.setData({ nickname: 'A', avatar: '/tmp/a.png', pendingAvatar: '/tmp/a.png' })
    await f.page.saveAndContinue()
    assert.equal(f.events.gets, 1, 'ambiguous save errors reconcile against the trusted profile')
    assert.equal(f.events.deletes.length, 0, 'an uploaded avatar is preserved while commit status is uncertain')
  }
  {
    const f = fixture(); f.gateway.updateProfile = () => { const error = Error('invalid profile'); error.code = 'INVALID_PROFILE'; throw error }
    f.page.setData({ nickname: 'A', avatar: '/tmp/a.png', pendingAvatar: '/tmp/a.png' })
    await f.page.saveAndContinue()
    assert.equal(f.events.deletes.length, 1, 'a confirmed rejected profile update cleans its unused upload')
  }
  {
    const f = fixture(); f.storage.saveName(''); f.home.pendingProfileContinuation = () => {}; f.switchScope(); f.page.continueLater()
    assert.equal(f.storage.getName(), '', 'a stale page cannot persist its default name in another account scope')
    assert.equal(f.page.data.error.includes('账号空间'), true)
  }
  await localLedgerSelfMember()
  await homeFirstLoginRoute()
  await logoutBehavior()
  process.stdout.write('Native profile behavior passed: first-login save/defer/cancel, account-scope isolation, update reconciliation, and upload cleanup.\n')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })

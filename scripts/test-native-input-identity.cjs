'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '../miniprogram-shell')
const records = new Map()
const events = []
global.wx = {
  getStorageSync: key => records.get(key), setStorageSync: (key, value) => records.set(key, value), removeStorageSync: key => records.delete(key),
  canIUse: () => true, showToast: value => events.push(['toast', value]),
  navigateTo: value => { events.push(['navigate', value.url]); if (value.success) value.success() },
  getPrivacySetting: ({ success }) => success({ needAuthorization: false }), showTabBar() {}, hideTabBar() {}
}
const storage = require('../miniprogram-shell/utils/storage')
let appDefinition, definition
const a = 'a'.repeat(64), b = 'b'.repeat(64)
const profile = (id, nickname) => ({ exists: Boolean(nickname), nickname, avatarFileId: nickname ? 'cloud-avatar' : '', avatarUploadPrefix: `avatars/profile-${id}/` })
let serverProfile = profile(a, '小林')
const gateway = { getProfile: async () => serverProfile }
vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
  App: value => { appDefinition = value }, wx,
  require: request => request.includes('storage') ? storage : request.includes('roomGateway') ? gateway : {}
})
const app = Object.assign({}, appDefinition, { globalData: structuredClone(appDefinition.globalData) })
vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/home/index.js'), 'utf8'), {
  Page: value => { definition = value }, wx, getApp: () => app, console,
  require: request => request.includes('storage') ? storage : request.includes('roomGateway') ? gateway : require(path.resolve(root, 'pages/home', request))
})
const home = Object.assign({}, definition, { data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value) } })
async function main() {
  storage.setAccountScope(a); storage.saveName('旧账号的名字')
  home.onLoad({}); home.onShow()
  assert.equal(home.data.accountSignedIn, false, 'first launch cannot trust a cached account name')
  assert.equal(home.data.name, '', 'first launch clears stale identity')
  home.openJoinIdentity()
  assert.equal(home.data.wechatLoginVisible, true, 'signed-out identity is an active login entry')
  home.cancelWechatLogin()
  assert.equal(home.data.wechatLoginVisible, false)
  assert.equal(events.filter(([kind]) => kind === 'navigate').length, 0, 'cancel must stay on home')
  let continued = 0
  home.requestWechatLogin(() => continued++, '加入房间')
  home.togglePrivacyConsent()
  await home.confirmWechatLogin()
  assert.equal(continued, 1, 'successful complete-profile login continues exactly once')
  assert.equal(home.data.accountSignedIn, true)
  assert.equal(home.data.name, '小林')
  app.applyAccountProfile(profile(a, ''))
  home.onShow()
  assert.equal(home.data.accountSignedIn, true, 'missing nickname does not mean signed out')
  assert.equal(home.data.name, '', 'missing nickname must not reuse previous nickname')
  app.resetAccountScope(); home.onShow()
  assert.equal(home.data.accountSignedIn, false)
  assert.equal(home.data.name, '')
  assert.equal(home.data.profileNickname, '')
  assert.equal(home.data.profileAvatarPreview, '', 'logout clears old avatar')
  app.grantAccountConsent(); app.applyAccountProfile(profile(a, '甲'))
  storage.setAccountScope(b); home.onShow()
  assert.equal(home.data.accountSignedIn, false, 'mismatched trusted profile and local account scope must not show signed-in identity')
  assert.equal(home.data.name, '')
  for (const dir of fs.readdirSync(path.join(root, 'pages'))) {
    const file = path.join(root, 'pages', dir, 'index.wxml')
    if (!fs.existsSync(file)) continue
    for (const input of fs.readFileSync(file, 'utf8').matchAll(/<input\b[^>]*>/g)) {
      if (/\bplaceholder=/.test(input[0])) assert.match(input[0], /\bplaceholder-class=/, `${dir} input must style native placeholder explicitly`)
    }
  }
  const css = fs.readFileSync(path.join(root, 'pages/midpoint/index.wxss'), 'utf8')
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/(?:\.input|\binput\b)/.test(selectors) && !/placeholder/.test(selectors)) assert.doesNotMatch(body, /height\s*:\s*auto\b/, 'native input must not rely on auto height/min-height')
  }
  console.log('Native input/identity regressions passed: launch, login, cancel, nickname absence, logout, mismatched scope, placeholder and auto-height guards. Native glyph rasterization still requires WeChat devices.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })

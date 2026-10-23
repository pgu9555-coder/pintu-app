const assert = require('node:assert/strict')

const calls = []
let modalSuccess = null
let pages = []
const records = new Map()
global.wx = {
  getStorageSync(key) { return records.get(key) },
  setStorageSync(key, value) { records.set(key, value) },
  removeStorageSync(key) { records.delete(key) },
  showToast(options) { calls.push(['toast', options]) },
  showModal(options) { modalSuccess = options.success },
  switchTab(options) { calls.push(['switchTab', options.url]); if (options.success) options.success() },
  navigateTo(options) { calls.push(['navigateTo', options.url]); if (options.success) options.success() },
  hideTabBar() {},
  showTabBar() {}
}
global.getCurrentPages = () => pages

function loadPage(path) {
  let definition
  global.Page = (page) => { definition = page }
  delete require.cache[require.resolve(path)]
  require(path)
  const instance = Object.assign({}, definition, { data: Object.assign({}, definition.data) })
  instance.setData = (update) => { Object.assign(instance.data, update) }
  return instance
}

const storage = require('../miniprogram-shell/utils/storage')
const accountApp = {
  globalData: { accountProfile: { nickname: 'Ari', avatarFileId: 'cloud://avatar' } },
  hasAccountConsent: () => false
}
global.getApp = () => accountApp
const home = loadPage('../miniprogram-shell/pages/home/index.js')
const trips = loadPage('../miniprogram-shell/pages/trips/index.js')
pages = [home, trips]

home.openMidpoint()
assert.equal(home.data.wechatLoginVisible, true, 'a signed-out fair-meetup tap must open the login dialog')
assert.equal(home.data.loginPurpose, '公平碰面')
assert.equal(calls.filter(([kind]) => kind === 'navigateTo').length, 0, 'opening the login dialog must not enter the feature')
home.cancelWechatLogin()
assert.equal(home.data.wechatLoginVisible, false, 'cancel must dismiss the login dialog')
assert.equal(calls.filter(([kind]) => kind === 'navigateTo').length, 0, 'cancel must leave the user on the current page')

home.openLedger()
assert.equal(home.data.loginPurpose, '行程账本', 'the ledger dialog must name its requested destination')
home.cancelWechatLogin()

const token = 'a'.repeat(64)
storage.setAccountScope(token)
accountApp.hasAccountConsent = () => true
home.openMidpoint()
home.openLedger()
assert.deepEqual(calls.filter(([kind]) => kind === 'navigateTo').map(([, url]) => url), [
  '/pages/midpoint/index', '/pages/ledger/index'
], 'an authenticated tap must continue to the exact requested feature')

storage.clearAccountScope()
accountApp.hasAccountConsent = () => false
storage.setLocal('pintu-local-ledger-trips-v1', { trips: [{ tripId: 'guest-trip-1', ledger: { name: 'Guest', members: [], expenses: [] } }] })
trips.data.localTrips = [{ tripId: 'guest-trip-1' }]
calls.length = 0
trips.openLocal({ currentTarget: { dataset: { id: 'guest-trip-1' } } })
assert.equal(typeof modalSuccess, 'function', 'opening a guest ledger must show the backup/login choice')
modalSuccess({ confirm: false })
assert.ok(calls.some(([kind, url]) => kind === 'navigateTo' && url === '/pages/data-tools/index'), 'the guest backup choice must open the existing export/import page')
assert.ok(!calls.some(([kind, url]) => kind === 'navigateTo' && url.includes('guest-trip-1')), 'guest trip ids must never be passed to an account ledger page')

calls.length = 0
trips.profileCardTap()
assert.equal(home.data.wechatLoginVisible, true, 'the signed-out profile card must request explicit login')
home.cancelWechatLogin()
assert.ok(calls.some(([kind, url]) => kind === 'switchTab' && url === '/pages/trips/index'), 'cancelling login from the profile card must return to Trips')

storage.setAccountScope(token)
accountApp.hasAccountConsent = () => true
calls.length = 0
let profileEditorOpened = false
home.openProfileEditor = (fromTrips) => { profileEditorOpened = fromTrips }
trips.data.accountSignedIn = true
trips.profileCardTap()
assert.equal(profileEditorOpened, true, 'the signed-in Trips card must open the independent profile page in Trips return mode')

storage.clearAccountScope()
accountApp.hasAccountConsent = () => false
for (const [relativePath, route, options] of [
  ['../miniprogram-shell/pages/midpoint/index.js', '/pages/midpoint/index', { code: 'MEET1234' }],
  ['../miniprogram-shell/pages/ledger/index.js', '/pages/ledger/index', { tripId: 'guest-trip-1' }]
]) {
  calls.length = 0
  const page = loadPage(relativePath)
  page.onLoad(options)
  assert.equal(page.entryBlocked, true, `${route} direct entry must be blocked while signed out`)
  assert.ok(calls.some(([kind, url]) => kind === 'switchTab' && url === '/pages/home/index'), `${route} must route through the login page`)
  assert.equal(home.data.loginPurpose, route.includes('midpoint') ? '公平碰面' : '行程账本')
  home.afterWechatLogin()
  if (route.includes('midpoint')) {
    assert.ok(calls.some(([kind, url]) => kind === 'navigateTo' && url === '/pages/midpoint/index?code=MEET1234'), 'a room invite must resume its midpoint destination after login')
  } else {
    assert.ok(calls.some(([kind, url]) => kind === 'switchTab' && url === '/pages/trips/index'), 'a guest trip id must return to Trips after login')
    assert.ok(!calls.some(([kind, url]) => kind === 'navigateTo' && url.includes('guest-trip-1')), 'a guest trip id must never be reopened inside the signed-in namespace')
  }
}

console.log('Native profile and login gate behavior checks passed.')

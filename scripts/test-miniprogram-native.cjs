const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "miniprogram-shell");

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${path.relative(root, file)}: ${error.message}`);
  }
}

const files = filesIn(root);
const jsonFiles = files.filter((file) => path.extname(file) === ".json");
const jsFiles = files.filter((file) => path.extname(file) === ".js");

assert.ok(jsonFiles.length > 0, "miniprogram shell should contain JSON configuration");
jsonFiles.forEach(readJson);

const app = readJson(path.join(root, "app.json"));
assert.ok(Array.isArray(app.pages) && app.pages.length > 0, "app.json must declare pages");
for (const page of app.pages) {
  for (const extension of [".js", ".json", ".wxml"]) {
    const file = path.join(root, `${page}${extension}`);
    assert.ok(fs.existsSync(file), `app page ${page} is missing ${extension}`);
  }
}

const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
assert.match(
  appSource,
  /wx\.cloud\.init\s*\(\s*\{[\s\S]*?\benv\s*:\s*['"]pintu-d4g77ecn24b674fa0['"]/,
  "app.js must initialize CloudBase with the PintU environment"
);
const project = readJson(path.join(root, "project.config.json"));
assert.equal(project.appid, "wxe1fe19432c29e3cd", "project.config.json must use the PintU AppID");

const forbiddenMarkup = [{ pattern: /<\/?web-view\b/i, name: "web-view" }];
const forbiddenBrowserApis = [
  { pattern: /\bdocument\b/, name: "document" },
  { pattern: /\bwindow\b/, name: "window" },
  { pattern: /\blocalStorage\b/, name: "localStorage" },
  { pattern: /\balert\s*\(/, name: "alert" }
];
for (const file of files.filter((item) => [".js", ".wxml"].includes(path.extname(item)))) {
  const source = fs.readFileSync(file, "utf8");
  for (const { pattern, name } of forbiddenMarkup) {
    assert.ok(!pattern.test(source), `${path.relative(root, file)} must not use ${name}`);
  }
}
for (const file of jsFiles) {
  const source = fs.readFileSync(file, "utf8");
  for (const { pattern, name } of forbiddenBrowserApis) {
    assert.ok(!pattern.test(source), `${path.relative(root, file)} must not use ${name}`);
  }
}

for (const file of jsFiles) {
  const source = fs.readFileSync(file, "utf8");
  new vm.Script(source, { filename: path.relative(root, file) });
}

const midpoint = require(path.join(root, "utils", "midpoint.js"));
assert.equal(midpoint.average({ meetup: { people: [{ lat: 1, lng: 2 }] } }), null, "fewer than two people have no midpoint");
const midpointRoom = { meetup: { people: [{ name: "A", lat: 10, lng: 20 }, { name: "B", lat: 30, lng: 40 }] } };
assert.deepEqual(midpoint.average(midpointRoom), { latitude: 20, longitude: 30 }, "midpoint must average two coordinates");
const midpointMarkers = midpoint.markers(midpointRoom);
const centerMarker = midpointMarkers.find((marker) => marker.id === 9999);
assert.deepEqual(
  { latitude: centerMarker.latitude, longitude: centerMarker.longitude, zIndex: centerMarker.zIndex, title: centerMarker.title },
  { latitude: 20, longitude: 30, zIndex: 10, title: "参考中点" },
  "midpoint markers must include the center marker"
);

const gatewaySource = fs.readFileSync(path.join(root, "services", "roomGateway.js"), "utf8");
for (const action of ["publishDecisionCandidates", "setDecisionVote", "confirmDecisionCandidate", "reopenDecision", "updateProfile"]) {
  assert.match(
    gatewaySource,
    new RegExp(`${action}\\(data\\)\\s*\\{\\s*return call\\(['\"]${action}['\"], data\\)`),
    `room gateway must expose ${action}`
  );
}
assert.match(gatewaySource, /getProfile\(\)\s*\{\s*return call\(['"]getProfile['"]\)/, "room gateway must expose getProfile");
assert.match(gatewaySource, /deleteProfile\(\)\s*\{\s*return call\(['"]deleteProfile['"]\)/, "room gateway must expose deleteProfile");
assert.match(gatewaySource, /retryAvatarCleanup\(\)\s*\{\s*return call\(['"]retryAvatarCleanup['"]\)/, "room gateway must expose cleanup retry");
assert.match(gatewaySource, /listMyRooms\(cursor, limit\)\s*\{\s*return call\(['"]listMyRooms['"], \{ cursor, limit \}\)/, "room gateway must expose cursor-paginated listMyRooms");

const homePageSource = fs.readFileSync(path.join(root, "pages", "home", "index.js"), "utf8");
const homeMarkup = fs.readFileSync(path.join(root, "pages", "home", "index.wxml"), "utf8");
assert.match(homeMarkup, /open-type="chooseAvatar"[\s\S]*?bindchooseavatar="chooseAvatar"/, "home must use the native chooseAvatar button");
assert.match(homeMarkup, /<input[^>]*type="nickname"/, "home must use the native nickname input");
assert.match(homePageSource, /gateway\.getProfile\(\)/, "home must load the authenticated WeChat profile");
assert.match(homePageSource, /wx\.cloud\.uploadFile\(/, "avatar selection must upload through CloudBase");
assert.match(homePageSource, /gateway\.updateProfile\(/, "home must save profile updates through the gateway");
assert.match(homePageSource, /gateway\.deleteProfile\(\)/, "home must let the caller delete their cloud profile");
assert.match(homePageSource, /gateway\.retryAvatarCleanup\(\)/, "home must let the caller retry an observable avatar cleanup failure");
assert.match(homePageSource, /gateway\.updateProfile\(\{ avatarFileId: '' \}\)/, "home must let the caller remove their avatar");
assert.match(homePageSource, /avatarUploadPrefix/, "avatar uploads must use the caller's trusted, server-issued path prefix");
assert.match(homePageSource, /wx\.canIUse/, "home must detect chooseAvatar support on older clients");
assert.match(homePageSource, /storage\.saveName\(profile\.nickname\)/, "saved profile names must become the local room-name default");
assert.match(homePageSource, /onLoad\(options\)[\s\S]*?storage\.saveName\(['"]['"]\)/, "home must clear a previous WeChat account's cached nickname before resolving the current profile");
assert.ok(!/profile\.nickname\s*\|\|\s*storage\.getName\(\)/.test(homePageSource), "profile loading must not fall back to another account's cached nickname");
assert.ok(!/wx\.getUserProfile/.test(homePageSource + homeMarkup), "the deprecated getUserProfile API must not be used");
assert.ok(!/wx\.login\s*\(/.test(homePageSource), "trusted CloudBase OpenID must not be replaced by a client login identifier");
assert.match(homeMarkup, /使用微信账号登录[\s\S]*?微信登录并继续/, "home must explain WeChat identity use before entering the app");
assert.match(homeMarkup, /wechatProfileConfirming[\s\S]*?open-type="chooseAvatar"[\s\S]*?type="nickname"[\s\S]*?保存资料并进入/, "first login must require an explicit native avatar and nickname confirmation step");
assert.match(homeMarkup, /无法也不会静默读取头像/, "first login must accurately explain WeChat avatar privacy behavior");
assert.match(homePageSource, /confirmWechatLogin\(\)[\s\S]*?ensurePrivacyAuthorized\(\)[\s\S]*?ensureAccountScope\(\)[\s\S]*?loadProfile\(\)[\s\S]*?wechatProfileConfirming:\s*true/, "WeChat entry must bind the trusted account before showing profile confirmation");
assert.match(homePageSource, /if \(profile && profile\.exists\)[\s\S]*?wechatLoginVisible:\s*false[\s\S]*?else[\s\S]*?wechatProfileConfirming:\s*true/, "returning users must not be forced to rewrite an already-saved profile");
assert.match(homePageSource, /const completesWechatLogin = this\.data\.wechatProfileConfirming[\s\S]*?wechatLoginVisible:\s*completesWechatLogin \? false/, "the blocking login overlay must close only after profile persistence succeeds");
assert.match(appSource, /applyAccountProfile\(profile\)[\s\S]*?storage\.setAccountScope\(nextProfile\)[\s\S]*?globalData\.accountProfile = nextProfile/, "saved profile changes must refresh the global trusted-account cache");
assert.match(homePageSource, /gateway\.updateProfile\([\s\S]*?applyAccountProfile\(profile\)/, "saving a profile must refresh the account cache with the server result");
assert.match(homePageSource, /isAmbiguousProfileUpdateError[\s\S]*?gateway\.getProfile\(\)[\s\S]*?latestProfile\.avatarFileId[\s\S]*?PROFILE_UPDATE_UNCONFIRMED/, "ambiguous avatar updates must reconcile before any cleanup");
assert.match(homePageSource, /cleanupUploadedOnFailure\s*\?[\s\S]*?deleteUnsavedAvatarUpload\(uploadedFileId\)[\s\S]*?头像已保留，避免损坏云端资料/, "an unconfirmed avatar update must preserve the uploaded file");
assert.match(homePageSource, /wx\.getPrivacySetting[\s\S]*?wx\.requirePrivacyAuthorize/, "WeChat entry must use the current privacy authorization flow when required");

const tripsPageSource = fs.readFileSync(path.join(root, "pages", "trips", "index.js"), "utf8");
const tripsMarkup = fs.readFileSync(path.join(root, "pages", "trips", "index.wxml"), "utf8");
assert.match(tripsPageSource, /gateway\.listMyRooms\(null, 50\)/, "trips must load the caller's first cloud room page");
assert.match(tripsPageSource, /gateway\.listMyRooms\(cursor, 50\)/, "trips must load additional cloud room pages by cursor");
assert.match(tripsPageSource, /cursor\.createdAt/, "trips must validate immutable creation-time cursors");
assert.match(tripsPageSource, /myRoomsRequestId/, "trips must ignore stale room-list responses");
assert.ok(!/storage\.all\(/.test(tripsPageSource), "trips must not display shared-device room caches");
assert.match(tripsPageSource, /storage\.getScoped\(LOCAL_LEDGER_TRIPS_KEY/, "trips must read local ledgers only from account-scoped storage");
assert.match(tripsPageSource, /storage\.setScoped\(LOCAL_LEDGER_TRIPS_KEY/, "deleting a local trip must remain account-scoped");
assert.match(tripsPageSource, /ensureAccountScope/, "trips must wait for the authenticated account scope before reading local or cloud data");
assert.match(tripsPageSource, /storage\.save\(\{ docId: entry\.docId, room: entry\.room \}\)/, "opening a trusted cloud room may refresh its local cache");
assert.match(tripsPageSource, /cloudError/, "trips must retain a clear cloud-load error state");
assert.match(tripsMarkup, /正在同步你的云端房间/, "trips must render a cloud loading state");
assert.match(tripsMarkup, /cloudError/, "trips must render cloud-load failures");
assert.match(tripsMarkup, /加载更多/, "trips must offer paginated room recovery");
assert.match(tripsMarkup, /本地行程/, "trips must separately render account-scoped local ledger trips");
assert.match(tripsPageSource, /删除本地行程/, "trips must confirm before deleting a local ledger trip");
assert.match(tripsPageSource, /reconcileLedgerOutbox/, "trips must recover pending ledger writes even when the original room page is no longer reachable");
assert.match(tripsPageSource, /gateway\.syncLedger\(docId, entry\.ledger, entry\.membershipEpoch\)/, "trips must retry valid pending ledgers in the background");
assert.match(tripsPageSource, /saveRoomSnapshot\(docId, entry\.roomName, entry\.ledger, true\)/, "ended rooms with pending ledger data must become local history");
assert.match(tripsPageSource, /if \(entry\.blocked\) continue/, "trips must not endlessly retry a blocked ledger outbox entry");
assert.match(tripsPageSource, /stalePending[\s\S]*?saveRoomSnapshot\(docId, room\.name, ledger, Boolean\(pending\)\)/, "trips must snapshot pending ledger data before exit or disband");
assert.match(tripsPageSource, /function isNonRetryableLedgerError/, "trips must recognize permanent ledger conflicts");
assert.ok(!/restoreRoomSnapshot\(docId, previousSnapshot\)/.test(tripsPageSource), "uncertain leave/disband responses must retain the newest recovery snapshot");

const midpointPageSource = fs.readFileSync(path.join(root, "pages", "midpoint", "index.js"), "utf8");
const midpointMarkup = fs.readFileSync(path.join(root, "pages", "midpoint", "index.wxml"), "utf8");
assert.match(midpointPageSource, /function currentDecision\(/, "midpoint must normalize decision state before rendering");
assert.match(midpointPageSource, /membershipEpoch:\s*viewer\.membershipEpoch/, "decision writes must carry membershipEpoch");
assert.match(midpointPageSource, /recoverPendingPointDraft\(pending[\s\S]*?mineDraftDirty\s*=\s*true/, "invalidated meetup writes must remain as an editable local draft");
assert.match(midpointPageSource, /if \(!result\.room\)[\s\S]*?recoverPendingPointDraft\(pending/, "an ended room must preserve an unsynced meetup point as a local draft");
assert.match(midpointPageSource, /roundId:\s*decision\.roundId/, "decision writes must carry the current roundId");
assert.match(midpointPageSource, /\['STALE_MEMBERSHIP', 'STALE_DECISION', 'DECISION_CONFIRMED', 'CANDIDATE_NOT_FOUND'\]/, "stale or confirmed decision writes must refresh room state");
assert.match(midpointPageSource, /wx\.openLocation\([\s\S]*?共同候选地点/, "decision candidates must be openable in the map");
assert.match(midpointMarkup, /从地图添加候选地点/, "midpoint must let members add a map-selected candidate");
assert.match(midpointMarkup, /data-value="want"[\s\S]*?data-value="ok"[\s\S]*?data-value="no"/, "midpoint must expose all vote choices");
assert.match(midpointMarkup, /重新选择共同去处/, "owners must be able to reopen a confirmed decision");
assert.match(midpointMarkup, /按坐标平均估算，最终请结合实际交通/, "the fair-midpoint title must be paired with an accuracy disclaimer");
assert.match(midpointPageSource, /LOCAL_MIDPOINT_KEY/, "midpoint must preserve standalone multi-address work locally");
assert.match(midpointPageSource, /chooseLocalPoint\(event\)/, "standalone midpoint must let each address be selected from the native map");
assert.match(midpointPageSource, /if \(!amap\.configuredKey\(\)\)[\s\S]*?this\.addDecisionCandidate\(\)/, "room candidate search must fall back to native map selection when AMap is unavailable");
assert.match(midpointPageSource, /startSwipe\(\)[\s\S]*?swipeAction\(event\)/, "midpoint must expose the same candidate blind-box flow as Web");
assert.match(midpointPageSource, /const MAX_LOCAL_POINTS = 4/, "standalone midpoint must cap the compact people list at four");
assert.match(midpointMarkup, /item\.isSelf && item\.avatarFileId[\s\S]*?point-avatar-image[\s\S]*?item\.initial/, "the first local person must show the saved WeChat avatar with a 我 fallback");
assert.ok(!/point-avatar local-avatar[^>]*>\{\{index \+ 1\}\}/.test(midpointMarkup), "standalone midpoint must not show numbered placeholder avatars");
assert.match(midpointMarkup, /添加一位出发的朋友/, "standalone midpoint must add friends on demand");
assert.match(midpointPageSource, /localFriendLetter\(index - 1\)/, "added people must be labelled B, C and D after the self row");
assert.match(midpointPageSource, /points\.length < 2[\s\S]*?points\.some\(\(point\) => !hasLocalCoordinates\(point\)\)/, "local midpoint must require every displayed person to choose a location");
assert.match(midpointPageSource, /String\(point && point\.id \|\| ''\) !== `local-\$\{index \+ 1\}`/, "legacy migration must not delete newly-added blank friends");

let midpointPageDefinition = null;
const midpointStorageWrites = [];
const midpointToasts = [];
const midpointStorageStub = {
  setScoped(key, value) {
    midpointStorageWrites.push({ key, value });
    return true;
  }
};
const midpointUtilStub = {
  average(room) {
    const people = room.meetup.people;
    return {
      latitude: people.reduce((sum, person) => sum + Number(person.lat), 0) / people.length,
      longitude: people.reduce((sum, person) => sum + Number(person.lng), 0) / people.length
    };
  },
  markers() { return []; }
};
const midpointSandbox = {
  require(request) {
    if (/storage$/.test(request)) return midpointStorageStub;
    if (/midpoint$/.test(request)) return midpointUtilStub;
    if (/amap$/.test(request)) return { configuredKey() { return false; } };
    return {};
  },
  Page(definition) { midpointPageDefinition = definition; },
  wx: { showToast(options) { midpointToasts.push(options); } },
  console,
  setTimeout,
  clearTimeout,
  globalThis: null
};
midpointSandbox.globalThis = midpointSandbox;
vm.runInNewContext(
  `${midpointPageSource}\n;globalThis.__localPointTest = { emptyLocalPoints, validLocalState, normalizeLocalPoints, hasLocalCoordinates };`,
  midpointSandbox,
  { filename: "pages/midpoint/index.js" }
);
assert.ok(midpointPageDefinition, "midpoint page definition must load in the test sandbox");
const localPointTest = midpointSandbox.__localPointTest;
const defaultLocalPoints = localPointTest.emptyLocalPoints();
assert.equal(defaultLocalPoints.length, 1, "standalone midpoint must start with only the current user");
assert.equal(defaultLocalPoints[0].initial, "我", "the default current-user avatar fallback must be 我");
assert.equal(defaultLocalPoints[0].isSelf, true, "the default row must be marked as the current user");
assert.equal(localPointTest.hasLocalCoordinates({ lat: null, lng: null }), false, "null coordinates must never be treated as zero coordinates");
assert.equal(localPointTest.hasLocalCoordinates({ lat: " ", lng: " " }), false, "whitespace coordinates must never be treated as zero coordinates");
assert.equal(localPointTest.hasLocalCoordinates({ lat: 91, lng: 0 }), false, "latitudes outside the geographic range must be rejected");
assert.equal(localPointTest.hasLocalCoordinates({ lat: 0, lng: 181 }), false, "longitudes outside the geographic range must be rejected");
assert.equal(localPointTest.hasLocalCoordinates({ lat: 0, lng: 0 }), true, "real zero coordinates must remain valid");
const migratedLegacy = localPointTest.validLocalState({ points: [
  { id: "local-1", name: "地点 1", address: "", lat: null, lng: null },
  { id: "local-2", name: "地点 2", address: "", lat: null, lng: null }
] }, { nickname: "测试用户", avatarFileId: "cloud://avatar" });
assert.equal(migratedLegacy.points.length, 1, "untouched legacy two-row drafts must migrate to the new one-person default");
assert.equal(migratedLegacy.points[0].avatarFileId, "cloud://avatar", "the current user's saved avatar must decorate the first row");
const deliberateBlankFriend = localPointTest.validLocalState({ points: [
  { id: "local-self", isSelf: true, label: "我", address: "", lat: null, lng: null },
  { id: "local-friend-1", isSelf: false, label: "朋友 B", address: "", lat: null, lng: null }
] }, {});
assert.equal(deliberateBlankFriend.points.length, 2, "a deliberately-added blank friend must survive page reload");
assert.equal(deliberateBlankFriend.points[1].initial, "B", "the first added friend must be B");

function createMidpointContext(points) {
  const context = Object.assign({}, midpointPageDefinition);
  context.data = {
    localPoints: points,
    localCandidates: [],
    localCalculated: false,
    center: null,
    markers: [],
    mapSearchMessage: ''
  };
  context.accountProfile = { nickname: "测试用户", avatarFileId: "cloud://avatar" };
  context.localStorageReady = true;
  context.localSearchVersion = 0;
  context.setData = function setData(update, callback) {
    this.data = Object.assign({}, this.data, update);
    if (callback) callback();
  };
  context.searchLocalCandidates = function searchLocalCandidates() {};
  return context;
}

midpointStorageWrites.length = 0;
const midpointBehavior = createMidpointContext(defaultLocalPoints);
midpointBehavior.addLocalPoint();
assert.equal(Array.from(midpointBehavior.data.localPoints, (point) => point.initial).join(','), "我,B", "the first add action must create friend B");
midpointBehavior.addLocalPoint();
midpointBehavior.addLocalPoint();
assert.equal(Array.from(midpointBehavior.data.localPoints, (point) => point.initial).join(','), "我,B,C,D", "friend additions must remain sequential through D");
midpointBehavior.removeLocalPoint({ currentTarget: { dataset: { id: midpointBehavior.data.localPoints[1].id } } });
assert.equal(Array.from(midpointBehavior.data.localPoints, (point) => point.initial).join(','), "我,B,C", "deleting a middle friend must renumber the remaining friends");
const latestMidpointWrite = midpointStorageWrites[midpointStorageWrites.length - 1];
assert.ok(latestMidpointWrite && latestMidpointWrite.key === "pintu-local-midpoint-v2", "local people changes must use account-scoped storage");
assert.ok(!Object.hasOwn(latestMidpointWrite.value.points[0], "avatarFileId"), "the profile avatar must never be persisted in the midpoint draft");

const midpointCalculation = createMidpointContext(localPointTest.normalizeLocalPoints([
  { id: "local-self", address: "位置一", lat: 22.5, lng: 114 },
  { id: "local-friend-1", address: "", lat: null, lng: null }
], {}));
midpointCalculation.calculateLocalMidpoint();
assert.equal(midpointCalculation.data.localCalculated, false, "an added friend without a location must block calculation");
midpointCalculation.data.localPoints[1] = Object.assign({}, midpointCalculation.data.localPoints[1], { address: "位置二", lat: 22.7, lng: 114.2 });
midpointCalculation.calculateLocalMidpoint();
assert.equal(midpointCalculation.data.localCalculated, true, "all displayed people with locations must calculate");
assert.equal(midpointCalculation.data.center.latitude, 22.6, "behavioral midpoint latitude must be averaged");
assert.equal(midpointCalculation.data.center.longitude, 114.1, "behavioral midpoint longitude must be averaged");
assert.match(midpointMarkup, /不知道选哪个？盲盒帮你挑/, "midpoint must render the destination blind-box entry");

const ledger = require(path.join(root, "utils", "ledger.js"));
const ledgerFixture = {
  members: [
    { id: "alice", name: "Alice" },
    { id: "bob", name: "Bob" },
    { id: "carol", name: "Carol" }
  ],
  expenses: [
    { payerId: "alice", amountCents: 1000, splitIds: ["alice", "bob", "carol"] },
    { payerId: "bob", amountCents: 200, splitIds: ["alice", "bob"] }
  ]
};
assert.equal(ledger.totalCents(ledgerFixture), 1200, "ledger expense total must be calculated by the shared utility");
assert.deepEqual(ledger.balances(ledgerFixture), [
  { id: "alice", name: "Alice", cents: 566 },
  { id: "bob", name: "Bob", cents: -233 },
  { id: "carol", name: "Carol", cents: -333 }
], "ledger balances must split expenses and preserve rounding");
assert.deepEqual(ledger.settlements(ledgerFixture), [
  { from: "Carol", to: "Alice", cents: 333 },
  { from: "Bob", to: "Alice", cents: 233 }
], "ledger settlements must reconcile every balance");
assert.deepEqual(
  ledger.settlementPlan(ledgerFixture),
  {
    rows: [
      { from: "Carol", to: "Alice", cents: 333 },
      { from: "Bob", to: "Alice", cents: 233 }
    ],
    exact: true
  },
  "small ledger settlements must report an exact minimum-transfer plan"
);
const largeLedgerFixture = {
  members: Array.from({ length: 11 }, (_, index) => ({ id: `m${index}`, name: `M${index}` })),
  expenses: [{ payerId: "m0", amountCents: 100, splitIds: Array.from({ length: 10 }, (_, index) => `m${index + 1}`) }]
};
assert.equal(ledger.settlementPlan(largeLedgerFixture).exact, false, "large ledgers must use the greedy settlement fallback");

const ledgerPageSource = fs.readFileSync(path.join(root, "pages", "ledger", "index.js"), "utf8");
const ledgerMarkup = fs.readFileSync(path.join(root, "pages", "ledger", "index.wxml"), "utf8");
assert.match(ledgerPageSource, /LOCAL_LEDGER_TRIPS_KEY/, "ledger must support persistent standalone trips");
assert.match(ledgerPageSource, /newTripId\(/, "new standalone ledgers must receive a distinct trip ID");
assert.match(ledgerPageSource, /options && options\.tripId/, "a standalone trip must be reopenable by tripId");
assert.match(ledgerPageSource, /storage\.getScoped\(LOCAL_LEDGER_TRIPS_KEY/, "standalone ledger reads must remain account-scoped");
assert.match(ledgerPageSource, /storage\.setScoped\(LOCAL_LEDGER_TRIPS_KEY/, "standalone ledger writes must remain account-scoped");
assert.match(ledgerPageSource, /hasLocalTripContent/, "blank standalone ledger shells must not be retained in the trip list");
assert.match(ledgerPageSource, /if \(!saveLocalLedger\(this\.tripId, next\)\)/, "local ledger storage failures must not be reported as saved");
assert.match(ledgerPageSource, /ensureAccountScope/, "ledger must wait for the authenticated account scope before local storage access");
assert.ok(!/pintu-local-ledger-v3/.test(ledgerPageSource), "ledger must not migrate or expose the legacy shared-device local key");
assert.match(ledgerPageSource, /gateway\.syncLedger\(this\.docId, next, this\.viewerMembershipEpoch\(\)\)/, "shared ledger writes must still use the guarded cloud gateway");
assert.match(ledgerPageSource, /fromRemote && this\.data\.editingId && !\(source\.expenses \|\| \[\]\)\.some/, "a remotely deleted expense must exit the mini-program edit form");
assert.match(ledgerPageSource, /editingId && !editing[\s\S]*?重新添加/, "saving a stale mini-program edit must not recreate a removed expense");
assert.match(ledgerPageSource, /if \(this\.docId && member\.uid\)/, "only real shared-room members, not local history members, are protected from rename/delete");
assert.match(ledgerPageSource, /entry\.blocked[\s\S]*?同步冲突，待修改/, "blocked ledger outbox entries must show a recoverable conflict state");
assert.match(ledgerPageSource, /function isNonRetryableLedgerError/, "ledger must classify permanent gateway failures");
assert.ok(!/restoreRoomSnapshot\(docId, previousSnapshot\)/.test(ledgerPageSource), "uncertain room exits must not roll back the newest snapshot");
assert.match(ledgerMarkup, /同行的人[\s\S]*?记支出[\s\S]*?谁转给谁/, "ledger must retain the Web three-step workflow");
assert.match(ledgerMarkup, /(?:bind|catch)tap="editExpense"/, "existing expenses must be editable");
assert.match(ledgerMarkup, /最少转账方案/, "ledger must render final settlement instructions");

const spinnerPageSource = fs.readFileSync(path.join(root, "pages", "spinner", "index.js"), "utf8");
const spinnerMarkup = fs.readFileSync(path.join(root, "pages", "spinner", "index.wxml"), "utf8");
assert.match(spinnerPageSource, /wx\.createCanvasContext\(['"]spinnerCanvas['"]/, "spinner must draw a labeled segmented wheel");
assert.match(spinnerPageSource, /const turns = 5 \+ Math\.floor\(Math\.random\(\) \* 2\)/, "spinner must rotate through five or six full turns before selecting a result");
assert.match(spinnerPageSource, /targetAngle = this\.rotation \+ turns \* 360 \+ delta/, "spinner must animate to the selected segment");
assert.match(spinnerPageSource, /COLORS\s*=\s*\[[\s\S]*?#C99A3C['"]\]/, "spinner must keep the same eight-colour palette as Web");
assert.match(spinnerPageSource, /this\.data\.names\.length >= 8/, "spinner must reject a ninth participant like Web");
assert.match(spinnerPageSource, /names\.length < 2/, "spinner must require at least two participants");
assert.match(spinnerPageSource, /const DEFAULT_NAMES = \[\]/, "native spinner must begin with no prefilled friends");
assert.match(spinnerPageSource, /windowWidth = Number\(system\.windowWidth\)/, "native spinner canvas must derive its size from the viewport");
assert.match(spinnerPageSource, /canvasSize = Math\.max\(1, Math\.round\(wheelCssPx\)\)/, "native spinner canvas must match the legacy context's viewport-pixel coordinate space");
assert.match(spinnerPageSource, /Number\(this\.data\.canvasSize\)/, "native wheel drawing must use its bound canvas size");
assert.ok(!/getStorageSync|setStorageSync|pintu-spinner-v3/.test(spinnerPageSource), "spinner must stay session-only like Web and never leak a prior account's list");
assert.match(spinnerMarkup, /wheel-pointer[\s\S]*?wheel-rotor[\s\S]*?wheel-center/, "spinner must render a pointer, animated rotor, and center control");
assert.match(spinnerMarkup, /width="\{\{canvasSize\}\}" height="\{\{canvasSize\}\}"/, "native canvas markup must bind the viewport-matched buffer");

assert.match(midpointPageSource, /typeof wx\.chooseLocation !== ['"]function['"]/, "midpoint must guard unsupported native map APIs");
assert.match(midpointPageSource, /translateX\(\$\{delta\}px\)/, "blind-box drag distance must use the same pixel unit as touch coordinates");

const readmeSource = fs.readFileSync(path.join(root, "..", "README.md"), "utf8");
assert.match(readmeSource, /同一个 8 位房间码可在两端加入/, "documentation must describe Web/mini-program room interoperability");

console.log(`Native miniprogram checks passed (${jsonFiles.length} JSON files, ${jsFiles.length} JavaScript files).`);

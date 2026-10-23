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
const appStyles = fs.readFileSync(path.join(root, "app.wxss"), "utf8");
const amapSource = fs.readFileSync(path.join(root, "utils", "amap.js"), "utf8");
assert.match(
  appSource,
  /wx\.cloud\.init\s*\(\s*\{[\s\S]*?\benv\s*:\s*environment\.cloudbaseEnvId/,
  "app.js must initialize CloudBase with the PintU environment"
);
assert.equal(require(path.join(root, 'environment.js')).cloudbaseEnvId, readJson(path.join(root, '..', 'cloudbaserc.json')).envId, 'web deployment and native app must use the same configured environment');
assert.match(appSource, /wx\.cloud\.init\s*\(\s*\{[\s\S]*?traceUser\s*:\s*false/, "first launch must not enable CloudBase user tracing before explicit account consent");
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

assert.match(amapSource, /wx\.cloud\.callFunction/, "map utility must call the CloudBase map gateway");
assert.match(amapSource, /name:\s*['"]mapGateway['"]/, "map utility must use the dedicated mapGateway function");
assert.match(amapSource, /function configuredKey\(\)\s*\{[\s\S]*?return true/, "map utility must preserve configuredKey as an availability contract");
assert.doesNotMatch(amapSource, /wx\.request|restapi\.amap\.com|amapMiniKey|\.key\b/, "map utility must not expose a provider key or call the provider directly");

let mapClientCall = null;
const mapClientSandbox = {
  module: { exports: {} },
  setTimeout,
  clearTimeout,
  wx: { cloud: { callFunction(options) {
    mapClientCall = options;
    return Promise.resolve({ result: { ok: true, data: [{ id: "safe-result" }] } });
  } } }
};
vm.runInNewContext(amapSource, mapClientSandbox, { filename: "utils/amap.js" });
const amapClient = mapClientSandbox.module.exports;
assert.equal(amapClient.configuredKey(), true, "the server-backed map client must remain enabled without a bundled key");
amapClient.inputTips("coffee").then((items) => assert.equal(items[0].id, "safe-result"));
assert.equal(mapClientCall.name, "mapGateway", "text search must use the map gateway");
assert.equal(mapClientCall.data.action, "inputTips", "text search must use the bounded gateway action");
assert.equal(mapClientCall.data.keywords, "coffee", "text search must forward only the typed query");
amapClient.nearby({ latitude: 22.5, longitude: 114.1 }).then((items) => assert.equal(items[0].id, "safe-result"));
assert.equal(mapClientCall.name, "mapGateway", "nearby search must use the map gateway");
assert.equal(mapClientCall.data.action, "nearby", "nearby search must use the bounded gateway action");
assert.equal(mapClientCall.data.latitude, 22.5, "nearby search must send only fixed coordinate inputs to the gateway");
assert.equal(mapClientCall.data.longitude, 114.1, "nearby search must send only fixed coordinate inputs to the gateway");

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
const inviteSource = fs.readFileSync(path.join(root, "utils", "invite.js"), "utf8");
const invite = require(path.join(root, "utils", "invite.js"));
assert.equal(invite.sharePath("ABCD2345", "midpoint"), "/pages/home/index?code=ABCD2345&type=midpoint", "midpoint shares must contain only the room code and explicit type");
assert.equal(invite.sharePath("ABCD2345", "ledger"), "/pages/home/index?code=ABCD2345&type=ledger", "ledger shares must contain only the room code and explicit type");
assert.equal(invite.sharePath("bad-code", "midpoint"), "/pages/home/index", "invalid share codes must not be emitted");
assert.equal(invite.sharePath("ABCD2345", "docId"), "/pages/home/index", "unknown share types must not be emitted");
assert.deepEqual(invite.fromOptions({ code: "ABCD2345", type: "midpoint", docId: "private-doc", uid: "private-user", name: "private-name", token: "private-token" }), { code: "ABCD2345", type: "midpoint", valid: true }, "invite parsing must ignore personal and internal parameters");
assert.deepEqual(invite.fromOptions({ code: "ABCD2345", type: "tampered" }), { code: "ABCD2345", type: "", valid: false }, "tampered invite types must not be trusted");
assert.match(inviteSource, /ROOM_CODE\s*=\s*\/\^\[A-HJ-NP-Z2-9\]\{8\}\$\//, "invite room codes must be strictly eight-character codes");
const homeOnLoad = homePageSource.slice(homePageSource.indexOf("onLoad(options)"), homePageSource.indexOf("async confirmWechatLogin()"));
assert.match(homeOnLoad, /invite\.fromOptions\(options\)/, "home must parse invitation parameters during onLoad");
assert.match(homeOnLoad, /storage\.saveName\(['"]['"]\)/, "home onLoad must clear a previous account's cached room name before profile resolution");
assert.ok(!/\bjoin\s*\(/.test(homeOnLoad), "home onLoad must never automatically join an invited room");
assert.match(homePageSource, /requestedType\s*=\s*invite\.inviteType\(this\.data\.inviteType\) \|\| 'auto'[\s\S]*?gateway\.join\(code, requestedType, name\)/, "a valid invite must join with its explicit type and a tampered type must safely fall back to ordinary auto join");
assert.match(homePageSource, /toolType\s*=\s*invite\.inviteType\(result[\s\S]*?encodeURIComponent\(docId\)/, "invite navigation must whitelist the server room type and encode the document ID");
assert.match(homePageSource, /ROOM_HISTORY_FULL:[\s\S]*?LEDGER_HISTORY_FULL:/, "invite errors must map both room and ledger history limits to useful messages");
assert.match(homeMarkup, /invite-notice[\s\S]*?\{\{inviteLabel\}\}[\s\S]*?\{\{code\}\}[\s\S]*?确认加入/, "home must show the invited tool and room code before an explicit join tap");
const midpointShareSource = fs.readFileSync(path.join(root, "pages", "midpoint", "index.js"), "utf8");
const ledgerShareSource = fs.readFileSync(path.join(root, "pages", "ledger", "index.js"), "utf8");
assert.match(midpointShareSource, /onShareAppMessage\(\)[\s\S]*?invite\.shareTitle\('midpoint'\)[\s\S]*?invite\.sharePath\(room\.code, 'midpoint'\)/, "midpoint must share its explicit invite type");
assert.match(ledgerShareSource, /onShareAppMessage\(\)[\s\S]*?invite\.shareTitle\('ledger'\)[\s\S]*?invite\.sharePath\(room\.code, 'ledger'\)/, "ledger must share its explicit invite type");
assert.ok(!/onShareAppMessage\(\)[\s\S]*?room\.name[\s\S]*?invite\.sharePath/.test(midpointShareSource), "midpoint share titles must not expose a user-controlled room name");
assert.ok(!/onShareAppMessage\(\)[\s\S]*?room\.name[\s\S]*?invite\.sharePath/.test(ledgerShareSource), "ledger share titles must not expose a user-controlled room name");
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
assert.match(homePageSource, /wechatLoginVisible:\s*false/, "home must render before showing any WeChat login prompt");
assert.match(homeMarkup, /登录后使用多人协作[\s\S]*?暂不登录/, "deferred WeChat login must be optional and cancellable");
assert.match(homeMarkup, /privacyConsentChecked[\s\S]*?《用户服务协议》[\s\S]*?《隐私保护指引》/, "login must expose an unchecked agreement choice and readable policy links");
assert.match(homePageSource, /confirmWechatLogin\(\)[\s\S]*?!this\.data\.privacyConsentChecked[\s\S]*?ensurePrivacyAuthorized\(\)[\s\S]*?grantAccountConsent\(\)[\s\S]*?ensureAccountScope\(\)[\s\S]*?loadProfile\(\)/, "WeChat login must require active consent and native privacy authorization before binding the trusted account");
assert.match(homePageSource, /togglePrivacyConsent\(\)[\s\S]*?!this\.data\.serviceAgreementOpened\s*\|\|\s*!this\.data\.privacyContractOpened[\s\S]*?privacyConsentChecked/, "the agreement checkbox must remain unavailable until both documents are opened");
assert.match(homePageSource, /openServiceAgreement\(\)[\s\S]*?serviceAgreementOpened:\s*true[\s\S]*?openPrivacy\(\)[\s\S]*?privacyContractOpened:\s*true/, "the login flow must record explicit opening of both documents");
assert.ok(!/wechatProfileConfirming/.test(homePageSource + homeMarkup), "login must not force avatar or nickname confirmation");
assert.match(homeMarkup, /不会获取手机号[\s\S]*?不会自动读取头像或昵称/, "login must accurately explain that phone and profile fields are not read automatically");
assert.ok(!/getPhoneNumber|open-type="getPhoneNumber"/.test(homePageSource + homeMarkup), "home must never request a phone number");
assert.match(homePageSource, /openProfilePanel\(\)[\s\S]*?requestWechatLogin\([\s\S]*?profilePanelOpen:\s*true/, "profile editing must only appear after the user explicitly opens the account entry");
assert.match(appSource, /applyAccountProfile\(profile\)[\s\S]*?storage\.setAccountScope\(nextProfile\)[\s\S]*?globalData\.accountProfile = nextProfile/, "saved profile changes must refresh the global trusted-account cache");
assert.match(appSource, /accountConsentGranted:\s*false[\s\S]*?ensureAccountScope\(\)[\s\S]*?!this\.hasAccountConsent\(\)[\s\S]*?Promise\.reject/, "CloudBase identity must not initialize before active login consent");
assert.match(homePageSource, /loadProfile\(\)[\s\S]*?!app\.hasAccountConsent\(\)[\s\S]*?请先阅读协议并主动登录/, "profile loading must reject attempts that bypass the login consent flow");
assert.match(homePageSource, /retryProfile\(\)[\s\S]*?resetAccountScope\(\)[\s\S]*?requestWechatLogin\(\)/, "a failed profile retry must return through the unchecked consent flow");
assert.match(homePageSource, /gateway\.updateProfile\([\s\S]*?applyAccountProfile\(profile\)/, "saving a profile must refresh the account cache with the server result");
assert.match(homePageSource, /isAmbiguousProfileUpdateError[\s\S]*?gateway\.getProfile\(\)[\s\S]*?latestProfile\.avatarFileId[\s\S]*?PROFILE_UPDATE_UNCONFIRMED/, "ambiguous avatar updates must reconcile before any cleanup");
assert.match(homePageSource, /cleanupUploadedOnFailure\s*\?[\s\S]*?deleteUnsavedAvatarUpload\(uploadedFileId\)[\s\S]*?头像已保留，避免损坏云端资料/, "an unconfirmed avatar update must preserve the uploaded file");
assert.match(homePageSource, /ensurePrivacyAuthorized\(\)[\s\S]*?wx\.getPrivacySetting[\s\S]*?wx\.requirePrivacyAuthorize/, "explicit account entry must use WeChat's current privacy authorization flow when required");

const appConfig = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
assert.ok(appConfig.pages.includes("pages/agreement/index"), "the readable user service agreement must be registered as a page");
const agreementMarkup = fs.readFileSync(path.join(root, "pages", "agreement", "index.wxml"), "utf8");
const agreementSource = fs.readFileSync(path.join(root, "pages", "agreement", "index.js"), "utf8");
for (const topic of ['用户服务协议', '登录与权限', '共同使用', '隐私', '账号', '账目']) assert.ok(agreementSource.includes(topic), `the service agreement must explain ${topic}`);
assert.match(agreementMarkup, /wx:for="\{\{sections\}\}"/, "agreement page must render the readable policy sections");

const tripsPageSource = fs.readFileSync(path.join(root, "pages", "trips", "index.js"), "utf8");
const tripsMarkup = fs.readFileSync(path.join(root, "pages", "trips", "index.wxml"), "utf8");
assert.match(tripsPageSource, /gateway\.listMyRooms\(null, 50\)/, "trips must load the caller's first cloud room page");
assert.match(tripsPageSource, /gateway\.listMyRooms\(cursor, 50\)/, "trips must load additional cloud room pages by cursor");
assert.match(tripsPageSource, /cursor\.createdAt/, "trips must validate immutable creation-time cursors");
assert.match(tripsPageSource, /myRoomsRequestId/, "trips must ignore stale room-list responses");
assert.ok(!/storage\.all\(/.test(tripsPageSource), "trips must not display shared-device room caches");
assert.match(tripsPageSource, /storage\.getLocal\(LOCAL_LEDGER_TRIPS_KEY/, "trips must read the current guest/account local namespace");
assert.match(tripsPageSource, /storage\.setLocal\(LOCAL_LEDGER_TRIPS_KEY/, "deleting a local trip must use the current guest/account local namespace");
assert.match(tripsPageSource, /ensureAccountScope/, "trips must wait for the authenticated account scope before cloud data");
assert.match(tripsPageSource, /onShow\(\)[\s\S]*?hasAccountConsent\(\)[\s\S]*?!consentGranted\s*\|\|\s*!storage\.isAccountScoped\(\)[\s\S]*?loginRequired:\s*true[\s\S]*?return[\s\S]*?this\.refresh\(\)/, "opening the trips tab must not silently establish a cloud identity before consent");
assert.match(tripsMarkup, /登录后同步云端房间[\s\S]*?首次进入不会自动登录[\s\S]*?本机账本无需登录[\s\S]*?返回首页登录/, "the signed-out trips state must defer cloud login while retaining device ledgers");
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
assert.match(midpointPageSource, /consentGranted[\s\S]*?出发点草稿仅保存在本机[\s\S]*?else\s*\{[\s\S]*?ensureAccountScope\(\)/, "midpoint must remain usable with guest local drafts without silently creating a cloud identity");
assert.match(midpointPageSource, /create\(\)[\s\S]*?!this\.scopeReady[\s\S]*?创建房间前请返回首页登录/, "guest midpoint creation must explicitly defer login");
assert.match(midpointPageSource, /function currentDecision\(/, "midpoint must normalize decision state before rendering");
assert.match(midpointPageSource, /membershipEpoch:\s*viewer\.membershipEpoch/, "decision writes must carry membershipEpoch");
assert.match(midpointPageSource, /recoverPendingPointDraft\(pending[\s\S]*?mineDraftDirty\s*=\s*true/, "invalidated meetup writes must remain as an editable local draft");
assert.match(midpointPageSource, /if \(!result\.room\)[\s\S]*?recoverPendingPointDraft\(pending/, "an ended room must preserve an unsynced meetup point as a local draft");
assert.match(midpointPageSource, /roundId:\s*decision\.roundId/, "decision writes must carry the current roundId");
assert.match(midpointPageSource, /\['STALE_MEMBERSHIP', 'STALE_DECISION', 'DECISION_CONFIRMED', 'CANDIDATE_NOT_FOUND'\]/, "stale or confirmed decision writes must refresh room state");
assert.match(midpointPageSource, /wx\.openLocation\([\s\S]*?共同候选地点/, "decision candidates must be openable in the map");
assert.match(midpointMarkup, /从微信地图添加/, "midpoint must let members add a map-selected candidate");
assert.match(midpointMarkup, /data-value="want"[\s\S]*?data-value="ok"[\s\S]*?data-value="no"/, "midpoint must expose all vote choices");
assert.match(midpointMarkup, /重新选择共同去处/, "owners must be able to reopen a confirmed decision");
assert.match(midpointMarkup, /几何参考点，实际路程可能不同/, "the fair-midpoint result must be paired with an accuracy disclaimer");
assert.match(midpointPageSource, /LOCAL_MIDPOINT_KEY/, "midpoint must preserve standalone multi-address work locally");
assert.match(midpointPageSource, /chooseLocalPoint\(event\)/, "standalone midpoint must let each address be selected from the native map");
assert.match(midpointPageSource, /if \(!amap\.configuredKey\(\)\)[\s\S]*?this\.addDecisionCandidate\(\)/, "room candidate search must fall back to native map selection when AMap is unavailable");
assert.match(midpointPageSource, /startSwipe\(\)[\s\S]*?swipeAction\(event\)/, "midpoint must expose the same candidate blind-box flow as Web");
assert.match(midpointPageSource, /const MAX_LOCAL_POINTS = 6/, "standalone midpoint must cap the people list at six like Web");
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
  localScopeToken() { return 'test-scope'; },
  setLocal(key, value) {
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
assert.equal(defaultLocalPoints.length, 2, "standalone midpoint must start with two departure rows like Web");
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
assert.equal(migratedLegacy.points.length, 2, "untouched legacy two-row drafts must retain the two-person Web default");
assert.equal(migratedLegacy.points[0].avatarFileId, "cloud://avatar", "the current user's saved avatar must decorate the first row");
const deliberateBlankFriend = localPointTest.validLocalState({ points: [
  { id: "local-self", isSelf: true, label: "我", address: "", lat: null, lng: null },
  { id: "local-friend-1", isSelf: false, label: "朋友 B", address: "", lat: null, lng: null }
] }, {});
assert.equal(deliberateBlankFriend.points.length, 2, "a deliberately-added blank friend must survive page reload");
assert.equal(deliberateBlankFriend.points[1].initial, "B", "the first added friend must be B");

function createMidpointContext(points) {
  const context = Object.assign({}, midpointPageDefinition);
  context.data = Object.assign({}, midpointPageDefinition.data, {
    localPoints: points,
    localCandidates: [],
    localCalculated: false,
    center: null,
    markers: [],
    mapSearchMessage: ''
  });
  context.localScope = 'test-scope';
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
assert.equal(Array.from(midpointBehavior.data.localPoints, (point) => point.initial).join(','), "我,B,C", "the first add action must append C after the two default rows");
midpointBehavior.addLocalPoint();
midpointBehavior.addLocalPoint();
assert.equal(Array.from(midpointBehavior.data.localPoints, (point) => point.initial).join(','), "我,B,C,D,E", "friend additions must remain sequential through E");
midpointBehavior.removeLocalPoint({ currentTarget: { dataset: { id: midpointBehavior.data.localPoints[1].id } } });
assert.equal(Array.from(midpointBehavior.data.localPoints, (point) => point.initial).join(','), "我,B,C,D", "deleting a middle friend must renumber the remaining friends");
const latestMidpointWrite = midpointStorageWrites[midpointStorageWrites.length - 1];
assert.ok(latestMidpointWrite && latestMidpointWrite.key === "pintu-local-midpoint-v2", "local people changes must use the guest/account local namespace");
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
assert.match(midpointMarkup, /让盲盒替你选/, "midpoint must render the destination blind-box entry");

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
assert.match(ledgerPageSource, /consentGranted[\s\S]*?if \(!this\.docId\)[\s\S]*?this\.guestMode = !consentGranted[\s\S]*?emptyLocalLedger\(\)/, "ledger must initialize a guest/account device book before cloud login");
assert.match(ledgerPageSource, /syncLedger\(next\)[\s\S]*?!this\.docId[\s\S]*?saveLocalLedger\(this\.tripId, next\)/, "guest and account local edits must save without creating a cloud identity");
assert.match(ledgerMarkup, /保存在这台设备/, "ledger must explain device-local persistence");
assert.match(ledgerPageSource, /LOCAL_LEDGER_TRIPS_KEY/, "ledger must support persistent standalone trips");
assert.match(ledgerPageSource, /newTripId\(/, "new standalone ledgers must receive a distinct trip ID");
assert.match(ledgerPageSource, /options && options\.tripId/, "a standalone trip must be reopenable by tripId");
assert.match(ledgerPageSource, /storage\.getLocal\(LOCAL_LEDGER_TRIPS_KEY/, "standalone ledger reads must use the isolated local namespace");
assert.match(ledgerPageSource, /storage\.setLocal\(LOCAL_LEDGER_TRIPS_KEY/, "standalone ledger writes must use the isolated local namespace");
assert.match(ledgerPageSource, /hasLocalTripContent/, "blank standalone ledger shells must not be retained in the trip list");
assert.match(ledgerPageSource, /if \(!saveLocalLedger\(this\.tripId, next\)\)/, "local ledger storage failures must not be reported as saved");
assert.match(ledgerPageSource, /syncLedger\(next\)[\s\S]*?if \(!this\.docId\)[\s\S]*?saveLocalLedger[\s\S]*?ensureAccountScope\(\)[\s\S]*?viewerMembershipEpoch\(\)/, "ledger must require authenticated account scope for cloud writes after handling local edits");
assert.match(ledgerPageSource, /localScope !== storage\.localScopeToken\(\)/, "stale device drafts must not be written into a changed account namespace");
assert.ok(!/pintu-local-ledger-v3/.test(ledgerPageSource), "ledger must not migrate or expose the legacy shared-device local key");
assert.match(ledgerPageSource, /gateway\.syncLedger\(snapshot\.docId, next, this\.viewerMembershipEpoch\(\)\)/, "direct shared ledger writes must bind their original room and membership epoch");
assert.match(ledgerPageSource, /gateway\.syncLedger\(docId, entry\.ledger, membershipEpoch\)/, "outbox writes must bind their original room, payload and membership epoch");
assert.match(ledgerPageSource, /fromRemote && this\.data\.editingId && !\(source\.expenses \|\| \[\]\)\.some/, "a remotely deleted expense must exit the mini-program edit form");
assert.match(ledgerPageSource, /editingId && !editing[\s\S]*?重新添加/, "saving a stale mini-program edit must not recreate a removed expense");
assert.match(ledgerPageSource, /if \(this\.docId && member\.uid\)/, "only real shared-room members, not local history members, are protected from rename/delete");
assert.match(ledgerPageSource, /entry\.blocked[\s\S]*?同步冲突，待修改/, "blocked ledger outbox entries must show a recoverable conflict state");
assert.match(ledgerPageSource, /function isNonRetryableLedgerError/, "ledger must classify permanent gateway failures");
assert.ok(!/restoreRoomSnapshot\(docId, previousSnapshot\)/.test(ledgerPageSource), "uncertain room exits must not roll back the newest snapshot");
assert.match(ledgerMarkup, /同行的人[\s\S]*?记支出[\s\S]*?谁转给谁/, "ledger must retain the Web three-step workflow");
assert.match(ledgerMarkup, /(?:bind|catch)tap="editExpense"/, "existing expenses must be editable");
assert.match(ledgerMarkup, /最少转账方案/, "ledger must render final settlement instructions");
assert.match(ledgerMarkup, /active-room-actions[\s\S]*?copyCode[\s\S]*?open-type="share"[\s\S]*?exitRoom/, "ledger room actions must stay in a dedicated compact row");
assert.match(appStyles, /\.active-room-main\s*\{[^}]*width\s*:\s*0[^}]*flex\s*:\s*1 1 auto/, "room copy must retain usable width on iPhone");
assert.match(appStyles, /\.active-room-label\s*\{[^}]*text-overflow\s*:\s*ellipsis[^}]*white-space\s*:\s*nowrap/, "room label must not wrap one character per line");
assert.match(appStyles, /\.active-room-actions \.text-action\s*\{[^}]*min-width\s*:\s*34px/, "room action buttons must retain a compact minimum width");

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
assert.match(spinnerPageSource, /wheelRotation:\s*startAngle[\s\S]*?\},\s*\(\)\s*=>\s*\{[\s\S]*?this\.spinStartTimer\s*=\s*setTimeout\(\(\)\s*=>\s*this\.startSpin\(plan\)/, "spinner must commit its starting frame before beginning the iOS transition");
assert.match(spinnerPageSource, /wx\.canvasToTempFilePath\([\s\S]*?wheelImage:\s*result\.tempFilePath/, "spinner must rasterize its canvas before animation so iOS never transforms a native canvas layer");
assert.match(spinnerPageSource, /wx\.createAnimation\([\s\S]*?transformOrigin:\s*['"]50% 50%['"][\s\S]*?animation\.rotate\(plan\.targetAngle\)\.step\(\)/, "spinner must use a native animation with an explicit center origin");
assert.ok(!/getStorageSync|setStorageSync|pintu-spinner-v3/.test(spinnerPageSource), "spinner must stay session-only like Web and never leak a prior account's list");
assert.match(spinnerMarkup, /wheel-pointer[\s\S]*?wheel-rotor[\s\S]*?wheel-center/, "spinner must render a pointer, animated rotor, and center control");
assert.match(spinnerMarkup, /width="\{\{canvasSize\}\}" height="\{\{canvasSize\}\}"/, "native canvas markup must bind the viewport-matched buffer");
assert.match(spinnerMarkup, /wheel-render-canvas[\s\S]*?wheel-rotor"[^>]*animation="\{\{wheelAnimation\}\}"[\s\S]*?<image/, "the visible wheel must be an image animated separately from the offscreen canvas");
assert.doesNotMatch(spinnerMarkup, /wheel-rotor"[^>]*style="[^"]*(?:transition|transform)/, "the visible wheel must use native animation rather than inline CSS transitions");

assert.match(midpointPageSource, /typeof wx\.chooseLocation !== ['"]function['"]/, "midpoint must guard unsupported native map APIs");
assert.match(midpointPageSource, /translateX\(\$\{delta\}px\)/, "blind-box drag distance must use the same pixel unit as touch coordinates");

const readmeSource = fs.readFileSync(path.join(root, "..", "README.md"), "utf8");
assert.match(
  readmeSource,
  /Join the same protected room from the web application or WeChat Mini Program with an eight-character invitation code/,
  "documentation must describe Web/mini-program room interoperability"
);

console.log(`Native miniprogram checks passed (${jsonFiles.length} JSON files, ${jsFiles.length} JavaScript files).`);

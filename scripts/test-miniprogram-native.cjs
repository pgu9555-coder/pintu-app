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

const tripsPageSource = fs.readFileSync(path.join(root, "pages", "trips", "index.js"), "utf8");
const tripsMarkup = fs.readFileSync(path.join(root, "pages", "trips", "index.wxml"), "utf8");
assert.match(tripsPageSource, /gateway\.listMyRooms\(null, 50\)/, "trips must load the caller's first cloud room page");
assert.match(tripsPageSource, /gateway\.listMyRooms\(cursor, 50\)/, "trips must load additional cloud room pages by cursor");
assert.match(tripsPageSource, /cursor\.createdAt/, "trips must validate immutable creation-time cursors");
assert.match(tripsPageSource, /myRoomsRequestId/, "trips must ignore stale room-list responses");
assert.ok(!/storage\.all\(/.test(tripsPageSource), "trips must not display shared-device room caches");
assert.match(tripsPageSource, /storage\.save\(\{ docId: entry\.docId, room: entry\.room \}\)/, "opening a trusted cloud room may refresh its local cache");
assert.match(tripsPageSource, /cloudError/, "trips must retain a clear cloud-load error state");
assert.match(tripsMarkup, /正在同步你的云端房间/, "trips must render a cloud loading state");
assert.match(tripsMarkup, /cloudError/, "trips must render cloud-load failures");
assert.match(tripsMarkup, /加载更多/, "trips must offer paginated room recovery");

const midpointPageSource = fs.readFileSync(path.join(root, "pages", "midpoint", "index.js"), "utf8");
const midpointMarkup = fs.readFileSync(path.join(root, "pages", "midpoint", "index.wxml"), "utf8");
assert.match(midpointPageSource, /function currentDecision\(/, "midpoint must normalize decision state before rendering");
assert.match(midpointPageSource, /membershipEpoch:\s*viewer\.membershipEpoch/, "decision writes must carry membershipEpoch");
assert.match(midpointPageSource, /roundId:\s*decision\.roundId/, "decision writes must carry the current roundId");
assert.match(midpointPageSource, /\['STALE_MEMBERSHIP', 'STALE_DECISION', 'DECISION_CONFIRMED', 'CANDIDATE_NOT_FOUND'\]/, "stale or confirmed decision writes must refresh room state");
assert.match(midpointPageSource, /wx\.openLocation\([\s\S]*?共同候选地点/, "decision candidates must be openable in the map");
assert.match(midpointMarkup, /从地图添加候选地点/, "midpoint must let members add a map-selected candidate");
assert.match(midpointMarkup, /data-value="want"[\s\S]*?data-value="ok"[\s\S]*?data-value="no"/, "midpoint must expose all vote choices");
assert.match(midpointMarkup, /重新选择共同去处/, "owners must be able to reopen a confirmed decision");
assert.ok(!/公平中点/.test(midpointPageSource + midpointMarkup), "midpoint copy must describe a reference midpoint, not a guaranteed fair route midpoint");

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
  { from: "Bob", to: "Alice", cents: 233 },
  { from: "Carol", to: "Alice", cents: 333 }
], "ledger settlements must reconcile every balance");

console.log(`Native miniprogram checks passed (${jsonFiles.length} JSON files, ${jsFiles.length} JavaScript files).`);

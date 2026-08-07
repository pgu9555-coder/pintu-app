const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

let context = { OPENID: "openid-a", APPID: "appid-a" };
let providerBody = { status: "1", tips: [{ id: "tip-1", name: "Coffee", district: "District", address: "Road", location: "114.1,22.5" }] };
let lastRequest = null;

const fakeHttps = {
  request(options, callback) {
    lastRequest = options;
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = (error) => process.nextTick(() => request.emit("error", error));
    request.end = () => process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      callback(response);
      response.emit("data", JSON.stringify(providerBody));
      response.emit("end");
    });
    return request;
  }
};
const fakeWx = { DYNAMIC_CURRENT_ENV: Symbol("env"), init() {}, getWXContext() { return context; } };
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "node:https") return fakeHttps;
  if (request === "wx-server-sdk") return fakeWx;
  return originalLoad.call(this, request, parent, isMain);
};
const gatewayPath = path.join(__dirname, "..", "cloudfunctions", "mapGateway", "index.js");
delete require.cache[require.resolve(gatewayPath)];
const gateway = require(gatewayPath);
Module._load = originalLoad;

const gatewaySource = fs.readFileSync(gatewayPath, "utf8");
assert.doesNotMatch(gatewaySource, /console\.(?:log|info|warn|error)/, "gateway must not log search text or raw coordinates");

async function run() {
  const previousKey = process.env.AMAP_WEB_SERVICE_KEY;
  process.env.AMAP_WEB_SERVICE_KEY = "0123456789abcdef";

  context = null;
  assert.equal((await gateway.main({ action: "inputTips", keywords: "coffee" })).code, "UNAUTHORIZED");
  context = { OPENID: "openid-a", APPID: "appid-a" };
  assert.equal((await gateway.main({ action: "delete", path: "/anything" })).code, "INVALID_ACTION");
  const platformDecorated = await gateway.main({ action: "inputTips", keywords: "coffee", key: "attacker", userInfo: { openId: "forged" } });
  assert.equal(platformDecorated.ok, true, "CloudBase-added event metadata must not invalidate an otherwise safe request");
  assert.doesNotMatch(lastRequest.path, /attacker|forged/, "untrusted extra fields must never reach the provider request");
  assert.match(lastRequest.path, /key=0123456789abcdef/, "the provider key must always come from the server environment");
  assert.equal((await gateway.main({ action: "nearby", latitude: 91, longitude: 0 })).code, "INVALID_INPUT");
  gateway._private.rateBuckets.clear();
  for (let index = 0; index < 30; index += 1) assert.equal(gateway._private.allowRequest("caller", "inputTips", 100), true);
  assert.equal(gateway._private.allowRequest("caller", "inputTips", 100), false, "per-identity request limits must reject bursts");

  providerBody = { status: "1", tips: [
    { id: "tip-1", name: "Coffee", district: "District", address: "Road", location: "114.1,22.5" },
    { id: "bad", name: "Bad", location: "not-a-point" }
  ] };
  const tips = await gateway.main({ action: "inputTips", keywords: "coffee" });
  assert.equal(tips.ok, true);
  assert.deepEqual(tips.data, [{ id: "tip-1", name: "Coffee", address: "District Road", lat: 22.5, lng: 114.1 }]);
  assert.equal(lastRequest.hostname, "restapi.amap.com");
  assert.match(lastRequest.path, /^\/v3\/assistant\/inputtips\?/);
  assert.match(lastRequest.path, /keywords=coffee/);

  providerBody = { status: "1", pois: [{ id: "poi-1", name: "Cafe", location: "114,22", address: "Road", type: "餐饮", tel: "123", biz_ext: { rating: "4.5", cost: "30" } }] };
  const nearby = await gateway.main({ action: "nearby", latitude: 22, longitude: 114 });
  assert.equal(nearby.ok, true);
  assert.equal(nearby.data[0].id, "amap-poi-1");
  assert.equal(nearby.data[0].lat, 22);
  assert.match(lastRequest.path, /^\/v3\/place\/around\?/);
  assert.match(lastRequest.path, /radius=5000/);

  providerBody = { status: "0", info: "USERKEY_PLAT_NOMATCH", infocode: "10009" };
  const rejectedProviderRequest = await gateway.main({ action: "inputTips", keywords: "coffee" });
  assert.equal(rejectedProviderRequest.ok, false, "provider errors must not be misreported as an empty successful result");
  assert.equal(rejectedProviderRequest.code, "UPSTREAM_UNAVAILABLE");

  delete process.env.AMAP_WEB_SERVICE_KEY;
  assert.equal((await gateway.main({ action: "inputTips", keywords: "tea" })).code, "CONFIGURATION");
  if (previousKey === undefined) delete process.env.AMAP_WEB_SERVICE_KEY;
  else process.env.AMAP_WEB_SERVICE_KEY = previousKey;
  console.log("Map gateway checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });

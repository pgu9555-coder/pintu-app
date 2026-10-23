const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

let context = { OPENID: "openid-a", APPID: "appid-a" };
let providerBody = { status: "1", tips: [{ id: "tip-1", name: "Coffee", district: "District", address: "Road", location: "114.1,22.5" }] };
let lastRequest = null;
let providerResolver = null;
let providerMode = "normal";
const requests = [];

const fakeHttps = {
  request(options, callback) {
    lastRequest = options;
    requests.push(options);
    const request = new EventEmitter();
    let timeout;
    request.setTimeout = (ms, callback) => { assert.equal(ms, 5000); timeout = callback; };
    request.destroy = (error) => process.nextTick(() => request.emit("error", error));
    request.end = () => process.nextTick(() => {
      if (providerMode === "timeout") { timeout(); return; }
      const response = new EventEmitter();
      response.statusCode = providerMode === "http-error" ? 503 : 200;
      response.setEncoding = () => {};
      callback(response);
      response.emit("data", providerMode === "oversize" ? "x".repeat(512 * 1024 + 1) : providerMode === "malformed" ? "bad-json" : JSON.stringify(providerResolver ? providerResolver(options) : providerBody));
      response.emit("end");
    });
    return request;
  }
};
const quotaRecords = new Map();
const fakeCloudbase={SYMBOL_CURRENT_ENV:Symbol('env'),init(){return{database(){return{async runTransaction(fn){return fn({collection(){return{doc(id){return{async get(){return{data:quotaRecords.get(id)||null}},async set(value){quotaRecords.set(id,value);return{set:1}}}}}}})}}}}}};
const fakeWx = { DYNAMIC_CURRENT_ENV: Symbol("env"), init() {}, getWXContext() { return context; } };
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "node:https") return fakeHttps;
  if (request === "wx-server-sdk") return fakeWx;
  if (request === "@cloudbase/node-sdk") return fakeCloudbase;
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
  context={OPENID:'quota-check',APPID:'appid-a'};
  for(let i=0;i<30;i++)assert.equal((await gateway.main({action:'inputTips',keywords:'coffee'})).ok,true);
  delete require.cache[require.resolve(gatewayPath)];
  Module._load=function(request,parent,isMain){if(request==='node:https')return fakeHttps;if(request==='wx-server-sdk')return fakeWx;if(request==='@cloudbase/node-sdk')return fakeCloudbase;return originalLoad.call(this,request,parent,isMain)};
  const coldGateway=require(gatewayPath);Module._load=originalLoad;
  assert.equal((await coldGateway.main({action:'inputTips',keywords:'coffee'})).code,'RATE_LIMITED','a new instance must share the persisted quota');
  context={OPENID:'openid-a',APPID:'appid-a'};

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
  assert.match(lastRequest.path, /radius=3000/);

  // New actions keep fixed upstreams and never forward caller key/type/radius.
  for (const action of ["detail", "categories", "categoryPage"]) {
    context = null;
    assert.equal((await gateway.main({ action, latitude: 22, longitude: 114 })).code, "UNAUTHORIZED");
  }
  context = { OPENID: "parity-user", APPID: "appid-a" };
  const center = { latitude: 22, longitude: 114 };
  const beforeInvalid = requests.length;
  for (const event of [
    { action: "detail", ...center, poiId: "https://bad.example/path" },
    { action: "detail", ...center, name: "" },
    { action: "categories", ...center, isMall: "true", isDrink: false },
    { action: "categoryPage", ...center, category: "__proto__", page: 1 },
    { action: "categoryPage", ...center, category: "food", page: 0 },
    { action: "categoryPage", ...center, category: "food", page: 5 },
    { action: "categoryPage", ...center, category: "food", page: 1.5 },
    { action: "categories", latitude: "22", longitude: 114, isMall: true, isDrink: false }
  ]) assert.equal((await gateway.main(event)).code, "INVALID_INPUT");
  assert.equal(requests.length, beforeInvalid, "invalid actions never spend provider requests");
  assert.equal(gateway._private.location("114,"), null, "blank provider coordinates must not become zero");
  assert.equal(gateway._private.location("114,22,1"), null);

  const poi = (id, name, delta, type = "餐饮服务") => ({ id, name, location: `${114 + delta},22`, address: "Road", type, tel: "123", biz_ext: { rating: "4.5", cost: "30" }, secret: "must-strip" });
  providerResolver = (options) => {
    const url = new URL(options.path, "https://restapi.amap.com");
    if (url.searchParams.get("radius") === "8000") return { status: "1", pois: [poi("Mfar", "远商圈", .04, "购物中心"), poi("Mnear", "近商圈", .01, "购物中心"), poi("Mmid", "中商圈", .02, "购物中心"), poi("M4", "第四商圈", .05, "购物中心"), poi("bad", "便利超市", .001)] };
    return { status: "1", pois: [poi("Mnear", "近商圈", .01), ...Array.from({ length: 10 }, (_, index) => poi(`F${index}`, index === 0 ? "咖啡" : `饭店${index}`, .001 * (index + 1))), poi("bad-food", "药店", 0)] };
  };
  const nearbyStart = requests.length;
  const parityNearby = await gateway.main({ action: "nearby", ...center, radius: 99999, types: "attacker", key: "client-key" });
  assert.equal(parityNearby.ok, true);
  assert.equal(parityNearby.data.length, 11);
  assert.deepEqual(parityNearby.data.slice(0, 3).map((item) => item.name), ["近商圈", "中商圈", "远商圈"]);
  assert.equal(parityNearby.data[3].isDrink, true);
  assert.equal(parityNearby.data[4].isDrink, false, "ordinary restaurants are not drinks");
  assert.ok(parityNearby.data.slice(0, 3).every((item) => item.isMall));
  assert.ok(parityNearby.data.slice(3).every((item) => !item.isMall));
  assert.equal(new Set(parityNearby.data.map((item) => item.id)).size, 11, "cross-query duplicates are removed");
  const nearbyRequests = requests.slice(nearbyStart).map((request) => new URL(request.path, "https://restapi.amap.com"));
  assert.deepEqual(nearbyRequests.map((url) => url.searchParams.get("radius")), ["8000", "3000"]);
  assert.deepEqual(nearbyRequests.map((url) => url.searchParams.get("offset")), ["20", "25"]);
  assert.equal(nearbyRequests[0].searchParams.get("types"), "商场", "REST uses the canonical category name rather than a JS SDK alias");
  assert.ok(nearbyRequests.every((url) => !url.href.includes("attacker") && !url.href.includes("client-key")));

  providerResolver = () => ({ status: "1", count: "250", pois: [
    { ...poi("B0VALID", "Cafe", 0, "咖啡厅"), photos: [
      { url: "https://store.is.autonavi.com/photo.jpg" }, { url: "http://store.is.autonavi.com/insecure.jpg" },
      { url: "https://evil.example/secret.jpg" }, { url: "https://store.is.autonavi.com/photo.jpg?key=private" },
      { url: "https://aos-cdn-image.amap.com/photo2.jpg" }
    ] }
  ] });
  const detail = await gateway.main({ action: "detail", ...center, poiId: "amap-B0VALID" });
  assert.equal(detail.ok, true); assert.equal(detail.data.poiId, "B0VALID");
  assert.equal(detail.data.photos.length, 2); assert.equal(detail.data.secret, undefined);
  assert.match(lastRequest.path, /^\/v3\/place\/detail\?/);
  assert.equal(new URL(lastRequest.path, "https://restapi.amap.com").searchParams.get("id"), "B0VALID");
  const fallbackDetail = await gateway.main({ action: "detail", ...center, name: "Cafe" });
  assert.equal(fallbackDetail.data.name, "Cafe");
  assert.equal(new URL(lastRequest.path, "https://restapi.amap.com").searchParams.get("radius"), "60");

  const categoryStart = requests.length;
  const categories = await gateway.main({ action: "categories", ...center, isMall: true, isDrink: false });
  assert.equal(categories.ok, true);
  assert.deepEqual(categories.data.map((item) => item.key), ["food", "drink", "leisure", "shopping"]);
  assert.ok(categories.data.every((item) => item.capped && item.maxPages === 4 && item.page === 1 && item.pageSize === 50 && item.total === 250));
  assert.equal(requests.length - categoryStart, 8);
  assert.ok(requests.slice(categoryStart).every((request) => new URL(request.path, "https://restapi.amap.com").searchParams.get("radius") === "400"));
  assert.equal(new URL(requests[categoryStart + 4].path, "https://restapi.amap.com").searchParams.get("types"), "体育休闲服务");
  const similar = await gateway.main({ action: "categories", ...center, isMall: false, isDrink: true });
  assert.equal(similar.data.length, 1); assert.equal(similar.data[0].key, "similarDrink");
  assert.equal(new URL(lastRequest.path, "https://restapi.amap.com").searchParams.get("radius"), "500");
  const fourth = await gateway.main({ action: "categoryPage", ...center, category: "food", page: 4, radius: 99999, types: "bad" });
  assert.equal(fourth.data.page, 4); assert.equal(fourth.data.capped, true); assert.equal(fourth.data.hasMore, false);
  const fourthUrl = new URL(lastRequest.path, "https://restapi.amap.com");
  assert.equal(fourthUrl.searchParams.get("page"), "8"); assert.equal(fourthUrl.searchParams.get("offset"), "25");
  assert.equal(fourthUrl.searchParams.get("types"), "餐饮服务"); assert.equal(fourthUrl.searchParams.get("radius"), "400");

  // Weighted global quota reserves all calls atomically, across actions.
  const quotaBefore = new Map([...quotaRecords].map(([key, value]) => [key, structuredClone(value)]));
  const previousDayLimit = process.env.MAP_REQUESTS_PER_DAY;
  quotaRecords.clear(); process.env.MAP_REQUESTS_PER_DAY = "3";
  const noBudgetStart = requests.length;
  assert.equal((await gateway.main({ action: "categories", ...center, isMall: true, isDrink: false })).code, "RATE_LIMITED");
  assert.equal(requests.length, noBudgetStart); assert.equal(quotaRecords.size, 0, "rejected multi-call budget cannot consume partial quota");
  assert.equal((await gateway.main({ action: "nearby", ...center })).ok, true, "two upstream calls cost two daily tokens");
  assert.equal((await gateway.main({ action: "detail", ...center, poiId: "B0VALID" })).ok, true);
  const usedBudgetRequests = requests.length;
  assert.equal((await gateway.main({ action: "inputTips", keywords: "tea" })).code, "RATE_LIMITED");
  assert.equal(requests.length, usedBudgetRequests, "exhausted daily quota blocks all action families");
  if (previousDayLimit === undefined) delete process.env.MAP_REQUESTS_PER_DAY; else process.env.MAP_REQUESTS_PER_DAY = previousDayLimit;
  quotaRecords.clear(); for (const [key, value] of quotaBefore) quotaRecords.set(key, value);

  providerResolver = () => ({ status: "1", count: "0", pois: [] });
  assert.equal((await gateway.main({ action: "detail", ...center, poiId: "B0VALID" })).data, null);
  assert.deepEqual((await gateway.main({ action: "categoryPage", ...center, category: "food", page: 1 })).data.pois, []);
  providerResolver = null;
  for (const mode of ["timeout", "http-error", "oversize", "malformed"]) {
    providerMode = mode;
    assert.equal((await gateway.main({ action: "detail", ...center, poiId: "B0VALID" })).code, "UPSTREAM_UNAVAILABLE", `${mode} must fail rather than return an empty success`);
  }
  providerMode = "normal";

  providerBody = { status: "0", info: "USERKEY_PLAT_NOMATCH", infocode: "10009" };
  const rejectedProviderRequest = await gateway.main({ action: "inputTips", keywords: "coffee" });
  assert.equal(rejectedProviderRequest.ok, false, "provider errors must not be misreported as an empty successful result");
  assert.equal(rejectedProviderRequest.code, "MAP_KEY_PLATFORM_MISMATCH", "a JavaScript API key used as a Web Service key must be diagnosable without exposing the key");
  assert.equal(gateway._private.publicProviderError({ providerCode: "10001" }), "MAP_KEY_INVALID");
  assert.equal(gateway._private.publicProviderError({ providerCode: "10003" }), "RATE_LIMITED");
  assert.equal(gateway._private.publicProviderError({ providerCode: "29999" }), "UPSTREAM_UNAVAILABLE");

  delete process.env.AMAP_WEB_SERVICE_KEY;
  assert.equal((await gateway.main({ action: "inputTips", keywords: "tea" })).code, "CONFIGURATION");
  if (previousKey === undefined) delete process.env.AMAP_WEB_SERVICE_KEY;
  else process.env.AMAP_WEB_SERVICE_KEY = previousKey;
  console.log("Map gateway checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });

"use strict";

const https = require("node:https");
const crypto = require("node:crypto");
const wxCloud = require("wx-server-sdk");
const cloudbase = require('@cloudbase/node-sdk');
const quota = require('./quota');
const db = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV }).database();

const PROVIDER_HOST = "restapi.amap.com";
const TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TIPS = 10;
const MAX_NEARBY = 11;
const PAGE_SIZE = 50;
const PROVIDER_PAGE_SIZE = 25;
const MAX_PAGES = 4;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMITS = { inputTips: 30, nearby: 20, detail: 30, categories: 10, categoryPage: 30 };
const CATEGORIES = Object.freeze({
  food: { label: "美食", types: "餐饮服务", radius: 400 },
  drink: { label: "饮料咖啡", types: "咖啡厅|茶艺馆|冷饮店", radius: 400 },
  leisure: { label: "休闲玩乐", types: "体育休闲服务", radius: 400 },
  shopping: { label: "购物", types: "购物服务", radius: 400 },
  similarFood: { label: "附近同类推荐", types: "餐饮服务", radius: 500 },
  similarDrink: { label: "附近同类推荐", types: "咖啡厅|茶艺馆|冷饮店", radius: 500 }
});
const PHOTO_HOSTS = new Set(["store.is.autonavi.com", "store.is.amap.com", "aos-cdn-image.amap.com"]);

wxCloud.init({ env: wxCloud.DYNAMIC_CURRENT_ENV });

function success(data) { return { ok: true, data }; }
function failure(code, message) { return { ok: false, code, message }; }

function callerIdentity() {
  try {
    const context = wxCloud.getWXContext() || {};
    const openid = typeof context.OPENID === "string" ? context.OPENID.trim() : "";
    const appid = typeof context.APPID === "string" ? context.APPID.trim() : "";
    return openid && appid ? `${appid}:${openid}` : null;
  } catch (_) {
    return null;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validText(value, min, max) {
  return typeof value === "string" && value === value.trim() && value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function validCoordinate(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validateEvent(event) {
  // CloudBase decorates function events with platform metadata. Read only the
  // explicit action fields below; all other client or platform fields are ignored.
  if (!isPlainObject(event) || typeof event.action !== "string") return failure("INVALID_INPUT", "地图请求无效");
  if (event.action === "inputTips") {
    if (!validText(event.keywords, 2, 80)) {
      return failure("INVALID_INPUT", "请输入 2 至 80 个字的地点关键词");
    }
    return { action: "inputTips", keywords: event.keywords };
  }
  if (["nearby", "detail", "categories", "categoryPage"].includes(event.action)) {
    if (!validCoordinate(event.latitude, -90, 90) || !validCoordinate(event.longitude, -180, 180)) {
      return failure("INVALID_INPUT", "地点坐标无效");
    }
    const input = { action: event.action, latitude: event.latitude, longitude: event.longitude };
    if (event.action === "nearby") return input;
    if (event.action === "detail") {
      const poiId = typeof event.poiId === "string" ? event.poiId.replace(/^amap-/, "") : "";
      if (event.poiId != null && event.poiId !== "" && (!poiId || !/^[A-Za-z0-9_-]{1,80}$/.test(poiId))) return failure("INVALID_INPUT", "地点编号无效");
      if (!poiId && !validText(event.name, 1, 80)) return failure("INVALID_INPUT", "请选择有效地点");
      return { ...input, poiId, name: validText(event.name, 1, 80) ? event.name : "" };
    }
    if (event.action === "categories") {
      if (typeof event.isMall !== "boolean" || typeof event.isDrink !== "boolean") return failure("INVALID_INPUT", "地点类别无效");
      return { ...input, isMall: event.isMall, isDrink: event.isDrink };
    }
    if (typeof event.category !== "string" || !Object.prototype.hasOwnProperty.call(CATEGORIES, event.category) || !Number.isSafeInteger(event.page) || event.page < 1 || event.page > MAX_PAGES) return failure("INVALID_INPUT", "分类或页码无效");
    return { ...input, category: event.category, page: event.page };
  }
  return failure("INVALID_ACTION", "不支持的地图操作");
}

function providerRequest(pathname, parameters) {
  const key = process.env.AMAP_WEB_SERVICE_KEY;
  if (!validText(key, 16, 256)) return Promise.reject(Object.assign(new Error("missing key"), { code: "CONFIGURATION" }));
  const query = new URLSearchParams({ key, ...parameters }).toString();
  return new Promise((resolve, reject) => {
    let timer, done = false;
    function finish(error, value) {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    }
    const request = https.request({ hostname: PROVIDER_HOST, path: `${pathname}?${query}`, method: "GET", headers: { Accept: "application/json" } }, (response) => {
      let size = 0;
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        size += Buffer.byteLength(chunk, "utf8");
        if (size > MAX_RESPONSE_BYTES) {
          const error = Object.assign(new Error("response too large"), { code: "UPSTREAM_UNAVAILABLE" });
          finish(error); request.destroy(error);
        }
        else body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode !== 200) return finish(Object.assign(new Error("provider status"), { code: "UPSTREAM_UNAVAILABLE" }));
        try { finish(null, JSON.parse(body)); } catch (_) { finish(Object.assign(new Error("provider JSON"), { code: "UPSTREAM_UNAVAILABLE" })); }
      });
      response.once("error", (error) => finish(error));
      response.once("aborted", () => finish(Object.assign(new Error("response aborted"), { code: "UPSTREAM_UNAVAILABLE" })));
    });
    function expire() {
      const error = Object.assign(new Error("timeout"), { code: "UPSTREAM_UNAVAILABLE" });
      finish(error); request.destroy(error);
    }
    timer = setTimeout(expire, TIMEOUT_MS);
    request.setTimeout(TIMEOUT_MS, expire);
    request.once("error", (error) => finish(error));
    request.end();
  });
}

function location(value) {
  const parts = typeof value === "string" ? value.split(",") : [];
  if (parts.length !== 2 || parts.some((part) => !part.trim())) return null;
  const [longitude, latitude] = parts.map(Number);
  return validCoordinate(latitude, -90, 90) && validCoordinate(longitude, -180, 180) ? { latitude, longitude } : null;
}

function text(value, maximum) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maximum) : "";
}

function distance(latitude, longitude, lat, lng) {
  const radians = Math.PI / 180;
  const a = Math.sin((lat - latitude) * radians / 2) ** 2 + Math.cos(latitude * radians) * Math.cos(lat * radians) * Math.sin((lng - longitude) * radians / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))));
}

function photos(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const photo of value.slice(0, 10)) {
    const raw = text(photo && photo.url, 2000);
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" && PHOTO_HOSTS.has(url.hostname) && !url.username && !url.password && !url.port &&
          !url.searchParams.has("key") && !url.searchParams.has("jscode") &&
          !result.some((item) => item.url === url.href)) result.push({ url: url.href });
    } catch (_) {}
    if (result.length === 3) break;
  }
  return result;
}

function normalizePoi(poi, index, center) {
  const point = location(poi && poi.location), name = text(poi && poi.name, 80);
  if (!point || !name) return null;
  const address = text(poi.address, 120), category = text(poi.type, 80);
  const business = isPlainObject(poi.biz_ext) ? poi.biz_ext : {};
  const sourceId = text(poi.id, 80);
  const poiId = /^[A-Za-z0-9_-]{1,80}$/.test(sourceId) ? sourceId : "";
  const isDrink = /冷饮|咖啡|茶艺|茶饮|奶茶|饮品/.test(category) || /奶茶|咖啡|茶饮/.test(name);
  return { id: `amap-${poiId || index}`, poiId, name, lat: point.latitude, lng: point.longitude,
    typeStr: [address.slice(0, 72), category.slice(0, 44)].filter(Boolean).join(" · ").slice(0, 120) || "附近地点",
    address, category, phone: text(poi.tel, 40), rating: text(business.rating, 16), averageCost: text(business.cost, 16),
    isMall: /购物中心|综合商场|商场/.test(category), isDrink, photos: photos(poi.photos),
    ...(center ? { dist: distance(center.latitude, center.longitude, point.latitude, point.longitude) } : {}) };
}

function normalizePois(body, limit, center) {
  if (!body || String(body.status) !== "1" || !Array.isArray(body.pois)) return [];
  return body.pois.slice(0, limit).map((poi, index) => normalizePoi(poi, index, center)).filter(Boolean);
}

function normalizeTips(body) {
  if (!body || String(body.status) !== "1" || !Array.isArray(body.tips)) return [];
  return body.tips.map((tip, index) => {
    const point = location(tip && tip.location);
    const name = text(tip && tip.name, 80);
    if (!point || !name) return null;
    const address = [text(tip.district, 60), text(tip.address, 100)].filter(Boolean).join(" ").slice(0, 120);
    return { id: text(tip.id, 80) || `tip-${index}`, name, address: address || name, lat: point.latitude, lng: point.longitude };
  }).filter(Boolean).slice(0, MAX_TIPS);
}

function normalizeNearby(body) {
  return normalizePois(body, MAX_NEARBY);
}

function categoryKeys(input) {
  return input.isMall ? ["food", "drink", "leisure", "shopping"] : [input.isDrink ? "similarDrink" : "similarFood"];
}

function requestCost(input) {
  if (input.action === "nearby" || input.action === "categoryPage") return 2;
  return input.action === "categories" ? categoryKeys(input).length * 2 : 1;
}

// Reserve actual upstream calls, not just client actions. Read every counter
// before writing so a rejected budget or transaction retry consumes nothing.
async function reserveQuota(transaction, identity, input, now = Date.now()) {
  const cost = requestCost(input);
  const rules = [
    { key: `map-user:${identity}:${input.action}`, windowMs: RATE_WINDOW_MS, limit: RATE_LIMITS[input.action], cost: 1 },
    { key: `map-user-provider:${identity}`, windowMs: RATE_WINDOW_MS, limit: 100, cost },
    { key: "map-global-day", windowMs: 86400000, limit: quota.positiveLimit("MAP_REQUESTS_PER_DAY", 10000), cost }
  ];
  const writes = [];
  for (const rule of rules) {
    const ref = transaction.collection("request_limits").doc(crypto.createHash("sha256").update(rule.key).digest("hex"));
    const result = await ref.get();
    if (result && result.code) throw new Error("Quota storage unavailable");
    const old = result && (Array.isArray(result.data) ? result.data[0] : result.data);
    const window = Math.floor(now / rule.windowMs);
    const count = old && old.window === window ? Number(old.count || 0) : 0;
    if (!Number.isSafeInteger(count) || count < 0 || count + rule.cost > rule.limit) return false;
    writes.push({ ref, value: { window, count: count + rule.cost, updatedAt: new Date(now), expiresAt: new Date(now + rule.windowMs * 2) } });
  }
  for (const row of writes) {
    const result = await row.ref.set(row.value);
    if (result && result.code) throw new Error("Quota storage unavailable");
  }
  return true;
}

async function around(input, types, radius, offset, page = 1, keywords = "") {
  return requireProviderSuccess(await providerRequest("/v3/place/around", {
    location: `${input.longitude.toFixed(6)},${input.latitude.toFixed(6)}`, types, radius: String(radius), offset: String(offset), page: String(page),
    extensions: "all", sortrule: "distance", ...(keywords ? { keywords } : {})
  }));
}

async function categoryPage(input, key, page) {
  const definition = CATEGORIES[key];
  // REST recommends <=25 rows per request. Keep the client-facing 50-row page
  // by fetching two fixed, bounded provider pages; both were charged upfront.
  const bodies = await Promise.all([0, 1].map((offset) => around(input, definition.types, definition.radius, PROVIDER_PAGE_SIZE, (page - 1) * 2 + offset + 1)));
  const seen = new Set();
  const pois = bodies.flatMap((body) => normalizePois(body, PROVIDER_PAGE_SIZE, input)).filter((poi) => {
    const id = poi.poiId || `${poi.name}:${poi.lat}:${poi.lng}`;
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });
  const count = Math.max(...bodies.map((body) => Number(body.count)));
  const total = Number.isSafeInteger(count) && count >= 0 ? count : (page - 1) * PAGE_SIZE + pois.length;
  return { key, label: definition.label, total, pois, page, pageSize: PAGE_SIZE, maxPages: MAX_PAGES,
    capped: total > PAGE_SIZE * MAX_PAGES, hasMore: page < MAX_PAGES && pois.length > 0 && total > page * PAGE_SIZE };
}

function requireProviderSuccess(body) {
  if (!body || String(body.status) !== "1") {
    const error = new Error("provider rejected request");
    error.code = "UPSTREAM_UNAVAILABLE";
    error.providerCode = text(body && body.infocode, 16);
    throw error;
  }
  return body;
}

function publicProviderError(error) {
  if (error && error.code === "CONFIGURATION") return "CONFIGURATION";
  const code = error && error.providerCode;
  if (code === "10001") return "MAP_KEY_INVALID";
  if (code === "10002") return "MAP_SERVICE_NOT_AVAILABLE";
  if (code === "10005") return "MAP_IP_RESTRICTED";
  if (code === "10009") return "MAP_KEY_PLATFORM_MISMATCH";
  if (["10003", "10004", "10029", "10044", "10045"].includes(code)) return "RATE_LIMITED";
  return "UPSTREAM_UNAVAILABLE";
}

async function main(event) {
  const identity = callerIdentity();
  if (!identity) return failure("UNAUTHORIZED", "请先登录后再使用地图搜索");
  const input = validateEvent(event);
  if (input && input.ok === false) return input;
  try {
    if (!await db.runTransaction(transaction => reserveQuota(transaction, identity, input), 5)) return failure('RATE_LIMITED', '地图搜索已达到上限，请稍后再试');
    if (input.action === "inputTips") {
      const body = requireProviderSuccess(await providerRequest("/v3/assistant/inputtips", {
        keywords: input.keywords,
        citylimit: "false",
        datatype: "all"
      }));
      return success(normalizeTips(body));
    }
    if (input.action === "nearby") {
      const [malls, foods] = await Promise.all([
        around(input, "商场", 8000, 20),
        around(input, "餐饮服务|咖啡厅|茶艺馆|冷饮店", 3000, 25)
      ]);
      const keep = (poi) => !/百果园|便利|超市|水果|生鲜|菜市场|药店|小卖部|五金/i.test(poi.name);
      const sort = (first, second) => first.dist - second.dist || first.name.localeCompare(second.name);
      const chosen = normalizePois(malls, 20, input).filter(keep).sort(sort).slice(0, 3).map((poi) => ({ ...poi, isMall: true, isDrink: false }));
      const maximum = chosen.length + 8;
      const ids = new Set(chosen.map((poi) => poi.poiId || `${poi.name}:${poi.lat}:${poi.lng}`));
      for (const poi of normalizePois(foods, 25, input).filter(keep).sort(sort)) {
        const key = poi.poiId || `${poi.name}:${poi.lat}:${poi.lng}`;
        if (ids.has(key)) continue;
        ids.add(key); chosen.push({ ...poi, isMall: false });
        if (chosen.length >= maximum) break;
      }
      return success(chosen.slice(0, MAX_NEARBY));
    }
    if (input.action === "detail") {
      const body = input.poiId
        ? requireProviderSuccess(await providerRequest("/v3/place/detail", { id: input.poiId, extensions: "all" }))
        : await around(input, "", 60, 5, 1, input.name);
      const pois = normalizePois(body, 5, input);
      return success(pois.find((poi) => input.poiId ? poi.poiId === input.poiId : poi.name === input.name) || pois[0] || null);
    }
    if (input.action === "categories") {
      return success(await Promise.all(categoryKeys(input).map((key) => categoryPage(input, key, 1))));
    }
    return success(await categoryPage(input, input.category, input.page));
  } catch (error) {
    return failure(
      publicProviderError(error),
      "地图搜索暂时不可用，请使用微信地图选点"
    );
  }
}

module.exports = { main, _private: { validateEvent, normalizeTips, normalizeNearby, normalizePoi, photos, location, requestCost, reserveQuota, requireProviderSuccess, publicProviderError } };

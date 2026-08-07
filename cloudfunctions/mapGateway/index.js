"use strict";

const https = require("node:https");
const wxCloud = require("wx-server-sdk");

const PROVIDER_HOST = "restapi.amap.com";
const TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TIPS = 10;
const MAX_NEARBY = 12;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMITS = { inputTips: 30, nearby: 20 };
const rateBuckets = new Map();

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
  if (event.action === "nearby") {
    if (!validCoordinate(event.latitude, -90, 90) || !validCoordinate(event.longitude, -180, 180)) {
      return failure("INVALID_INPUT", "地点坐标无效");
    }
    return { action: "nearby", latitude: event.latitude, longitude: event.longitude };
  }
  return failure("INVALID_ACTION", "不支持的地图操作");
}

function allowRequest(identity, action, now = Date.now()) {
  const key = `${identity}:${action}`;
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (bucket.count >= RATE_LIMITS[action]) return false;
  bucket.count += 1;
  return true;
}

function providerRequest(pathname, parameters) {
  const key = process.env.AMAP_WEB_SERVICE_KEY;
  if (!validText(key, 16, 256)) return Promise.reject(Object.assign(new Error("missing key"), { code: "CONFIGURATION" }));
  const query = new URLSearchParams({ key, ...parameters }).toString();
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: PROVIDER_HOST, path: `${pathname}?${query}`, method: "GET", headers: { Accept: "application/json" } }, (response) => {
      let size = 0;
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        size += Buffer.byteLength(chunk, "utf8");
        if (size > MAX_RESPONSE_BYTES) request.destroy(Object.assign(new Error("response too large"), { code: "UPSTREAM_UNAVAILABLE" }));
        else body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(Object.assign(new Error("provider status"), { code: "UPSTREAM_UNAVAILABLE" }));
        try { resolve(JSON.parse(body)); } catch (_) { reject(Object.assign(new Error("provider JSON"), { code: "UPSTREAM_UNAVAILABLE" })); }
      });
    });
    request.setTimeout(TIMEOUT_MS, () => request.destroy(Object.assign(new Error("timeout"), { code: "UPSTREAM_UNAVAILABLE" })));
    request.once("error", (error) => reject(error));
    request.end();
  });
}

function location(value) {
  const [longitude, latitude] = String(value || "").split(",").map(Number);
  return validCoordinate(latitude, -90, 90) && validCoordinate(longitude, -180, 180) ? { latitude, longitude } : null;
}

function text(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
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
  if (!body || String(body.status) !== "1" || !Array.isArray(body.pois)) return [];
  return body.pois.map((poi, index) => {
    const point = location(poi && poi.location);
    const name = text(poi && poi.name, 80);
    if (!point || !name) return null;
    const address = text(poi.address, 120);
    const category = text(poi.type, 80);
    const business = isPlainObject(poi.biz_ext) ? poi.biz_ext : {};
    return { id: `amap-${text(poi.id, 80) || index}`, name, lat: point.latitude, lng: point.longitude, typeStr: [address.slice(0, 72), category.slice(0, 44)].filter(Boolean).join(" · ").slice(0, 120) || "附近地点", address, category, phone: text(poi.tel, 40), rating: text(business.rating, 16), averageCost: text(business.cost, 16) };
  }).filter(Boolean).slice(0, MAX_NEARBY);
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
  if (!allowRequest(identity, input.action)) return failure("RATE_LIMITED", "地图搜索过于频繁，请稍后再试");
  try {
    if (input.action === "inputTips") {
      const body = requireProviderSuccess(await providerRequest("/v3/assistant/inputtips", {
        keywords: input.keywords,
        citylimit: "false",
        datatype: "all"
      }));
      return success(normalizeTips(body));
    }
    const body = requireProviderSuccess(await providerRequest("/v3/place/around", {
      location: `${input.longitude},${input.latitude}`,
      keywords: "商场 餐饮 咖啡 茶饮",
      radius: "5000",
      offset: String(MAX_NEARBY),
      extensions: "all"
    }));
    return success(normalizeNearby(body));
  } catch (error) {
    return failure(
      publicProviderError(error),
      "地图搜索暂时不可用，请使用微信地图选点"
    );
  }
}

module.exports = { main, _private: { validateEvent, normalizeTips, normalizeNearby, requireProviderSuccess, publicProviderError, allowRequest, rateBuckets } };

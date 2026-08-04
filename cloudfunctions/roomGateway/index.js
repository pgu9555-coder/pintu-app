"use strict";

const crypto = require("node:crypto");
const cloudbase = require("@cloudbase/node-sdk");
const wxCloud = require("wx-server-sdk");

const ROOM_COLLECTION = "rooms";
const PROFILE_COLLECTION = "user_profiles";
const PROFILE_CLEANUP_COLLECTION = "profile_avatar_cleanup";
const MAX_MY_ROOMS_PAGE_SIZE = 50;
const MAX_AVATAR_CLEANUP_BATCH = 50;
const MAX_AVATAR_CLEANUP_RECORDS = 500;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COLORS = ["#0F3D36", "#B8842A", "#3E6E8E", "#A8506E", "#C05B3C", "#4C5C5B"];
const MAX_LEDGER_BYTES = 400 * 1024;
const MAX_ACTIVE_MEMBERS = 50;
const MAX_LEDGER_MEMBERS = 500;
const MAX_LEDGER_EXPENSES = 1000;
const MAX_TOMBSTONES = 2000;
const MAX_MEMBERSHIP_HISTORY = 500;
const MAX_DECISION_CANDIDATES = 12;
const MAX_DECISION_VOTES_PER_CANDIDATE = MAX_LEDGER_MEMBERS;
const JOIN_WINDOW_MS = 5 * 60 * 1000;
const MAX_JOIN_ATTEMPTS_PER_WINDOW = 20;
const joinAttemptBuckets = new Map();
const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const db = app.database();
wxCloud.init({ env: wxCloud.DYNAMIC_CURRENT_ENV });

function success(data) {
  return { ok: true, data };
}

function failure(code, message) {
  return { ok: false, code, message };
}

function requireDbSuccess(result, label) {
  if (result && result.code) {
    const error = new Error(`${label}失败`);
    error.code = result.code;
    error.requestId = result.requestId || null;
    throw error;
  }
  return result;
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function validUid(value) {
  return typeof value === "string" && value.length > 0;
}

function uniqueUids(values) {
  return Array.from(new Set(values.filter(validUid)));
}

function roomTypeFor(room) {
  return room.toolType || room.roomType || "legacy";
}

function activeTopLevelMemberUids(room) {
  const members = Array.isArray(room.members) ? room.members : [];
  return uniqueUids(members.map((member) => member && member.uid));
}

/* A typed room's top-level members are its active identities. Ledger members
   are historical billing records and must never grant access or ownership. */
function inferredRoomOwnerUid(room, fallbackUid) {
  if (validUid(room.ownerUid)) return room.ownerUid;
  const activeUids = activeTopLevelMemberUids(room);
  if (roomTypeFor(room) === "ledger" || roomTypeFor(room) === "midpoint") {
    return activeUids[0] || (validUid(fallbackUid) ? fallbackUid : null);
  }
  const existingUids = Array.isArray(room.memberUids) ? uniqueUids(room.memberUids) : [];
  return existingUids[0] || activeUids[0] || (validUid(fallbackUid) ? fallbackUid : null);
}

function isActiveRoomMember(room, uid) {
  if (!room || !validUid(uid)) return false;
  if (room.ownerUid === uid) return true;
  const type = roomTypeFor(room);
  if (type === "ledger" || type === "midpoint") {
    return activeTopLevelMemberUids(room).includes(uid);
  }
  return Array.isArray(room.memberUids) && room.memberUids.includes(uid);
}

/* Return only the authenticated caller's own membership. Clients must never
   infer identity from a nickname or from a UID cached by another WeChat
   account on the same device. */
function roomViewer(room, uid) {
  if (!isActiveRoomMember(room, uid)) return null;
  const members = Array.isArray(room.members) ? room.members : [];
  const member = members.find((item) => item && item.uid === uid) || {};
  return {
    uid,
    memberId: member.id || null,
    name: cleanText(member.name, 24),
    membershipEpoch: validMembershipEpoch(member.membershipEpoch) || null,
    isOwner: inferredRoomOwnerUid(room, uid) === uid
  };
}

function inputError(message) {
  const error = new Error(message);
  error.publicCode = "INVALID_LEDGER";
  throw error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanLedgerId(value, label) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== "string") inputError(`${label}编号无效`);
  const cleaned = value.trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(cleaned)) inputError(`${label}编号无效`);
  if (cleaned === "__proto__" || cleaned === "prototype" || cleaned === "constructor") inputError(`${label}编号无效`);
  return cleaned;
}

function cleanTimestamp(value, now, label, allowExistingFuture) {
  if (value == null || value === "") return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) inputError(`${label}时间无效`);
  const integer = Math.floor(number);
  const futureLimit = now + 5 * 60 * 1000;
  if (integer > futureLimit) {
    if (allowExistingFuture) return now;
    inputError(`${label}时间与服务器相差过大，请校准设备时间后重试`);
  }
  return integer;
}

function cleanColor(value, index) {
  const color = cleanText(value, 20);
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : COLORS[index % COLORS.length];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeLedgerMember(item, index, now, allowExistingFuture) {
  if (!isPlainObject(item)) inputError("成员数据无效");
  const name = cleanText(item.name, 24);
  if (!name) inputError("成员名字不能为空");
  return {
    id: cleanLedgerId(item.id, "成员"),
    ...(item.uid ? { uid: cleanText(item.uid, 128) } : {}),
    name,
    color: cleanColor(item.color, index),
    createdAt: cleanTimestamp(item.createdAt, now, "成员创建", allowExistingFuture),
    updatedAt: cleanTimestamp(item.updatedAt || item.createdAt, now, "成员更新", allowExistingFuture),
    updatedBy: cleanText(item.updatedBy, 128) || null
  };
}

function normalizeLedgerExpense(item, now, allowExistingFuture) {
  if (!isPlainObject(item)) inputError("支出数据无效");
  const desc = cleanText(item.desc, 100);
  const amountCents = Number(item.amountCents);
  if (!desc) inputError("支出说明不能为空");
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 1000000000000) {
    inputError("支出金额无效");
  }
  if (!Array.isArray(item.splitIds) || item.splitIds.length < 1 || item.splitIds.length > MAX_LEDGER_MEMBERS) {
    inputError("支出分摊成员无效");
  }
  const splitIds = [];
  item.splitIds.forEach((id) => {
    const cleaned = cleanLedgerId(id, "分摊成员");
    if (!splitIds.some((existing) => String(existing) === String(cleaned))) splitIds.push(cleaned);
  });
  return {
    id: cleanLedgerId(item.id, "支出"),
    desc,
    amountCents,
    payerId: cleanLedgerId(item.payerId, "付款人"),
    splitIds,
    createdAt: cleanTimestamp(item.createdAt, now, "支出创建", allowExistingFuture),
    updatedAt: cleanTimestamp(item.updatedAt || item.createdAt, now, "支出更新", allowExistingFuture),
    updatedBy: cleanText(item.updatedBy, 128) || null
  };
}

function normalizeTombstones(source, now, label, allowExistingFuture) {
  if (source == null) return {};
  if (!isPlainObject(source)) inputError(`${label}删除记录无效`);
  const keys = Object.keys(source);
  if (keys.length > MAX_TOMBSTONES) inputError(`${label}删除记录过多`);
  const normalized = {};
  keys.forEach((key) => {
    const id = String(cleanLedgerId(key, label));
    const value = source[key];
    if (!isPlainObject(value)) inputError(`${label}删除记录无效`);
    normalized[id] = {
      deletedAt: cleanTimestamp(value.deletedAt, now, `${label}删除`, allowExistingFuture),
      deletedBy: cleanText(value.deletedBy, 128) || null
    };
  });
  return normalized;
}

function normalizeLedger(source, now, allowExistingFuture) {
  if (!isPlainObject(source)) inputError("账本数据无效");
  let serialized;
  try {
    serialized = JSON.stringify(source);
  } catch (_) {
    inputError("账本数据无法读取");
  }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_LEDGER_BYTES) inputError("账本数据过大");
  const members = Array.isArray(source.members) ? source.members : [];
  const expenses = Array.isArray(source.expenses) ? source.expenses : [];
  if (members.length > MAX_LEDGER_MEMBERS) inputError("账本历史成员超过 500 人上限");
  if (expenses.length > MAX_LEDGER_EXPENSES) inputError("账本支出超过 1000 笔上限");
  const normalizedMembers = members.map((item, index) => normalizeLedgerMember(item, index, now, allowExistingFuture));
  const normalizedExpenses = expenses.map((item) => normalizeLedgerExpense(item, now, allowExistingFuture));
  const seenMembers = new Set();
  normalizedMembers.forEach((item) => {
    const key = String(item.id);
    if (seenMembers.has(key)) inputError("账本包含重复成员编号");
    seenMembers.add(key);
  });
  const seenExpenses = new Set();
  normalizedExpenses.forEach((item) => {
    const key = String(item.id);
    if (seenExpenses.has(key)) inputError("账本包含重复支出编号");
    seenExpenses.add(key);
  });
  return {
    name: cleanText(source.name, 60),
    nameUpdatedAt: cleanTimestamp(source.nameUpdatedAt, now, "账本名称更新", allowExistingFuture),
    members: normalizedMembers,
    expenses: normalizedExpenses,
    memberTombstones: normalizeTombstones(source.memberTombstones, now, "成员", allowExistingFuture),
    expenseTombstones: normalizeTombstones(source.expenseTombstones, now, "支出", allowExistingFuture),
    nextMemberId: Math.max(1, Math.min(1000000000, Math.floor(Number(source.nextMemberId) || 1))),
    nextExpenseId: Math.max(1, Math.min(1000000000, Math.floor(Number(source.nextExpenseId) || 1))),
    revision: cleanTimestamp(source.revision, now, "账本版本", allowExistingFuture),
    updatedAt: cleanTimestamp(source.updatedAt, now, "账本更新", allowExistingFuture),
    updatedBy: cleanText(source.updatedBy, 128) || null
  };
}

function ledgerItemVersion(item) {
  return Number(item && (item.updatedAt || item.createdAt) || 0);
}

function pickNewerLedgerItem(first, second) {
  if (!first) return second ? cloneJson(second) : null;
  if (!second) return cloneJson(first);
  const firstVersion = ledgerItemVersion(first);
  const secondVersion = ledgerItemVersion(second);
  if (firstVersion !== secondVersion) return cloneJson(firstVersion > secondVersion ? first : second);
  return cloneJson(JSON.stringify(first) >= JSON.stringify(second) ? first : second);
}

function mergeTombstones(first, second) {
  const merged = {};
  [first || {}, second || {}].forEach((source) => {
    Object.keys(source).forEach((id) => {
      const incoming = source[id] || {};
      const current = merged[id];
      const incomingAt = Number(incoming.deletedAt || 0);
      const currentAt = Number(current && current.deletedAt || 0);
      if (!current || incomingAt > currentAt || (incomingAt === currentAt && JSON.stringify(incoming) > JSON.stringify(current))) {
        merged[id] = cloneJson(incoming);
      }
    });
  });
  return merged;
}

function mergeLedgerItems(incomingItems, currentItems, tombstones) {
  const byId = {};
  const order = [];
  function absorb(items) {
    (items || []).forEach((item) => {
      const key = String(item.id);
      if (!order.includes(key)) order.push(key);
      byId[key] = pickNewerLedgerItem(byId[key], item);
    });
  }
  absorb(currentItems);
  absorb(incomingItems);
  return order.map((key) => byId[key]).filter((item) => {
    const tombstone = tombstones[String(item.id)];
    return !tombstone || Number(tombstone.deletedAt || 0) < ledgerItemVersion(item);
  });
}

function mergeLedgers(incoming, current) {
  const memberTombstones = mergeTombstones(incoming.memberTombstones, current.memberTombstones);
  const expenseTombstones = mergeTombstones(incoming.expenseTombstones, current.expenseTombstones);
  const incomingNameAt = Number(incoming.nameUpdatedAt || 0);
  const currentNameAt = Number(current.nameUpdatedAt || 0);
  let name = incomingNameAt > currentNameAt ? incoming.name : current.name;
  if (incomingNameAt === currentNameAt) name = current.name || incoming.name || "";
  return {
    name: name || "",
    nameUpdatedAt: Math.max(incomingNameAt, currentNameAt),
    members: mergeLedgerItems(incoming.members, current.members, memberTombstones),
    expenses: mergeLedgerItems(incoming.expenses, current.expenses, expenseTombstones),
    memberTombstones,
    expenseTombstones,
    nextMemberId: Math.max(Number(incoming.nextMemberId || 1), Number(current.nextMemberId || 1)),
    nextExpenseId: Math.max(Number(incoming.nextExpenseId || 1), Number(current.nextExpenseId || 1)),
    revision: Math.max(Number(incoming.revision || 0), Number(current.revision || 0)),
    updatedAt: Math.max(Number(incoming.updatedAt || 0), Number(current.updatedAt || 0)) || null,
    updatedBy: Number(incoming.updatedAt || 0) >= Number(current.updatedAt || 0)
      ? (incoming.updatedBy || null)
      : (current.updatedBy || null)
  };
}

function enforceTrustedLedgerMemberUids(ledger, currentLedger, room) {
  const trustedById = new Map();
  (currentLedger.members || []).forEach((member) => {
    if (member && validUid(member.uid)) trustedById.set(String(member.id), member.uid);
  });
  (Array.isArray(room.members) ? room.members : []).forEach((member) => {
    if (member && validUid(member.uid)) trustedById.set(String(member.id), member.uid);
  });

  return {
    ...ledger,
    members: (ledger.members || []).map((member) => {
      const sanitized = { ...member };
      delete sanitized.uid;
      const trustedUid = trustedById.get(String(member.id));
      if (trustedUid) sanitized.uid = trustedUid;
      return sanitized;
    })
  };
}

function validateLedgerReferences(ledger) {
  const memberIds = new Set(ledger.members.map((member) => String(member.id)));
  ledger.expenses.forEach((expense) => {
    if (!memberIds.has(String(expense.payerId)) || expense.splitIds.some((id) => !memberIds.has(String(id)))) {
      inputError("有支出引用了已移除的成员，请刷新后重试");
    }
  });
}

function callerWechatContext() {
  try {
    const context = wxCloud.getWXContext() || {};
    const openid = typeof context.OPENID === "string" ? context.OPENID.trim() : "";
    const appid = typeof context.APPID === "string" ? context.APPID.trim() : "";
    return openid && appid ? { openid, appid } : null;
  } catch (_) {
    return null;
  }
}

/* Derived solely from the trusted invocation context; event fields must never
   select a room namespace. */
function callerAccessPlatform() {
  return callerWechatContext() ? "wechat-mini-program" : "web";
}

function hasRoomAccessPlatform(room, accessPlatform) {
  /* Pre-v4 rooms are intentionally inaccessible until explicitly migrated. */
  return !!room && room.accessPlatform === accessPlatform;
}

function callerUid() {
  /* A mini-program call has a platform-authenticated identity.  Never accept
     an identity from event.userInfo (or any other client supplied field). */
  const wechat = callerWechatContext();
  if (wechat) return `wx:${wechat.appid}:${wechat.openid}`;
  try {
    const userInfo = app.auth().getUserInfo() || {};
    return userInfo.uid || null;
  } catch (_) {
    return null;
  }
}

function publicInputError(code, message) {
  const error = new Error(message);
  error.publicCode = code;
  throw error;
}

function moderationChunks(values) {
  const text = values
    .map((value) => cleanText(value, 1000))
    .filter(Boolean)
    .join("\n");
  if (!text) return [];
  if (Buffer.byteLength(text, "utf8") > 16 * 1024) {
    publicInputError("CONTENT_BATCH_TOO_LARGE", "本次修改的文字过多，请分几次保存");
  }
  const chunks = [];
  let chunk = "";
  for (const character of text) {
    if (chunk && Buffer.byteLength(chunk + character, "utf8") > 1800) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk += character;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

async function moderateMiniProgramText(values) {
  const wechat = callerWechatContext();
  if (!wechat) return;
  const checker = wxCloud.openapi && wxCloud.openapi.security && wxCloud.openapi.security.msgSecCheck;
  if (typeof checker !== "function") {
    publicInputError("CONTENT_CHECK_UNAVAILABLE", "内容安全服务暂时不可用，请稍后重试");
  }
  for (const content of moderationChunks(values)) {
    let response;
    try {
      response = await checker.call(wxCloud.openapi.security, {
        content,
        version: 2,
        scene: 2,
        openid: wechat.openid
      });
    } catch (error) {
      console.error("[roomGateway:content-check]", error);
      publicInputError("CONTENT_CHECK_UNAVAILABLE", "内容安全检查暂时不可用，请稍后重试");
    }
    const suggestion = response && response.result && response.result.suggest;
    if (suggestion !== "pass") {
      publicInputError(
        suggestion === "risky" || suggestion === "review" ? "CONTENT_REJECTED" : "CONTENT_CHECK_UNAVAILABLE",
        suggestion === "risky" || suggestion === "review"
          ? "文字内容需要修改后再提交"
          : "内容安全检查暂时不可用，请稍后重试"
      );
    }
  }
}

function changedLedgerTexts(incoming, current) {
  const texts = [];
  if (incoming.name !== current.name) texts.push(incoming.name);
  const currentMembers = new Map((current.members || []).map((member) => [String(member.id), member]));
  for (const member of incoming.members || []) {
    const previous = currentMembers.get(String(member.id));
    if (!previous || previous.name !== member.name) texts.push(member.name);
  }
  const currentExpenses = new Map((current.expenses || []).map((expense) => [String(expense.id), expense]));
  for (const expense of incoming.expenses || []) {
    const previous = currentExpenses.get(String(expense.id));
    if (!previous || previous.desc !== expense.desc) texts.push(expense.desc);
  }
  return texts;
}

function randomCode() {
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let index = 0; index < bytes.length; index += 1) {
    code += CODE_CHARS[bytes[index] % CODE_CHARS.length];
  }
  return code;
}

function membershipVersionKey(uid) {
  return crypto.createHash("sha256").update(String(uid)).digest("hex");
}

/* Profile document ids are intentionally opaque and deterministic.  The
   trusted uid never leaves this function, and is never selected from event. */
function profileDocumentId(uid) {
  return `profile-${crypto.createHash("sha256").update(String(uid)).digest("hex")}`;
}

/* Cleanup records use the same opaque, caller-derived id as profiles.  They
   are never readable by clients; keeping failed deletions here means a
   profile can safely change first without silently losing the old file. */
function profileCleanupDocumentId(uid) {
  return `cleanup-${crypto.createHash("sha256").update(String(uid)).digest("hex")}`;
}

function profileTimestamp(value) {
  if (!value) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value.getTime === "function") {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

function publicProfile(profile, exists, cleanupPendingCount = 0, uid = "") {
  return {
    exists: !!exists,
    nickname: exists ? cleanText(profile.nickname, 24) : "",
    avatarFileId: exists ? cleanText(profile.avatarFileId, 1024) : "",
    updatedAt: exists ? profileTimestamp(profile.updatedAt) : null,
    avatarCleanupPendingCount: Math.max(0, Math.floor(Number(cleanupPendingCount) || 0)),
    avatarUploadPrefix: validUid(uid) ? avatarUploadPrefix(uid) : ""
  };
}

function normalizeProfileNickname(value) {
  if (typeof value !== "string") publicInputError("INVALID_PROFILE", "昵称格式无效");
  const nickname = value.trim();
  if (!nickname || Array.from(nickname).length > 24) {
    publicInputError("INVALID_PROFILE", "昵称需为 1 到 24 个字符");
  }
  return nickname;
}

function normalizeAvatarFileId(value, uid) {
  if (typeof value !== "string") publicInputError("INVALID_PROFILE", "头像格式无效");
  const avatarFileId = value.trim();
  if (avatarFileId && (!avatarFileId.startsWith("cloud://") || avatarFileId.length > 1024 || /\s/.test(avatarFileId) || !isManagedAvatarFileId(avatarFileId, uid))) {
    publicInputError("INVALID_PROFILE", "头像文件无效");
  }
  return avatarFileId;
}

/* Only files written by this mini-program's explicit avatar chooser are ever
   deleted with server authority.  A client cannot use a profile update as an
   oracle for deleting another CloudBase file it happens to know the id for. */
function avatarUploadPrefix(uid) {
  return `avatars/${profileDocumentId(uid)}/`;
}

function isManagedAvatarFileId(value, uid) {
  if (!validUid(uid) || typeof value !== "string") return false;
  const match = /^cloud:\/\/[^/]+\/(.+)$/.exec(value);
  if (!match) return false;
  const prefix = avatarUploadPrefix(uid);
  const relativePath = match[1];
  const fileName = relativePath.slice(prefix.length);
  return relativePath.startsWith(prefix) && /^[A-Za-z0-9._-]{1,160}$/.test(fileName);
}

function cleanupFileIds(value, uid) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((fileId) => isManagedAvatarFileId(fileId, uid)))).slice(0, MAX_AVATAR_CLEANUP_RECORDS);
}

function cleanupTaskFromResponse(response) {
  const task = profileFromResponse(response);
  return task && typeof task === "object" ? task : null;
}

function cleanupPendingCount(task, uid) {
  return cleanupFileIds(task && task.fileIds, uid).length;
}

function newMembershipEpoch() {
  return `epoch_${Date.now().toString(36)}_${crypto.randomBytes(12).toString("hex")}`;
}

function validMembershipEpoch(value) {
  const epoch = cleanText(value, 80);
  return /^[A-Za-z0-9_-]{16,80}$/.test(epoch) ? epoch : "";
}

function normalizeMemberEpochs(source) {
  const normalized = {};
  if (!isPlainObject(source)) return normalized;
  Object.keys(source).slice(0, MAX_MEMBERSHIP_HISTORY).forEach((key) => {
    const epoch = validMembershipEpoch(source[key]);
    if (/^[0-9a-f]{64}$/.test(key) && epoch) normalized[key] = epoch;
  });
  return normalized;
}

function decisionCandidateId(name, lat, lng) {
  /* Coordinates are rounded before hashing so equivalent AMap values get the
     same id even when different WebViews serialize floating point values
     slightly differently. */
  const normalized = `${name.toLocaleLowerCase("zh-CN")}\n${lat.toFixed(6)}\n${lng.toFixed(6)}`;
  return `poi_${crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

function newDecisionRoundId() {
  return `round_${Date.now().toString(36)}_${crypto.randomBytes(10).toString("hex")}`;
}

function validDecisionRoundId(value) {
  const id = cleanText(value, 80);
  return /^round_[A-Za-z0-9_-]{16,80}$/.test(id) ? id : "";
}

function normalizeDecisionCandidate(source, uid, now, existing) {
  if (!isPlainObject(source)) inputError("候选地点数据无效");
  if (typeof source.name !== "string" || source.name.trim().length > 80 || typeof source.typeStr !== "string" || source.typeStr.trim().length > 120 ||
    typeof source.lat !== "number" || typeof source.lng !== "number" || typeof source.dist !== "number") inputError("候选地点字段无效");
  const name = cleanText(source.name, 80);
  const lat = Number(source.lat);
  const lng = Number(source.lng);
  const typeStr = cleanText(source.typeStr, 120);
  const dist = Math.floor(Number(source.dist));
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    inputError("候选地点坐标或名称无效");
  }
  if (!Number.isFinite(dist) || dist < 0 || dist > 100000) inputError("候选地点距离无效");
  if (typeof source.isMall !== "boolean" || typeof source.isDrink !== "boolean") inputError("候选地点类型无效");
  const id = decisionCandidateId(name, lat, lng);
  return {
    id,
    name,
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    typeStr,
    dist,
    isMall: source.isMall,
    isDrink: source.isDrink,
    createdBy: existing && validUid(existing.createdBy) ? existing.createdBy : uid,
    createdAt: existing && Number.isFinite(Number(existing.createdAt)) ? Math.floor(Number(existing.createdAt)) : now,
    updatedAt: now
  };
}

function validDecisionCandidate(source) {
  try {
    if (!isPlainObject(source)) return null;
    if (typeof source.name !== "string" || source.name.trim().length > 80 || typeof source.typeStr !== "string" || source.typeStr.trim().length > 120 ||
      typeof source.lat !== "number" || typeof source.lng !== "number" || typeof source.dist !== "number") return null;
    const name = cleanText(source.name, 80);
    const lat = Number(source.lat);
    const lng = Number(source.lng);
    const typeStr = cleanText(source.typeStr, 120);
    const dist = Math.floor(Number(source.dist));
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 ||
      !Number.isFinite(dist) || dist < 0 || dist > 100000 || typeof source.isMall !== "boolean" || typeof source.isDrink !== "boolean") return null;
    const id = decisionCandidateId(name, lat, lng);
    return {
      id, name, lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), typeStr, dist,
      isMall: source.isMall, isDrink: source.isDrink,
      createdBy: validUid(source.createdBy) ? source.createdBy : "",
      createdAt: Math.max(0, Math.floor(Number(source.createdAt) || 0)),
      updatedAt: Math.max(0, Math.floor(Number(source.updatedAt) || 0))
    };
  } catch (_) { return null; }
}

function normalizedMeetupDecision(meetup, room) {
  const source = meetup && isPlainObject(meetup.decision) ? meetup.decision : {};
  const activeUids = room ? new Set(activeTopLevelMemberUids(room)) : null;
  const candidates = [];
  const candidateIds = new Set();
  (Array.isArray(source.candidates) ? source.candidates : []).slice(0, MAX_DECISION_CANDIDATES).forEach((item) => {
    const candidate = validDecisionCandidate(item);
    if (candidate && !candidateIds.has(candidate.id)) { candidates.push(candidate); candidateIds.add(candidate.id); }
  });
  const votes = [];
  const seenVotes = new Set();
  const maxVotes = candidates.length * MAX_DECISION_VOTES_PER_CANDIDATE;
  (Array.isArray(source.votes) ? source.votes : []).slice(0, maxVotes).forEach((vote) => {
    if (!isPlainObject(vote) || !candidateIds.has(vote.candidateId) || !validUid(vote.uid) ||
      (activeUids && !activeUids.has(vote.uid)) || !/^(want|ok|no)$/.test(vote.value || "")) return;
    const key = `${vote.candidateId}\n${vote.uid}`;
    if (seenVotes.has(key)) return;
    seenVotes.add(key);
    votes.push({ candidateId: vote.candidateId, uid: vote.uid, value: vote.value, updatedAt: Math.max(0, Math.floor(Number(vote.updatedAt) || 0)) });
  });
  const confirmedCandidateId = candidateIds.has(source.confirmedCandidateId) ? source.confirmedCandidateId : null;
  const roundId = validDecisionRoundId(source.roundId);
  const revision = Math.max(0, Math.floor(Number(source.revision) || 0));
  return {
    roundId,
    revision,
    state: confirmedCandidateId ? "confirmed" : "open",
    candidates,
    votes,
    confirmedCandidateId,
    confirmedAt: confirmedCandidateId ? Math.max(0, Math.floor(Number(source.confirmedAt) || 0)) : null,
    confirmedBy: confirmedCandidateId && validUid(source.confirmedBy) ? source.confirmedBy : null
  };
}

function requireCurrentMembership(room, uid, suppliedEpoch) {
  const incoming = validMembershipEpoch(suppliedEpoch);
  const stored = validMembershipEpoch(normalizeMemberEpochs(room.memberEpochs)[membershipVersionKey(uid)]);
  if (!incoming || !stored || incoming !== stored) return false;
  return (Array.isArray(room.members) ? room.members : []).some((member) => member && member.uid === uid);
}

function decisionRoundMatches(event, decision) {
  const expectedRoundId = validDecisionRoundId(event && event.roundId);
  if (!decision.roundId) return !expectedRoundId;
  return expectedRoundId === decision.roundId;
}

/* 轻量的单实例节流用于挡住误操作和普通脚本；8 位随机码提供主要的抗猜测空间。 */
function consumeJoinAttempt(uid) {
  const now = Date.now();
  if (joinAttemptBuckets.size > 5000) {
    for (const [key, bucket] of joinAttemptBuckets) {
      if (!bucket || now - bucket.startedAt > JOIN_WINDOW_MS) joinAttemptBuckets.delete(key);
    }
  }
  const key = membershipVersionKey(uid);
  let bucket = joinAttemptBuckets.get(key);
  if (!bucket || now - bucket.startedAt > JOIN_WINDOW_MS) bucket = { startedAt: now, count: 0 };
  if (bucket.count >= MAX_JOIN_ATTEMPTS_PER_WINDOW) return false;
  bucket.count += 1;
  joinAttemptBuckets.set(key, bucket);
  return true;
}

function sharedMemberId() {
  return `member-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
}

function codeForCreate(uid, requestKey, attempt) {
  const bytes = crypto
    .createHash("sha256")
    .update(`${uid}:${requestKey}:${attempt}`)
    .digest()
    .subarray(0, 8);
  let code = "";
  for (const byte of bytes) code += CODE_CHARS[byte % CODE_CHARS.length];
  return code;
}

function normalizeTypedRoom(source, uid, accessPlatform) {
  const type = source.toolType === "midpoint" ? "midpoint" : "ledger";
  const inputMember = Array.isArray(source.members) && source.members[0] ? source.members[0] : {};
  const memberName = cleanText(inputMember.name, 24);
  if (!memberName) throw new Error("请先填写你自己的名字");
  const membershipEpoch = newMembershipEpoch();
  const member = {
    id: sharedMemberId(),
    uid,
    name: memberName,
    color: COLORS[0],
    membershipEpoch
  };
  const roomName = cleanText(source.name, 60) || `${memberName}${type === "midpoint" ? "发起的碰面" : "发起的账本"}`;
  const now = Date.now();
  const room = {
    name: roomName,
    toolType: type,
    schemaVersion: 4,
    accessPlatform,
    lifecycle: { policy: "owner-disband-only", createdAtMs: now },
    members: [member],
    memberUids: [uid],
    memberEpochs: { [membershipVersionKey(uid)]: membershipEpoch },
    nextMemberId: 2,
    ownerUid: uid,
    tripId: null,
    ledger: null,
    meetup:
      type === "midpoint"
        ? { people: [{ uid, name: memberName, address: "", lat: null, lng: null, color: COLORS[0] }] }
        : { people: [] },
    createdAt: new Date(),
    updatedAt: new Date()
  };
  if (type === "ledger") {
    room.ledger = {
      name: roomName,
      nameUpdatedAt: now,
      members: [{ ...member, createdAt: now, updatedAt: now, updatedBy: uid }],
      expenses: [],
      memberTombstones: {},
      expenseTombstones: {},
      nextMemberId: 2,
      nextExpenseId: 1,
      revision: now,
      updatedAt: now,
      updatedBy: uid
    };
  }
  return room;
}

function normalizeLegacyRoom(source, uid, accessPlatform) {
  const name = cleanText(source.name, 60);
  if (!name) throw new Error("请先填写房间名称");
  const sourceMembers = Array.isArray(source.members) ? source.members.slice(0, MAX_ACTIVE_MEMBERS) : [];
  const members = sourceMembers
    .filter((member) => member && typeof member === "object")
    .map((member, index) => ({
      id: Number(member.id) || index + 1,
      name: cleanText(member.name, 24),
      color: COLORS[index % COLORS.length]
    }))
    .filter((member) => member.name);
  if (members.length < 2) throw new Error("旧版房间至少需要两名成员");
  return {
    name,
    toolType: "legacy",
    schemaVersion: 4,
    accessPlatform,
    members,
    memberUids: [uid],
    nextMemberId: Math.max(Number(source.nextMemberId) || 1, members.length + 1),
    ownerUid: uid,
    tripId: null,
    ledger: null,
    meetup: { people: [] },
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

async function createRoom(event, uid, accessPlatform) {
  const source = event && event.room && typeof event.room === "object" ? event.room : {};
  const room = source.toolType === "midpoint" || source.toolType === "ledger"
    ? normalizeTypedRoom(source, uid, accessPlatform)
    : normalizeLegacyRoom(source, uid, accessPlatform);
  const clientRequestId = cleanText(event && event.clientRequestId, 80);
  if (clientRequestId && !/^[A-Za-z0-9_-]{8,80}$/.test(clientRequestId)) {
    return failure("INVALID_REQUEST_ID", "创建请求编号无效，请刷新页面后重试");
  }
  await moderateMiniProgramText([
    room.name,
    ...(Array.isArray(room.members) ? room.members.map((member) => member && member.name) : [])
  ]);
  const requestKey = clientRequestId || `server_${crypto.randomBytes(16).toString("hex")}`;

  /* The room document ID is derived from the public code. That makes code
     ownership an atomic document creation instead of a query-then-write race.
     A retry uses the same request key and walks the same deterministic
     candidates, so it returns the original room without creating a duplicate. */
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const code = clientRequestId ? codeForCreate(uid, requestKey, attempt) : randomCode();
    const oldMatch = requireDbSuccess(
      await db.collection(ROOM_COLLECTION).where({ code }).limit(1).get(),
      "检查房间码"
    );
    const oldRoom = oldMatch && Array.isArray(oldMatch.data) ? oldMatch.data[0] : null;
    if (oldRoom) {
      if (hasRoomAccessPlatform(oldRoom, accessPlatform) && oldRoom.ownerUid === uid && oldRoom.createRequestId === requestKey) {
        const oldDocId = oldRoom._id;
        return success({ docId: oldDocId, room: oldRoom, viewer: roomViewer(oldRoom, uid) });
      }
      continue;
    }

    const docId = `room-code-${code}`;
    const candidate = { ...room, code, createRequestId: requestKey };
    const result = await db.runTransaction(async (transaction) => {
      const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
      const response = requireDbSuccess(await ref.get(), "检查创建请求");
      const existing = response && response.data ? response.data : null;
      if (existing) {
        if (hasRoomAccessPlatform(existing, accessPlatform) && existing.ownerUid === uid && existing.createRequestId === requestKey) {
          return { kind: "existing", room: existing };
        }
        return { kind: "collision" };
      }
      requireDbSuccess(await ref.set(candidate), "创建房间");
      return { kind: "created", room: candidate };
    }, 5);

    if (result && result.kind === "collision") continue;
    if (result && (result.kind === "created" || result.kind === "existing")) {
      const savedRoom = { ...result.room, _id: docId };
      return success({ docId, room: savedRoom, viewer: roomViewer(savedRoom, uid) });
    }
  }
  throw new Error("暂时无法生成房间码，请稍后再试");
}

async function roomByCode(code) {
  const response = requireDbSuccess(
    await db.collection(ROOM_COLLECTION).where({ code }).limit(2).get(),
    "查找房间"
  );
  const rooms = response.data || [];
  if (rooms.length !== 1) return null;
  return rooms[0];
}

async function getRoom(event, uid, accessPlatform) {
  const docId = cleanText(event && event.docId, 80);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  const response = requireDbSuccess(
    await db.collection(ROOM_COLLECTION).doc(docId).get(),
    "读取房间"
  );
  const room = response && Array.isArray(response.data) ? response.data[0] : response && response.data;
  /* Do not reveal whether an unknown room exists. A missing room and a room the caller
     has not joined intentionally return the same empty result. */
  if (!hasRoomAccessPlatform(room, accessPlatform) || !isActiveRoomMember(room, uid)) {
    return success({ room: null, viewer: null });
  }
  let safeRoom = { ...room, _id: room._id || docId };
  if (roomTypeFor(room) === "midpoint" && room.meetup && isPlainObject(room.meetup)) {
    safeRoom = {
      ...safeRoom,
      meetup: { ...room.meetup, decision: normalizedMeetupDecision(room.meetup, room) }
    };
  }
  return success({ room: safeRoom, viewer: roomViewer(safeRoom, uid) });
}

function profileFromResponse(response) {
  if (!response || response.data == null) return null;
  return Array.isArray(response.data) ? response.data[0] || null : response.data;
}

function requireWechatMiniProgram(accessPlatform) {
  if (accessPlatform !== "wechat-mini-program") {
    return failure("WECHAT_MINIPROGRAM_ONLY", "该操作仅支持微信小程序");
  }
  return null;
}

async function getProfile(uid, accessPlatform) {
  const denied = requireWechatMiniProgram(accessPlatform);
  if (denied) return denied;
  const [profileResponse, cleanupResponse] = await Promise.all([
    db.collection(PROFILE_COLLECTION).doc(profileDocumentId(uid)).get(),
    db.collection(PROFILE_CLEANUP_COLLECTION).doc(profileCleanupDocumentId(uid)).get()
  ]);
  const profile = profileFromResponse(requireDbSuccess(profileResponse, "读取微信资料"));
  const cleanupTask = cleanupTaskFromResponse(requireDbSuccess(cleanupResponse, "读取头像清理状态"));
  return success(publicProfile(profile || {}, !!profile, cleanupPendingCount(cleanupTask, uid), uid));
}

async function addAvatarCleanupTask(transaction, uid, fileIds) {
  const requestedFileIds = cleanupFileIds(fileIds, uid);
  if (!requestedFileIds.length) return 0;
  const ref = transaction.collection(PROFILE_CLEANUP_COLLECTION).doc(profileCleanupDocumentId(uid));
  const existing = cleanupTaskFromResponse(
    requireDbSuccess(await ref.get(), "读取头像清理任务")
  );
  const merged = cleanupFileIds([
    ...cleanupFileIds(existing && existing.fileIds, uid),
    ...requestedFileIds
  ], uid);
  const now = new Date();
  requireDbSuccess(await ref.set({
    fileIds: merged,
    createdAt: existing && existing.createdAt ? existing.createdAt : now,
    updatedAt: now,
    attempts: Math.max(0, Math.floor(Number(existing && existing.attempts) || 0))
  }), "记录头像清理任务");
  return merged.length;
}

function cleanupResult(pendingCount, attemptedCount = 0, deletedCount = 0, error = "") {
  return {
    status: pendingCount ? "pending" : "cleared",
    attemptedCount,
    deletedCount,
    pendingCount,
    error: cleanText(error, 160)
  };
}

function unmanagedAvatarCleanupResult() {
  return {
    status: "unmanaged",
    attemptedCount: 0,
    deletedCount: 0,
    pendingCount: 0,
    error: "旧版本头像文件不在当前账号专属目录，未自动删除"
  };
}

/* CloudBase's server SDK reports one result per requested FileID.  Do not
   infer success from a resolved promise: a partial failure must remain queued
   and visible to the owner for another retry. */
async function drainAvatarCleanup(uid) {
  const taskId = profileCleanupDocumentId(uid);
  const initialResponse = requireDbSuccess(
    await db.collection(PROFILE_CLEANUP_COLLECTION).doc(taskId).get(),
    "读取头像清理任务"
  );
  const task = cleanupTaskFromResponse(initialResponse);
  const pending = cleanupFileIds(task && task.fileIds, uid);
  if (!pending.length) return cleanupResult(0);

  const attempted = pending.slice(0, MAX_AVATAR_CLEANUP_BATCH);
  let deletedFileIds = [];
  let deleteError = "";
  try {
    const response = await app.deleteFile({ fileList: attempted });
    const resultList = Array.isArray(response && response.fileList) ? response.fileList : [];
    const successfulFileIds = new Set(
      resultList
        .filter((item) => item && item.code === "SUCCESS" && attempted.includes(item.fileID))
        .map((item) => item.fileID)
    );
    deletedFileIds = attempted.filter((fileId) => successfulFileIds.has(fileId));
    if (deletedFileIds.length !== attempted.length) {
      deleteError = "部分头像文件尚未删除";
    }
  } catch (error) {
    deleteError = error && error.message ? error.message : "头像文件删除请求失败";
  }

  const state = await db.runTransaction(async (transaction) => {
    const ref = transaction.collection(PROFILE_CLEANUP_COLLECTION).doc(taskId);
    const current = cleanupTaskFromResponse(
      requireDbSuccess(await ref.get(), "读取头像清理任务")
    );
    const currentFileIds = cleanupFileIds(current && current.fileIds, uid);
    const remaining = currentFileIds.filter((fileId) => !deletedFileIds.includes(fileId));
    if (!remaining.length) {
      requireDbSuccess(await ref.remove(), "移除头像清理任务");
      return { pendingCount: 0 };
    }
    requireDbSuccess(await ref.set({
      fileIds: remaining,
      createdAt: current && current.createdAt ? current.createdAt : new Date(),
      updatedAt: new Date(),
      attempts: Math.max(0, Math.floor(Number(current && current.attempts) || 0)) + 1,
      lastError: cleanText(deleteError || "部分头像文件尚未删除", 160)
    }), "更新头像清理任务");
    return { pendingCount: remaining.length };
  }, 5);
  return cleanupResult(state.pendingCount, attempted.length, deletedFileIds.length, deleteError);
}

async function updateProfile(event, uid, accessPlatform) {
  const denied = requireWechatMiniProgram(accessPlatform);
  if (denied) return denied;
  const source = event && typeof event === "object" ? event : {};
  const hasNickname = Object.prototype.hasOwnProperty.call(source, "nickname");
  const hasAvatar = Object.prototype.hasOwnProperty.call(source, "avatarFileId");
  if (!hasNickname && !hasAvatar) return failure("INVALID_PROFILE", "请填写要更新的资料");
  const docId = profileDocumentId(uid);
  const incomingNickname = hasNickname ? normalizeProfileNickname(source.nickname) : null;
  const incomingAvatarFileId = hasAvatar ? normalizeAvatarFileId(source.avatarFileId, uid) : null;
  const initialResponse = requireDbSuccess(
    await db.collection(PROFILE_COLLECTION).doc(docId).get(),
    "读取微信资料"
  );
  const initial = profileFromResponse(initialResponse);

  /* Keep external moderation outside the database transaction.  CloudBase may
     retry transaction callbacks, and a network API inside the callback could
     be called multiple times while holding the transaction open. */
  if (hasNickname && (!initial || incomingNickname !== cleanText(initial.nickname, 24))) {
    await moderateMiniProgramText([incomingNickname]);
  }

  const saved = await db.runTransaction(async (transaction) => {
    const ref = transaction.collection(PROFILE_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取微信资料");
    const current = profileFromResponse(response);
    const nickname = hasNickname ? incomingNickname : current && cleanText(current.nickname, 24);
    if (!nickname) publicInputError("INVALID_PROFILE", "请先填写昵称");
    const avatarFileId = hasAvatar ? incomingAvatarFileId : current && cleanText(current.avatarFileId, 1024);

    if (current && nickname === cleanText(current.nickname, 24) && avatarFileId === cleanText(current.avatarFileId, 1024)) {
      return { profile: publicProfile(current, true, 0, uid), cleanupQueued: false, unmanagedAvatar: false };
    }
    const now = new Date();
    const next = {
      nickname,
      avatarFileId: avatarFileId || "",
      createdAt: current && current.createdAt ? current.createdAt : now,
      updatedAt: now
    };
    requireDbSuccess(await ref.set(next), "保存微信资料");
    const oldAvatarFileId = current && cleanText(current.avatarFileId, 1024);
    const cleanupQueued = oldAvatarFileId && oldAvatarFileId !== avatarFileId && isManagedAvatarFileId(oldAvatarFileId, uid);
    if (cleanupQueued) await addAvatarCleanupTask(transaction, uid, [oldAvatarFileId]);
    return {
      profile: publicProfile(next, true, 0, uid),
      cleanupQueued,
      unmanagedAvatar: !!(oldAvatarFileId && oldAvatarFileId !== avatarFileId && !cleanupQueued)
    };
  }, 5);
  const cleanup = saved.unmanagedAvatar ? unmanagedAvatarCleanupResult() : await drainAvatarCleanup(uid);
  return success({
    ...saved.profile,
    avatarCleanupPendingCount: cleanup.pendingCount,
    avatarCleanup: cleanup
  });
}

async function deleteProfile(uid, accessPlatform) {
  const denied = requireWechatMiniProgram(accessPlatform);
  if (denied) return denied;
  const deleted = await db.runTransaction(async (transaction) => {
    const ref = transaction.collection(PROFILE_COLLECTION).doc(profileDocumentId(uid));
    const current = profileFromResponse(requireDbSuccess(await ref.get(), "读取微信资料"));
    const oldAvatarFileId = current && cleanText(current.avatarFileId, 1024);
    if (oldAvatarFileId && isManagedAvatarFileId(oldAvatarFileId, uid)) {
      await addAvatarCleanupTask(transaction, uid, [current.avatarFileId]);
    }
    const result = requireDbSuccess(await ref.remove(), "删除微信资料");
    if (result && result.deleted != null && result.deleted !== 0 && result.deleted !== 1) {
      throw new Error("删除微信资料失败");
    }
    return {
      cleanupQueued: !!(oldAvatarFileId && isManagedAvatarFileId(oldAvatarFileId, uid)),
      unmanagedAvatar: !!(oldAvatarFileId && !isManagedAvatarFileId(oldAvatarFileId, uid))
    };
  }, 5);
  const cleanup = deleted.unmanagedAvatar ? unmanagedAvatarCleanupResult() : await drainAvatarCleanup(uid);
  return success({ deleted: true, avatarCleanup: cleanup });
}

async function retryAvatarCleanup(uid, accessPlatform) {
  const denied = requireWechatMiniProgram(accessPlatform);
  if (denied) return denied;
  return success({ avatarCleanup: await drainAvatarCleanup(uid) });
}

function listMyRoomsPage(event) {
  const source = event && typeof event === "object" ? event : {};
  const limit = source.limit == null ? MAX_MY_ROOMS_PAGE_SIZE : source.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MY_ROOMS_PAGE_SIZE) {
    return failure("INVALID_PAGINATION", "房间列表数量无效");
  }
  if (source.offset != null && source.offset !== 0) {
    return failure("INVALID_PAGINATION", "请更新小程序后继续加载房间");
  }
  if (source.cursor == null || source.cursor === "") return { cursor: null, limit };
  const cursor = source.cursor;
  if (!isPlainObject(cursor) || !Number.isSafeInteger(cursor.createdAt) || cursor.createdAt < 0 || cursor.createdAt > Number.MAX_SAFE_INTEGER || typeof cursor.docId !== "string") {
    return failure("INVALID_PAGINATION", "房间列表游标无效");
  }
  const docId = cursor.docId.trim();
  if (!docId || docId.length > 256 || /[\u0000-\u001f]/.test(docId)) {
    return failure("INVALID_PAGINATION", "房间列表游标无效");
  }
  return { cursor: { createdAt: cursor.createdAt, docId }, limit };
}

function myRoomsWhere(memberPredicate, cursor) {
  const base = {
    accessPlatform: "wechat-mini-program",
    memberUids: memberPredicate
  };
  if (!cursor) return base;
  const command = db.command;
  if (!command || typeof command.or !== "function" || typeof command.lt !== "function") {
    throw new Error("CloudBase 数据库不支持安全的房间列表游标查询");
  }
  const createdAt = new Date(cursor.createdAt);
  return command.or([
    { ...base, createdAt: command.lt(createdAt) },
    { ...base, createdAt, _id: command.lt(cursor.docId) }
  ]);
}

function roomListCursor(room) {
  const createdAt = profileTimestamp(room && room.createdAt);
  const docId = room && typeof room._id === "string" ? room._id : "";
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !docId) return null;
  return { createdAt, docId };
}

function orderMyRooms(query) {
  return query.orderBy("createdAt", "desc").orderBy("_id", "desc");
}

function roomSummary(room) {
  const expenses = room && room.ledger && Array.isArray(room.ledger.expenses) ? room.ledger.expenses : [];
  const totalCents = expenses.reduce((sum, expense) => {
    const amount = Number(expense && expense.amountCents);
    return Number.isSafeInteger(amount) && amount > 0 ? sum + amount : sum;
  }, 0);
  const activeMembers = roomTypeFor(room) === "midpoint" || roomTypeFor(room) === "ledger"
    ? activeTopLevelMemberUids(room)
    : uniqueUids(Array.isArray(room.memberUids) ? room.memberUids : []);
  const updatedAt = profileTimestamp(room.updatedAt) || profileTimestamp(room.ledger && room.ledger.updatedAt) || profileTimestamp(room.createdAt);
  return {
    docId: room._id,
    room: {
      name: cleanText(room.name, 60),
      code: cleanText(room.code, 8),
      toolType: roomTypeFor(room)
    },
    memberCount: activeMembers.length,
    expenseCount: expenses.length,
    totalCents,
    updatedAt
  };
}

async function listMyRooms(event, uid, accessPlatform) {
  const denied = requireWechatMiniProgram(accessPlatform);
  if (denied) return denied;
  const page = listMyRoomsPage(event);
  if (page && page.ok === false) return page;
  const command = db.command;
  const memberPredicate = command && typeof command.elemMatch === "function" && typeof command.eq === "function"
    ? command.elemMatch(command.eq(uid))
    : uid;
  const summaries = [];
  let queryCursor = page.cursor;
  let nextCursor = null;

  /* Keyset pagination uses immutable creation time instead of updatedAt. A
     room can be edited between requests without moving behind the cursor and
     disappearing from a later page. The _id tie breaker handles equal times. */
  while (summaries.length < page.limit) {
    const response = requireDbSuccess(
      await orderMyRooms(
        db.collection(ROOM_COLLECTION).where(myRoomsWhere(memberPredicate, queryCursor))
      )
        .limit(MAX_MY_ROOMS_PAGE_SIZE)
        .get(),
      "读取我的房间"
    );
    const rooms = Array.isArray(response && response.data) ? response.data : [];
    for (const room of rooms) {
      const roomCursor = roomListCursor(room);
      if (!roomCursor) continue;
      nextCursor = roomCursor;
      if (!hasRoomAccessPlatform(room, accessPlatform) || !isActiveRoomMember(room, uid)) continue;
      const summary = roomSummary(room);
      if (summary.room.toolType === "midpoint" || summary.room.toolType === "ledger") summaries.push(summary);
      if (summaries.length === page.limit) {
        break;
      }
    }
    if (summaries.length === page.limit) break;
    if (rooms.length < MAX_MY_ROOMS_PAGE_SIZE || !nextCursor) break;
    queryCursor = nextCursor;
  }
  let hasMore = false;
  if (summaries.length === page.limit && nextCursor) {
    const probe = requireDbSuccess(
      await orderMyRooms(
        db.collection(ROOM_COLLECTION).where(myRoomsWhere(memberPredicate, nextCursor))
      )
        .limit(1)
        .get(),
      "检查我的房间后续页"
    );
    hasMore = Array.isArray(probe && probe.data) && probe.data.length > 0;
  }
  return success({
    rooms: summaries.sort((first, second) => {
      const updatedDifference = Number(second.updatedAt || 0) - Number(first.updatedAt || 0);
      return updatedDifference || String(second.docId).localeCompare(String(first.docId));
    }),
    nextCursor: hasMore ? nextCursor : null,
    hasMore
  });
}

async function joinRoom(event, uid, accessPlatform) {
  const code = cleanText(event.code, 8).toUpperCase();
  const expectedType = cleanText(event.type, 16);
  const isAutoJoin = expectedType === "auto";
  const name = cleanText(event.name, 24);
  if (!/^(?:[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}|[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8})$/.test(code)) {
    return failure("INVALID_CODE", "请输入完整的 8 位房间码（旧房间可输入 6 位）");
  }
  if (!consumeJoinAttempt(uid)) return failure("RATE_LIMITED", "尝试次数过多，请 5 分钟后再试");
  const room = await roomByCode(code);
  if (room && !hasRoomAccessPlatform(room, accessPlatform)) return failure("ROOM_NOT_FOUND", "没有找到这个房间码");
  if (!room) return failure("ROOM_NOT_FOUND", `没有找到房间码“${code}”`);
  const type = room.toolType || room.roomType || "legacy";
  if (isAutoJoin && type !== "midpoint" && type !== "ledger") {
    return type === "legacy"
      ? failure("ROOM_LEGACY_UNSUPPORTED", "旧版综合房间不支持自动加入，请从对应功能进入")
      : failure("WRONG_ROOM_TYPE", "这个房间不支持自动加入");
  }
  if (!isAutoJoin && expectedType && type !== expectedType) {
    const actual = type === "midpoint" ? "碰面码" : type === "ledger" ? "账本码" : "旧版综合房间码";
    return failure("WRONG_ROOM_TYPE", `这是${actual}，不能加入当前功能`);
  }

  const docId = room._id;
  if ((type === "midpoint" || type === "ledger") && !name) {
    return failure("NAME_REQUIRED", "请先填写你自己的名字");
  }
  await moderateMiniProgramText([name]);

  /* 加入涉及 memberUids、成员资料与碰面点等多个字段。放进同一个事务，
     避免网络中断或两个人同时加入时只写成一半。 */
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取房间");
    const current = response && response.data ? response.data : null;
    if (!hasRoomAccessPlatform(current, accessPlatform) || current.code !== code) {
      return failure("ROOM_NOT_FOUND", `没有找到房间码“${code}”`);
    }

    const currentType = current.toolType || current.roomType || "legacy";
    if (isAutoJoin && currentType !== "midpoint" && currentType !== "ledger") {
      return currentType === "legacy"
        ? failure("ROOM_LEGACY_UNSUPPORTED", "旧版综合房间不支持自动加入，请从对应功能进入")
        : failure("WRONG_ROOM_TYPE", "这个房间不支持自动加入");
    }
    if (!isAutoJoin && expectedType && currentType !== expectedType) {
      const actual = currentType === "midpoint" ? "碰面码" : currentType === "ledger" ? "账本码" : "旧版综合房间码";
      return failure("WRONG_ROOM_TYPE", `这是${actual}，不能加入当前功能`);
    }
    if ((currentType === "midpoint" || currentType === "ledger") && !name) {
      return failure("NAME_REQUIRED", "请先填写你自己的名字");
    }

    const existingMemberUids = Array.isArray(current.memberUids) ? current.memberUids : [];
    const currentMembers = Array.isArray(current.members) ? current.members : [];
    const normalizedCurrentLedger = currentType === "ledger" && current.ledger && typeof current.ledger === "object"
      ? normalizeLedger(current.ledger, Date.now(), true)
      : null;
    const currentLedgerMembers = normalizedCurrentLedger
      ? normalizedCurrentLedger.members
      : (current.ledger && Array.isArray(current.ledger.members) ? current.ledger.members : []);
    const inferredOwnerUid = inferredRoomOwnerUid(current, uid);
    const trustedExistingUids = currentType === "midpoint" || currentType === "ledger"
      ? activeTopLevelMemberUids(current)
      : existingMemberUids;
    const memberUids = uniqueUids([...trustedExistingUids, inferredOwnerUid, uid]);
    const patch = { memberUids };
    if (!current.ownerUid) patch.ownerUid = inferredOwnerUid;
    let updated = { ...current, memberUids, ownerUid: inferredOwnerUid };

    if (currentType === "midpoint" || currentType === "ledger") {
      const members = currentMembers;
      const wasActiveMember = currentMembers.some((member) => member && member.uid === uid);
      const memberEpochs = normalizeMemberEpochs(current.memberEpochs);
      const memberEpochKey = membershipVersionKey(uid);
      if (!wasActiveMember && !Object.prototype.hasOwnProperty.call(memberEpochs, memberEpochKey)
          && Object.keys(memberEpochs).length >= MAX_MEMBERSHIP_HISTORY) {
        return failure("ROOM_HISTORY_FULL", "这个房间的历史成员过多，请新建房间继续使用");
      }
      let membershipEpoch = wasActiveMember ? validMembershipEpoch(memberEpochs[memberEpochKey]) : "";
      if (!membershipEpoch) membershipEpoch = newMembershipEpoch();
      memberEpochs[memberEpochKey] = membershipEpoch;
      patch.memberEpochs = memberEpochs;
      updated = { ...updated, memberEpochs };
      if (!members.some((member) => member.uid === uid) && members.length >= MAX_ACTIVE_MEMBERS) {
        return failure("ROOM_FULL", "这个房间已经达到 50 人上限");
      }
      const duplicate = members.some((member) => member.name === name && member.uid && member.uid !== uid);
      if (duplicate) return failure("DUPLICATE_NAME", `房间里已经有人使用“${name}”，请换一个昵称`);

      const ledgerMembers = currentLedgerMembers;
      const previous = members.find((member) => member.uid === uid) || ledgerMembers.find((member) => member.uid === uid);
      if (currentType === "ledger" && !ledgerMembers.some((member) => member && member.uid === uid) && ledgerMembers.length >= MAX_LEDGER_MEMBERS) {
        return failure("LEDGER_HISTORY_FULL", "这个账本的历史成员过多，请新建一个账本继续使用");
      }
      const member = {
        id: previous && previous.id ? previous.id : sharedMemberId(),
        uid,
        name,
        color: (previous && previous.color) || COLORS[members.length % COLORS.length],
        membershipEpoch
      };
      const nextMembers = members.filter((item) => item.uid !== uid).concat(member);
      const nextMemberId = Math.max(Number(current.nextMemberId) || 1, nextMembers.length + 1);
      patch.members = nextMembers;
      patch.nextMemberId = nextMemberId;
      updated = { ...updated, members: nextMembers, nextMemberId };

      if (currentType === "midpoint") {
        const meetup = current.meetup && typeof current.meetup === "object" ? current.meetup : { people: [] };
        const people = Array.isArray(meetup.people) ? meetup.people : [];
        const pointVersions = isPlainObject(meetup.pointVersions) ? { ...meetup.pointVersions } : {};
        if (!wasActiveMember) delete pointVersions[memberEpochKey];
        const previousPoint = people.find((person) => person.uid === uid);
        const point = previousPoint
          ? { ...previousPoint, uid, name }
          : { uid, name, address: "", lat: null, lng: null, color: COLORS[people.length % COLORS.length] };
        const nextMeetup = { ...meetup, people: people.filter((person) => person.uid !== uid).concat(point), pointVersions };
        patch.meetup = nextMeetup;
        updated = { ...updated, meetup: nextMeetup };
      }

      if (currentType === "ledger" && normalizedCurrentLedger) {
        const previousLedgerMember = ledgerMembers.find((item) => item.uid === uid);
        const stamp = Math.max(
          Date.now(),
          Number(previousLedgerMember && previousLedgerMember.updatedAt) || 0,
          Number(normalizedCurrentLedger.updatedAt) || 0,
          Number(normalizedCurrentLedger.revision) || 0
        ) + 1;
        const ledgerMember = {
          ...(previousLedgerMember || {}),
          ...member,
          createdAt: (previousLedgerMember && previousLedgerMember.createdAt) || stamp,
          updatedAt: stamp,
          updatedBy: uid
        };
        const nextLedgerMembers = ledgerMembers.filter((item) => item.uid !== uid).concat(ledgerMember);
        const nextLedger = normalizeLedger({
          ...normalizedCurrentLedger,
          members: nextLedgerMembers,
          nextMemberId: Math.max(Number(normalizedCurrentLedger.nextMemberId) || 1, nextLedgerMembers.length + 1),
          revision: stamp,
          updatedAt: stamp,
          updatedBy: uid
        }, Date.now(), true);
        patch.ledger = nextLedger;
        updated = { ...updated, ledger: nextLedger };
      }
    }

    patch.updatedAt = new Date();
    const updatedResult = requireDbSuccess(await ref.update(patch), "加入房间");
    if (!updatedResult || updatedResult.updated !== 1) throw new Error("加入房间失败");
    return success({ docId, type: currentType, room: updated, viewer: roomViewer(updated, uid) });
  }, 5);
}

async function syncLedger(event, uid, accessPlatform) {
  const docId = cleanText(event.docId, 80);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  const now = Date.now();
  const incoming = normalizeLedger(event.ledger, now, false);

  const moderationResponse = requireDbSuccess(
    await db.collection(ROOM_COLLECTION).doc(docId).get(),
    "读取共享账本"
  );
  const moderationRoom = moderationResponse && Array.isArray(moderationResponse.data)
    ? moderationResponse.data[0]
    : moderationResponse && moderationResponse.data;
  if (hasRoomAccessPlatform(moderationRoom, accessPlatform) && isActiveRoomMember(moderationRoom, uid)) {
    const moderationType = roomTypeFor(moderationRoom);
    if (moderationType === "ledger" || moderationType === "legacy") {
      const currentForModeration = normalizeLedger(moderationRoom.ledger || {}, now, true);
      await moderateMiniProgramText(changedLedgerTexts(incoming, currentForModeration));
    }
  }

  /* 账本必须在云端事务里基于最新版本合并。这样两台手机同时新增不同支出时，
     第二次提交看到的不是旧快照，不会把第一台刚写入的支出整体覆盖掉。 */
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取共享账本");
    const room = response && response.data ? response.data : null;
    if (!hasRoomAccessPlatform(room, accessPlatform) || !isActiveRoomMember(room, uid)) {
      return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    }
    const type = room.toolType || room.roomType || "legacy";
    if (type !== "ledger" && type !== "legacy") return failure("WRONG_ROOM_TYPE", "这个房间不是共享账本");

    if (type === "ledger" && !requireCurrentMembership(room, uid, event.membershipEpoch)) {
      return failure("STALE_MEMBERSHIP", "成员身份已更新，请刷新房间后重试");
    }

    const current = normalizeLedger(room.ledger || {}, now, true);
    const mergedWithUntrustedUids = mergeLedgers(incoming, current);
    const merged = normalizeLedger(
      enforceTrustedLedgerMemberUids(mergedWithUntrustedUids, current, room),
      now,
      true
    );
    validateLedgerReferences(merged);
    const stamp = Math.max(now, Number(current.revision || 0), Number(current.updatedAt || 0)) + 1;
    merged.revision = stamp;
    merged.updatedAt = stamp;
    merged.updatedBy = uid;

    const updatedResult = requireDbSuccess(await ref.update({ ledger: merged, updatedAt: new Date() }), "写入共享账本");
    if (!updatedResult || updatedResult.updated !== 1) throw new Error("写入共享账本失败");
    return success({ docId, ledger: merged });
  }, 5);
}

async function setMeetupPoint(event, uid, accessPlatform) {
  const docId = cleanText(event.docId, 80);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  const source = event.person == null ? null : event.person;
  if (source !== null && !isPlainObject(source)) return failure("INVALID_POINT", "出发点数据无效");
  const now = Date.now();
  const mutationAt = Math.floor(Number(event.mutationAt));
  if (!Number.isFinite(mutationAt) || mutationAt <= 0 || mutationAt > now + 5 * 60 * 1000) {
    return failure("INVALID_POINT", "位置更新时间无效，请校准设备时间后重试");
  }

  if (source) {
    const moderationResponse = requireDbSuccess(
      await db.collection(ROOM_COLLECTION).doc(docId).get(),
      "读取碰面房间"
    );
    const moderationRoom = moderationResponse && Array.isArray(moderationResponse.data)
      ? moderationResponse.data[0]
      : moderationResponse && moderationResponse.data;
    if (hasRoomAccessPlatform(moderationRoom, accessPlatform) && isActiveRoomMember(moderationRoom, uid)) {
      await moderateMiniProgramText([source.name, source.address]);
    }
  }

  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取碰面房间");
    const room = response && response.data ? response.data : null;
    if (!hasRoomAccessPlatform(room, accessPlatform) || !isActiveRoomMember(room, uid)) {
      return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    }
    const type = room.toolType || room.roomType || "legacy";
    if (type !== "midpoint") return failure("WRONG_ROOM_TYPE", "这个房间不是协作碰面房间");

    const meetup = room.meetup && isPlainObject(room.meetup) ? room.meetup : { people: [] };
    const people = Array.isArray(meetup.people) ? meetup.people.slice(0, MAX_ACTIVE_MEMBERS) : [];
    const previous = people.find((person) => person && person.uid === uid) || null;
    const versionKey = membershipVersionKey(uid);
    const memberEpochs = normalizeMemberEpochs(room.memberEpochs);
    const incomingMembershipEpoch = validMembershipEpoch(event.membershipEpoch);
    const storedMembershipEpoch = validMembershipEpoch(memberEpochs[versionKey]);
    if (!incomingMembershipEpoch) {
      return failure("STALE_MEMBERSHIP", "成员身份已更新，请刷新房间后重试");
    }
    if (storedMembershipEpoch && storedMembershipEpoch !== incomingMembershipEpoch) {
      return failure("STALE_MEMBERSHIP", "你已退出或重新加入，请刷新房间后重试");
    }
    if (!storedMembershipEpoch) {
      if (Object.keys(memberEpochs).length >= MAX_MEMBERSHIP_HISTORY) {
        return failure("ROOM_HISTORY_FULL", "这个碰面房间的历史成员过多，请新建房间继续使用");
      }
      /* 兼容升级前创建的房间：新版客户端第一次保存时原子补上 epoch。 */
      memberEpochs[versionKey] = incomingMembershipEpoch;
    }
    const storedVersions = isPlainObject(meetup.pointVersions) ? meetup.pointVersions : {};
    const pointVersions = {};
    Object.keys(storedVersions).forEach((key) => {
      const value = Math.floor(Number(storedVersions[key]));
      if (/^[0-9a-f]{64}$/.test(key) && Number.isFinite(value) && value > 0) {
        pointVersions[key] = value;
      }
    });
    if (!Object.prototype.hasOwnProperty.call(pointVersions, versionKey) && Object.keys(pointVersions).length >= MAX_LEDGER_MEMBERS) {
      return failure("ROOM_HISTORY_FULL", "这个碰面房间的历史成员过多，请新建房间继续使用");
    }
    const currentVersion = Math.max(
      Math.floor(Number(previous && previous.updatedAt)) || 0,
      Math.floor(Number(pointVersions[versionKey])) || 0
    );
    /* 相同版本是幂等重试；更旧版本是迟到请求。两者都直接返回当前状态，
       尤其能避免“删除位置后，旧保存请求又把位置复活”。 */
    if (mutationAt <= currentVersion) {
      return success({ docId, meetup: { ...meetup, people, pointVersions }, members: room.members || [] });
    }
    let point = null;
    if (source) {
      const name = cleanText(source.name, 24);
      const address = cleanText(source.address, 200);
      const lat = Number(source.lat);
      const lng = Number(source.lng);
      if (!name) return failure("NAME_REQUIRED", "请先填写你自己的名字");
      if ((Array.isArray(room.members) ? room.members : []).some((member) => member && member.uid !== uid && member.name === name)) {
        return failure("DUPLICATE_NAME", `房间里已经有人使用“${name}”，请换一个昵称`);
      }
      if (!address || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return failure("INVALID_POINT", "请选择一个有效的出发地点");
      }
      point = {
        uid,
        name,
        address,
        lat,
        lng,
        color: cleanColor(source.color || (previous && previous.color), people.length),
        updatedAt: mutationAt
      };
    }

    const nextPeople = people.filter((person) => person && person.uid !== uid);
    if (point) nextPeople.push(point);
    pointVersions[versionKey] = mutationAt;
    const patch = { meetup: { ...meetup, people: nextPeople, pointVersions }, memberEpochs };
    const members = Array.isArray(room.members) ? room.members : [];
    patch.members = members.map((member) => member && member.uid === uid
      ? { ...member, ...(point ? { name: point.name } : {}), membershipEpoch: incomingMembershipEpoch }
      : member);
    patch.updatedAt = new Date();
    const updatedResult = requireDbSuccess(await ref.update(patch), "更新出发点");
    if (!updatedResult || updatedResult.updated !== 1) throw new Error("更新出发点失败");
    return success({ docId, meetup: patch.meetup, members: patch.members || room.members || [] });
  }, 5);
}

function decisionResponse(docId, meetup) {
  return success({ docId, meetup, decision: meetup.decision || normalizedMeetupDecision(meetup) });
}

async function publishDecisionCandidates(event, uid, accessPlatform) {
  const docId = cleanText(event.docId, 80);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  if (!Array.isArray(event.candidates) || event.candidates.length === 0 || event.candidates.length > MAX_DECISION_CANDIDATES) {
    return failure("INVALID_DECISION", "候选地点需为 1 至 12 个");
  }
  const now = Date.now();
  const moderationResponse = requireDbSuccess(
    await db.collection(ROOM_COLLECTION).doc(docId).get(),
    "审核共同候选地点"
  );
  const moderationRoom = moderationResponse && Array.isArray(moderationResponse.data)
    ? moderationResponse.data[0]
    : moderationResponse && moderationResponse.data;
  if (hasRoomAccessPlatform(moderationRoom, accessPlatform) && isActiveRoomMember(moderationRoom, uid)) {
    await moderateMiniProgramText(event.candidates.flatMap((candidate) => [candidate && candidate.name, candidate && candidate.typeStr]));
  }
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取协作碰面房间");
    const room = response && response.data ? response.data : null;
    if (!hasRoomAccessPlatform(room, accessPlatform)) return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    if (!isActiveRoomMember(room, uid)) return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    if (roomTypeFor(room) !== "midpoint") return failure("WRONG_ROOM_TYPE", "这个房间不是协作碰面房间");
    if (!requireCurrentMembership(room, uid, event.membershipEpoch)) return failure("STALE_MEMBERSHIP", "成员身份已更新，请刷新房间后重试");

    const meetup = room.meetup && isPlainObject(room.meetup) ? room.meetup : { people: [] };
    const currentDecision = normalizedMeetupDecision(meetup, room);
    if (!decisionRoundMatches(event, currentDecision)) return failure("STALE_DECISION", "共同决定已更新，请刷新后重试");
    if (currentDecision.state === "confirmed") return failure("DECISION_CONFIRMED", "地点已确定，请让房主先重新选择");
    const existingById = new Map(currentDecision.candidates.map((candidate) => [candidate.id, candidate]));
    let candidates;
    try {
      candidates = event.candidates.map((candidate) => {
        const name = cleanText(candidate && candidate.name, 80);
        const lat = Number(candidate && candidate.lat);
        const lng = Number(candidate && candidate.lng);
        return normalizeDecisionCandidate(candidate, uid, now, existingById.get(decisionCandidateId(name, lat, lng)));
      });
    } catch (error) {
      if (error && error.publicCode) return failure("INVALID_DECISION", error.message);
      throw error;
    }
    const ids = new Set();
    if (candidates.some((candidate) => ids.has(candidate.id) || !ids.add(candidate.id))) {
      return failure("INVALID_DECISION", "候选地点不能重复");
    }
    const votes = currentDecision.votes.filter((vote) => ids.has(vote.candidateId));
    const confirmedCandidateId = ids.has(currentDecision.confirmedCandidateId) ? currentDecision.confirmedCandidateId : null;
    const decision = {
      roundId: newDecisionRoundId(),
      revision: currentDecision.revision + 1,
      state: "open",
      candidates,
      votes,
      confirmedCandidateId,
      confirmedAt: confirmedCandidateId ? currentDecision.confirmedAt : null,
      confirmedBy: confirmedCandidateId ? currentDecision.confirmedBy : null
    };
    const nextMeetup = { ...meetup, decision };
    const updated = requireDbSuccess(await ref.update({ meetup: nextMeetup, updatedAt: new Date() }), "发布共同候选");
    if (!updated || updated.updated !== 1) throw new Error("发布共同候选失败");
    return decisionResponse(docId, nextMeetup);
  }, 5);
}

async function setDecisionVote(event, uid, accessPlatform) {
  const docId = cleanText(event.docId, 80);
  const candidateId = cleanText(event.candidateId, 64);
  const value = event.value == null || event.value === "" || event.value === "clear" ? "" : cleanText(event.value, 8);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  if (!candidateId || !/^(?:poi_)?[A-Za-z0-9_-]{8,64}$/.test(candidateId) || (value && !/^(want|ok|no)$/.test(value))) {
    return failure("INVALID_DECISION", "投票数据无效");
  }
  const now = Date.now();
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取协作碰面房间");
    const room = response && response.data ? response.data : null;
    if (!hasRoomAccessPlatform(room, accessPlatform)) return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    if (!isActiveRoomMember(room, uid)) return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    if (roomTypeFor(room) !== "midpoint") return failure("WRONG_ROOM_TYPE", "这个房间不是协作碰面房间");
    if (!requireCurrentMembership(room, uid, event.membershipEpoch)) return failure("STALE_MEMBERSHIP", "成员身份已更新，请刷新房间后重试");
    const meetup = room.meetup && isPlainObject(room.meetup) ? room.meetup : { people: [] };
    const decision = normalizedMeetupDecision(meetup, room);
    if (!decision.roundId || !decisionRoundMatches(event, decision)) return failure("STALE_DECISION", "共同决定已更新，请刷新后重试");
    if (!decision.candidates.some((candidate) => candidate.id === candidateId)) return failure("CANDIDATE_NOT_FOUND", "这个候选地点已更新，请刷新后再投票");
    if (decision.confirmedCandidateId) return failure("DECISION_CONFIRMED", "地点已确定，如需调整请由房主重新选择");
    const votes = decision.votes.filter((vote) => !(vote.candidateId === candidateId && vote.uid === uid));
    if (value) votes.push({ candidateId, uid, value, updatedAt: now });
    if (votes.length > decision.candidates.length * MAX_DECISION_VOTES_PER_CANDIDATE) {
      return failure("INVALID_DECISION", "投票数量超过上限");
    }
    const nextMeetup = { ...meetup, decision: { ...decision, revision: decision.revision + 1, votes } };
    const updated = requireDbSuccess(await ref.update({ meetup: nextMeetup, updatedAt: new Date() }), "保存投票");
    if (!updated || updated.updated !== 1) throw new Error("保存投票失败");
    return decisionResponse(docId, nextMeetup);
  }, 5);
}

async function confirmDecisionCandidate(event, uid, accessPlatform) {
  const docId = cleanText(event.docId, 80);
  const candidateId = event.candidateId == null || event.candidateId === "" ? "" : cleanText(event.candidateId, 64);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  if (!/^poi_[a-f0-9]{24}$/.test(candidateId)) return failure("INVALID_DECISION", "请选择一个有效的候选地点");
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取协作碰面房间");
    const room = response && response.data ? response.data : null;
    if (!hasRoomAccessPlatform(room, accessPlatform)) return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    if (!isActiveRoomMember(room, uid)) return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    if (roomTypeFor(room) !== "midpoint") return failure("WRONG_ROOM_TYPE", "这个房间不是协作碰面房间");
    if (!requireCurrentMembership(room, uid, event.membershipEpoch)) return failure("STALE_MEMBERSHIP", "成员身份已更新，请刷新房间后重试");
    if (inferredRoomOwnerUid(room, null) !== uid) return failure("NOT_OWNER", "只有房主可以确定地点");
    const meetup = room.meetup && isPlainObject(room.meetup) ? room.meetup : { people: [] };
    const decision = normalizedMeetupDecision(meetup, room);
    if (!decision.roundId || !decisionRoundMatches(event, decision)) return failure("STALE_DECISION", "共同决定已更新，请刷新后重试");
    if (decision.state === "confirmed") return failure("DECISION_CONFIRMED", "地点已确定，请先重新选择");
    if (!decision.candidates.some((candidate) => candidate.id === candidateId)) {
      return failure("CANDIDATE_NOT_FOUND", "这个候选地点已更新，请刷新后重试");
    }
    const nextMeetup = {
      ...meetup,
      decision: {
        ...decision,
        revision: decision.revision + 1,
        state: "confirmed",
        confirmedCandidateId: candidateId,
        confirmedAt: Date.now(),
        confirmedBy: uid
      }
    };
    const updated = requireDbSuccess(await ref.update({ meetup: nextMeetup, updatedAt: new Date() }), "确定共同地点");
    if (!updated || updated.updated !== 1) throw new Error("更新共同决定失败");
    return decisionResponse(docId, nextMeetup);
  }, 5);
}

async function reopenDecision(event, uid, accessPlatform) {
  const docId = cleanText(event.docId, 80);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取协作碰面房间");
    const room = response && response.data ? response.data : null;
    if (!hasRoomAccessPlatform(room, accessPlatform)) return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    if (!isActiveRoomMember(room, uid)) return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    if (roomTypeFor(room) !== "midpoint") return failure("WRONG_ROOM_TYPE", "这个房间不是协作碰面房间");
    if (!requireCurrentMembership(room, uid, event.membershipEpoch)) return failure("STALE_MEMBERSHIP", "成员身份已更新，请刷新房间后重试");
    if (inferredRoomOwnerUid(room, null) !== uid) return failure("NOT_OWNER", "只有房主可以重新选择地点");
    const meetup = room.meetup && isPlainObject(room.meetup) ? room.meetup : { people: [] };
    const decision = normalizedMeetupDecision(meetup, room);
    if (!decision.roundId || !decisionRoundMatches(event, decision)) return failure("STALE_DECISION", "共同决定已更新，请刷新后重试");
    const nextMeetup = {
      ...meetup,
      decision: {
        roundId: newDecisionRoundId(),
        revision: decision.revision + 1,
        state: "open",
        candidates: decision.candidates,
        votes: [],
        confirmedCandidateId: null,
        confirmedAt: null,
        confirmedBy: null
      }
    };
    const updated = requireDbSuccess(await ref.update({ meetup: nextMeetup, updatedAt: new Date() }), "重新选择地点");
    if (!updated || updated.updated !== 1) throw new Error("重新选择地点失败");
    return decisionResponse(docId, nextMeetup);
  }, 5);
}

async function updateLegacyMembers(event, uid, accessPlatform) {
  const docId = cleanText(event.docId, 80);
  const operation = cleanText(event.operation, 12);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  if (operation !== "add" && operation !== "remove") return failure("INVALID_OPERATION", "成员操作无效");
  const requestedName = operation === "add" ? cleanText(event.name, 24) : "";
  const moderationResponse = requireDbSuccess(
    await db.collection(ROOM_COLLECTION).doc(docId).get(),
    "审核旧版成员"
  );
  const moderationRoom = moderationResponse && Array.isArray(moderationResponse.data)
    ? moderationResponse.data[0]
    : moderationResponse && moderationResponse.data;
  if (!hasRoomAccessPlatform(moderationRoom, accessPlatform) || !isActiveRoomMember(moderationRoom, uid)) {
    return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
  }
  if (operation === "add" && requestedName) await moderateMiniProgramText([requestedName]);

  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取旧版房间");
    const room = response && response.data ? response.data : null;
    if (!hasRoomAccessPlatform(room, accessPlatform)) return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    if (!isActiveRoomMember(room, uid)) {
      return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    }
    const type = room.toolType || room.roomType || "legacy";
    if (type !== "legacy") return failure("WRONG_ROOM_TYPE", "这个房间不使用旧版成员面板");
    const members = Array.isArray(room.members) ? room.members.slice(0, MAX_ACTIVE_MEMBERS) : [];
    let nextMembers = members;
    let nextMemberId = Math.max(Number(room.nextMemberId) || 1, members.length + 1);

    if (operation === "add") {
      const name = requestedName;
      if (!name) return failure("NAME_REQUIRED", "请输入成员名字");
      if (members.length >= MAX_ACTIVE_MEMBERS) return failure("ROOM_FULL", "房间已经达到 50 人上限");
      if (members.some((member) => member && member.name === name)) return failure("DUPLICATE_NAME", `已经有一个叫“${name}”的人了`);
      nextMembers = members.concat({ id: nextMemberId, name, color: COLORS[members.length % COLORS.length] });
      nextMemberId += 1;
    } else {
      const memberId = cleanLedgerId(event.memberId, "成员");
      if (members.length <= 2) return failure("MINIMUM_MEMBERS", "至少保留 2 个人");
      if (!members.some((member) => member && String(member.id) === String(memberId))) {
        return success({ docId, room });
      }
      nextMembers = members.filter((member) => member && String(member.id) !== String(memberId));
    }

    const patch = { members: nextMembers, nextMemberId, updatedAt: new Date() };
    const updatedResult = requireDbSuccess(await ref.update(patch), "更新房间成员");
    if (!updatedResult || updatedResult.updated !== 1) throw new Error("更新房间成员失败");
    return success({ docId, room: { ...room, ...patch } });
  }, 5);
}

async function disbandRoom(event, uid, accessPlatform) {
  const docId = cleanText(event.docId, 80);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取房间");
    const room = response && response.data ? response.data : null;
    if (!room) return success({ removed: true });
    if (!hasRoomAccessPlatform(room, accessPlatform)) return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    if (inferredRoomOwnerUid(room, null) !== uid) return failure("NOT_OWNER", "只有房主可以解散房间");
    const removed = requireDbSuccess(await ref.remove(), "解散房间");
    if (!removed || removed.deleted !== 1) throw new Error("解散房间失败");
    return success({ removed: true });
  }, 5);
}

async function leaveRoom(event, uid, accessPlatform) {
  const docId = cleanText(event.docId, 80);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取房间");
    const room = response && response.data ? response.data : null;
    if (!room) return success({ removed: true });
    if (!hasRoomAccessPlatform(room, accessPlatform)) return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    const inferredOwnerUid = inferredRoomOwnerUid(room, null);
    if (inferredOwnerUid === uid) return failure("OWNER_MUST_DISBAND", "房主需要取消并解散房间");
    if (!isActiveRoomMember(room, uid)) {
      return success({ removed: true });
    }

    const currentMemberUids = Array.isArray(room.memberUids)
      ? room.memberUids
      : activeTopLevelMemberUids(room);
    const patch = {
      memberUids: currentMemberUids.filter((memberUid) => memberUid !== uid),
      members: (Array.isArray(room.members) ? room.members : []).filter((member) => member.uid !== uid),
      updatedAt: new Date()
    };
    if (room.meetup && Array.isArray(room.meetup.people)) {
      const currentDecision = normalizedMeetupDecision(room.meetup, room);
      patch.meetup = {
        ...room.meetup,
        people: room.meetup.people.filter((person) => person.uid !== uid),
        decision: {
          ...currentDecision,
          votes: currentDecision.votes.filter((vote) => vote.uid !== uid)
        }
      };
    }
    const updatedResult = requireDbSuccess(await ref.update(patch), "退出房间");
    if (!updatedResult || updatedResult.updated !== 1) throw new Error("退出房间失败");
    return success({ removed: true });
  }, 5);
}

exports.main = async (event, context) => {
  const uid = callerUid();
  const accessPlatform = callerAccessPlatform();
  if (!uid) return failure("UNAUTHENTICATED", "请先登录后再操作房间");
  try {
    const action = cleanText(event && event.action, 40);
    if (action === "create") return await createRoom(event, uid, accessPlatform);
    if (action === "join") return await joinRoom(event, uid, accessPlatform);
    if (action === "getRoom") return await getRoom(event, uid, accessPlatform);
    if (action === "getProfile") return await getProfile(uid, accessPlatform);
    if (action === "updateProfile") return await updateProfile(event, uid, accessPlatform);
    if (action === "deleteProfile") return await deleteProfile(uid, accessPlatform);
    if (action === "retryAvatarCleanup") return await retryAvatarCleanup(uid, accessPlatform);
    if (action === "listMyRooms") return await listMyRooms(event, uid, accessPlatform);
    if (action === "syncLedger") return await syncLedger(event, uid, accessPlatform);
    if (action === "setMeetupPoint") return await setMeetupPoint(event, uid, accessPlatform);
    if (action === "publishDecisionCandidates") return await publishDecisionCandidates(event, uid, accessPlatform);
    if (action === "setDecisionVote") return await setDecisionVote(event, uid, accessPlatform);
    if (action === "confirmDecisionCandidate") return await confirmDecisionCandidate(event, uid, accessPlatform);
    if (action === "reopenDecision") return await reopenDecision(event, uid, accessPlatform);
    if (action === "updateLegacyMembers") return await updateLegacyMembers(event, uid, accessPlatform);
    if (action === "disband") return await disbandRoom(event, uid, accessPlatform);
    if (action === "leave") return await leaveRoom(event, uid, accessPlatform);
    return failure("UNKNOWN_ACTION", "不支持的房间操作");
  } catch (error) {
    if (error && error.publicCode) return failure(error.publicCode, error.message || "账本数据无效");
    console.error("[roomGateway]", error);
    return failure("GATEWAY_ERROR", "房间服务暂时不可用，请稍后重试");
  }
};

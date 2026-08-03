"use strict";

const crypto = require("node:crypto");
const cloudbase = require("@cloudbase/node-sdk");

const ROOM_COLLECTION = "rooms";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COLORS = ["#0F3D36", "#B8842A", "#3E6E8E", "#A8506E", "#C05B3C", "#4C5C5B"];
const MAX_LEDGER_BYTES = 400 * 1024;
const MAX_ACTIVE_MEMBERS = 50;
const MAX_LEDGER_MEMBERS = 500;
const MAX_LEDGER_EXPENSES = 1000;
const MAX_TOMBSTONES = 2000;
const MAX_MEMBERSHIP_HISTORY = 500;
const JOIN_WINDOW_MS = 5 * 60 * 1000;
const MAX_JOIN_ATTEMPTS_PER_WINDOW = 20;
const joinAttemptBuckets = new Map();
const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const db = app.database();

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

function callerUid() {
  try {
    const userInfo = app.auth().getUserInfo() || {};
    return userInfo.uid || null;
  } catch (_) {
    return null;
  }
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

async function uniqueCode() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomCode();
    const existing = requireDbSuccess(
      await db.collection(ROOM_COLLECTION).where({ code }).limit(1).get(),
      "检查房间码"
    );
    if (!existing.data || existing.data.length === 0) return code;
  }
  throw new Error("暂时无法生成房间码，请稍后再试");
}

function normalizeTypedRoom(source, uid) {
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
    createdAt: new Date()
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

function normalizeLegacyRoom(source, uid) {
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
    members,
    memberUids: [uid],
    nextMemberId: Math.max(Number(source.nextMemberId) || 1, members.length + 1),
    ownerUid: uid,
    tripId: null,
    ledger: null,
    meetup: { people: [] },
    createdAt: new Date()
  };
}

async function createRoom(event, uid) {
  const source = event && event.room && typeof event.room === "object" ? event.room : {};
  const room = source.toolType === "midpoint" || source.toolType === "ledger"
    ? normalizeTypedRoom(source, uid)
    : normalizeLegacyRoom(source, uid);
  const clientRequestId = cleanText(event && event.clientRequestId, 80);
  if (clientRequestId && !/^[A-Za-z0-9_-]{8,80}$/.test(clientRequestId)) {
    return failure("INVALID_REQUEST_ID", "创建请求编号无效，请刷新页面后重试");
  }
  if (clientRequestId) {
    /* 同一台设备超时重试时使用相同文档编号。事务保证只会创建一次，
       即使第一次响应丢失，第二次也会拿回已经创建好的同一个房间。 */
    const docId = `room-${crypto.createHash("sha256").update(`${uid}:${clientRequestId}`).digest("hex").slice(0, 32)}`;
    const existingResponse = requireDbSuccess(
      await db.collection(ROOM_COLLECTION).doc(docId).get(),
      "检查创建请求"
    );
    const existingRoom = existingResponse && Array.isArray(existingResponse.data)
      ? existingResponse.data[0]
      : existingResponse && existingResponse.data;
    if (existingRoom) {
      if (existingRoom.ownerUid === uid && existingRoom.createRequestId === clientRequestId) {
        return success({ docId, room: { ...existingRoom, _id: docId } });
      }
      return failure("CREATE_CONFLICT", "创建请求发生冲突，请刷新页面后重试");
    }
    room.code = await uniqueCode();
    room.createRequestId = clientRequestId;
    return db.runTransaction(async (transaction) => {
      const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
      const response = requireDbSuccess(await ref.get(), "检查创建请求");
      const existing = response && response.data ? response.data : null;
      if (existing) {
        if (existing.ownerUid === uid && existing.createRequestId === clientRequestId) {
          return success({ docId, room: { ...existing, _id: docId } });
        }
        return failure("CREATE_CONFLICT", "创建请求发生冲突，请刷新页面后重试");
      }
      requireDbSuccess(await ref.set(room), "创建房间");
      return success({ docId, room: { ...room, _id: docId } });
    }, 5);
  }
  room.code = await uniqueCode();
  const created = requireDbSuccess(await db.collection(ROOM_COLLECTION).add(room), "创建房间");
  const docId = created.id || created._id;
  if (!docId) throw new Error("创建房间失败");
  return success({ docId, room: { ...room, _id: docId } });
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

async function getRoom(event, uid) {
  const docId = cleanText(event && event.docId, 80);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  const response = requireDbSuccess(
    await db.collection(ROOM_COLLECTION).doc(docId).get(),
    "读取房间"
  );
  const room = response && Array.isArray(response.data) ? response.data[0] : response && response.data;
  /* Do not reveal whether an unknown room exists. A missing room and a room the caller
     has not joined intentionally return the same empty result. */
  if (!isActiveRoomMember(room, uid)) {
    return success({ room: null });
  }
  return success({ room: { ...room, _id: room._id || docId } });
}

async function joinRoom(event, uid) {
  const code = cleanText(event.code, 8).toUpperCase();
  const expectedType = cleanText(event.type, 16);
  const name = cleanText(event.name, 24);
  if (!/^(?:[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}|[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8})$/.test(code)) {
    return failure("INVALID_CODE", "请输入完整的 8 位房间码（旧房间可输入 6 位）");
  }
  if (!consumeJoinAttempt(uid)) return failure("RATE_LIMITED", "尝试次数过多，请 5 分钟后再试");
  const room = await roomByCode(code);
  if (!room) return failure("ROOM_NOT_FOUND", `没有找到房间码“${code}”`);
  const type = room.toolType || room.roomType || "legacy";
  if (expectedType && type !== expectedType) {
    const actual = type === "midpoint" ? "碰面码" : type === "ledger" ? "账本码" : "旧版综合房间码";
    return failure("WRONG_ROOM_TYPE", `这是${actual}，不能加入当前功能`);
  }

  const docId = room._id;
  if ((type === "midpoint" || type === "ledger") && !name) {
    return failure("NAME_REQUIRED", "请先填写你自己的名字");
  }

  /* 加入涉及 memberUids、成员资料与碰面点等多个字段。放进同一个事务，
     避免网络中断或两个人同时加入时只写成一半。 */
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取房间");
    const current = response && response.data ? response.data : null;
    if (!current || current.code !== code) {
      return failure("ROOM_NOT_FOUND", `没有找到房间码“${code}”`);
    }

    const currentType = current.toolType || current.roomType || "legacy";
    if (expectedType && currentType !== expectedType) {
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

    const updatedResult = requireDbSuccess(await ref.update(patch), "加入房间");
    if (!updatedResult || updatedResult.updated !== 1) throw new Error("加入房间失败");
    return success({ docId, room: updated });
  }, 5);
}

async function syncLedger(event, uid) {
  const docId = cleanText(event.docId, 80);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  const now = Date.now();
  const incoming = normalizeLedger(event.ledger, now, false);

  /* 账本必须在云端事务里基于最新版本合并。这样两台手机同时新增不同支出时，
     第二次提交看到的不是旧快照，不会把第一台刚写入的支出整体覆盖掉。 */
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取共享账本");
    const room = response && response.data ? response.data : null;
    if (!isActiveRoomMember(room, uid)) {
      return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    }
    const type = room.toolType || room.roomType || "legacy";
    if (type !== "ledger" && type !== "legacy") return failure("WRONG_ROOM_TYPE", "这个房间不是共享账本");

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

    const updatedResult = requireDbSuccess(await ref.update({ ledger: merged }), "写入共享账本");
    if (!updatedResult || updatedResult.updated !== 1) throw new Error("写入共享账本失败");
    return success({ docId, ledger: merged });
  }, 5);
}

async function setMeetupPoint(event, uid) {
  const docId = cleanText(event.docId, 80);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  const source = event.person == null ? null : event.person;
  if (source !== null && !isPlainObject(source)) return failure("INVALID_POINT", "出发点数据无效");
  const now = Date.now();
  const mutationAt = Math.floor(Number(event.mutationAt));
  if (!Number.isFinite(mutationAt) || mutationAt <= 0 || mutationAt > now + 5 * 60 * 1000) {
    return failure("INVALID_POINT", "位置更新时间无效，请校准设备时间后重试");
  }

  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取碰面房间");
    const room = response && response.data ? response.data : null;
    if (!isActiveRoomMember(room, uid)) {
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
    const updatedResult = requireDbSuccess(await ref.update(patch), "更新出发点");
    if (!updatedResult || updatedResult.updated !== 1) throw new Error("更新出发点失败");
    return success({ docId, meetup: patch.meetup, members: patch.members || room.members || [] });
  }, 5);
}

async function updateLegacyMembers(event, uid) {
  const docId = cleanText(event.docId, 80);
  const operation = cleanText(event.operation, 12);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  if (operation !== "add" && operation !== "remove") return failure("INVALID_OPERATION", "成员操作无效");

  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取旧版房间");
    const room = response && response.data ? response.data : null;
    if (!isActiveRoomMember(room, uid)) {
      return failure("ROOM_NOT_FOUND", "房间已结束或你已退出");
    }
    const type = room.toolType || room.roomType || "legacy";
    if (type !== "legacy") return failure("WRONG_ROOM_TYPE", "这个房间不使用旧版成员面板");
    const members = Array.isArray(room.members) ? room.members.slice(0, MAX_ACTIVE_MEMBERS) : [];
    let nextMembers = members;
    let nextMemberId = Math.max(Number(room.nextMemberId) || 1, members.length + 1);

    if (operation === "add") {
      const name = cleanText(event.name, 24);
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

    const patch = { members: nextMembers, nextMemberId };
    const updatedResult = requireDbSuccess(await ref.update(patch), "更新房间成员");
    if (!updatedResult || updatedResult.updated !== 1) throw new Error("更新房间成员失败");
    return success({ docId, room: { ...room, ...patch } });
  }, 5);
}

async function disbandRoom(event, uid) {
  const docId = cleanText(event.docId, 80);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  const response = requireDbSuccess(
    await db.collection(ROOM_COLLECTION).doc(docId).get(),
    "读取房间"
  );
  const room = response && Array.isArray(response.data) ? response.data[0] : response && response.data;
  if (!room) return success({ removed: true });
  const inferredOwnerUid = inferredRoomOwnerUid(room, null);
  if (inferredOwnerUid !== uid) return failure("NOT_OWNER", "只有房主可以解散房间");
  const removed = requireDbSuccess(
    await db.collection(ROOM_COLLECTION).doc(docId).remove(),
    "解散房间"
  );
  if (!removed || removed.deleted !== 1) throw new Error("解散房间失败");
  return success({ removed: true });
}

async function leaveRoom(event, uid) {
  const docId = cleanText(event.docId, 80);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取房间");
    const room = response && response.data ? response.data : null;
    if (!room) return success({ removed: true });
    const inferredOwnerUid = inferredRoomOwnerUid(room, null);
    if (inferredOwnerUid === uid) return failure("OWNER_MUST_DISBAND", "房主需要取消并解散房间");
    if (!isActiveRoomMember(room, uid)) {
      return success({ removed: true });
    }

    const patch = {
      memberUids: room.memberUids.filter((memberUid) => memberUid !== uid),
      members: (Array.isArray(room.members) ? room.members : []).filter((member) => member.uid !== uid)
    };
    if (room.meetup && Array.isArray(room.meetup.people)) {
      patch.meetup = {
        ...room.meetup,
        people: room.meetup.people.filter((person) => person.uid !== uid)
      };
    }
    const updatedResult = requireDbSuccess(await ref.update(patch), "退出房间");
    if (!updatedResult || updatedResult.updated !== 1) throw new Error("退出房间失败");
    return success({ removed: true });
  }, 5);
}

exports.main = async (event) => {
  const uid = callerUid();
  if (!uid) return failure("UNAUTHENTICATED", "请先登录后再操作房间");
  try {
    const action = cleanText(event && event.action, 24);
    if (action === "create") return await createRoom(event, uid);
    if (action === "join") return await joinRoom(event, uid);
    if (action === "getRoom") return await getRoom(event, uid);
    if (action === "syncLedger") return await syncLedger(event, uid);
    if (action === "setMeetupPoint") return await setMeetupPoint(event, uid);
    if (action === "updateLegacyMembers") return await updateLegacyMembers(event, uid);
    if (action === "disband") return await disbandRoom(event, uid);
    if (action === "leave") return await leaveRoom(event, uid);
    return failure("UNKNOWN_ACTION", "不支持的房间操作");
  } catch (error) {
    if (error && error.publicCode) return failure(error.publicCode, error.message || "账本数据无效");
    console.error("[roomGateway]", error);
    return failure("GATEWAY_ERROR", "房间服务暂时不可用，请稍后重试");
  }
};

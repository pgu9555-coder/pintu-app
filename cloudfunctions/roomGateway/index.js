"use strict";

const crypto = require("node:crypto");
const cloudbase = require("@cloudbase/node-sdk");

const ROOM_COLLECTION = "rooms";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COLORS = ["#0F3D36", "#B8842A", "#3E6E8E", "#A8506E", "#C05B3C", "#4C5C5B"];
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

function callerUid() {
  try {
    const userInfo = app.auth().getUserInfo() || {};
    return userInfo.uid || null;
  } catch (_) {
    return null;
  }
}

function randomCode() {
  const bytes = crypto.randomBytes(6);
  let code = "";
  for (let index = 0; index < bytes.length; index += 1) {
    code += CODE_CHARS[bytes[index] % CODE_CHARS.length];
  }
  return code;
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
  const member = {
    id: cleanText(inputMember.id, 80) || sharedMemberId(),
    uid,
    name: memberName,
    color: COLORS[0]
  };
  const roomName = cleanText(source.name, 60) || `${memberName}${type === "midpoint" ? "发起的碰面" : "发起的账本"}`;
  const now = Date.now();
  const room = {
    name: roomName,
    toolType: type,
    members: [member],
    memberUids: [uid],
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
  const sourceMembers = Array.isArray(source.members) ? source.members.slice(0, 50) : [];
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

async function joinRoom(event, uid) {
  const code = cleanText(event.code, 6).toUpperCase();
  const expectedType = cleanText(event.type, 16);
  const name = cleanText(event.name, 24);
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)) {
    return failure("INVALID_CODE", "请输入完整的 6 位房间码");
  }
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

    const memberUids = Array.from(new Set([...(Array.isArray(current.memberUids) ? current.memberUids : []), uid]));
    const patch = { memberUids };
    let updated = { ...current, memberUids };

    if (currentType === "midpoint" || currentType === "ledger") {
      const members = Array.isArray(current.members) ? current.members : [];
      if (!members.some((member) => member.uid === uid) && members.length >= 50) {
        return failure("ROOM_FULL", "这个房间已经达到 50 人上限");
      }
      const duplicate = members.some((member) => member.name === name && member.uid && member.uid !== uid);
      if (duplicate) return failure("DUPLICATE_NAME", `房间里已经有人使用“${name}”，请换一个昵称`);

      const ledgerMembers = current.ledger && Array.isArray(current.ledger.members) ? current.ledger.members : [];
      const previous = members.find((member) => member.uid === uid) || ledgerMembers.find((member) => member.uid === uid);
      const member = {
        id: previous && previous.id ? previous.id : sharedMemberId(),
        uid,
        name,
        color: (previous && previous.color) || COLORS[members.length % COLORS.length]
      };
      const nextMembers = members.filter((item) => item.uid !== uid).concat(member);
      const nextMemberId = Math.max(Number(current.nextMemberId) || 1, nextMembers.length + 1);
      patch.members = nextMembers;
      patch.nextMemberId = nextMemberId;
      updated = { ...updated, members: nextMembers, nextMemberId };

      if (currentType === "midpoint") {
        const meetup = current.meetup && typeof current.meetup === "object" ? current.meetup : { people: [] };
        const people = Array.isArray(meetup.people) ? meetup.people : [];
        const previousPoint = people.find((person) => person.uid === uid);
        const point = previousPoint
          ? { ...previousPoint, uid, name }
          : { uid, name, address: "", lat: null, lng: null, color: COLORS[people.length % COLORS.length] };
        const nextMeetup = { ...meetup, people: people.filter((person) => person.uid !== uid).concat(point) };
        patch.meetup = nextMeetup;
        updated = { ...updated, meetup: nextMeetup };
      }

      if (currentType === "ledger" && current.ledger && typeof current.ledger === "object") {
        const previousLedgerMember = ledgerMembers.find((item) => item.uid === uid);
        const stamp = Math.max(
          Date.now(),
          Number(previousLedgerMember && previousLedgerMember.updatedAt) || 0,
          Number(current.ledger.updatedAt) || 0,
          Number(current.ledger.revision) || 0
        ) + 1;
        const ledgerMember = {
          ...(previousLedgerMember || {}),
          ...member,
          createdAt: (previousLedgerMember && previousLedgerMember.createdAt) || stamp,
          updatedAt: stamp,
          updatedBy: uid
        };
        const nextLedgerMembers = ledgerMembers.filter((item) => item.uid !== uid).concat(ledgerMember);
        const nextLedger = {
          ...current.ledger,
          members: nextLedgerMembers,
          nextMemberId: Math.max(Number(current.ledger.nextMemberId) || 1, nextLedgerMembers.length + 1),
          revision: stamp,
          updatedAt: stamp,
          updatedBy: uid
        };
        patch.ledger = nextLedger;
        updated = { ...updated, ledger: nextLedger };
      }
    }

    const updatedResult = requireDbSuccess(await ref.update(patch), "加入房间");
    if (!updatedResult || updatedResult.updated !== 1) throw new Error("加入房间失败");
    return success({ docId, room: updated });
  }, 5);
}

async function leaveRoom(event, uid) {
  const docId = cleanText(event.docId, 80);
  if (!docId) return failure("ROOM_REQUIRED", "缺少房间编号");
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(ROOM_COLLECTION).doc(docId);
    const response = requireDbSuccess(await ref.get(), "读取房间");
    const room = response && response.data ? response.data : null;
    if (!room) return success({ removed: true });
    if (room.ownerUid === uid) return failure("OWNER_MUST_DISBAND", "房主需要取消并解散房间");
    if (!Array.isArray(room.memberUids) || !room.memberUids.includes(uid)) {
      return success({ removed: true });
    }

    const patch = {
      memberUids: room.memberUids.filter((memberUid) => memberUid !== uid),
      members: (Array.isArray(room.members) ? room.members : []).filter((member) => member.uid !== uid)
    };
    if (room.meetup && Array.isArray(room.meetup.people)) {
      patch.meetup = { ...room.meetup, people: room.meetup.people.filter((person) => person.uid !== uid) };
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
    if (action === "leave") return await leaveRoom(event, uid);
    return failure("UNKNOWN_ACTION", "不支持的房间操作");
  } catch (error) {
    console.error("[roomGateway]", error);
    return failure("GATEWAY_ERROR", "房间服务暂时不可用，请稍后重试");
  }
};

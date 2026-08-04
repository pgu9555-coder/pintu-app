const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

let currentUid = null;
let currentWxContext = null;
let nextModerationSuggestion = "pass";
const moderationCalls = [];
let nextId = 1;
const rooms = new Map();

function clone(value) {
  return structuredClone(value);
}

function roomCollection(inTransaction) {
  return {
    where(query) {
      return {
        limit() {
          return this;
        },
        async get() {
          const matches = [...rooms.values()].filter((room) =>
            Object.keys(query).every((key) => room[key] === query[key])
          );
          return { data: clone(matches) };
        }
      };
    },
    async add(room) {
      const id = `room-${nextId++}`;
      rooms.set(id, { ...clone(room), _id: id });
      return { id };
    },
    doc(id) {
      return {
        async get() {
          const room = rooms.get(id);
          return { data: inTransaction ? clone(room || null) : room ? [clone(room)] : [] };
        },
        async update(patch) {
          const room = rooms.get(id);
          if (!room) return { updated: 0 };
          rooms.set(id, { ...room, ...clone(patch) });
          return { updated: 1 };
        },
        async set(value) {
          rooms.set(id, { ...clone(value), _id: id });
          return { set: 1 };
        },
        async remove() {
          if (!rooms.has(id)) return { deleted: 0 };
          rooms.delete(id);
          return { deleted: 1 };
        }
      };
    }
  };
}

const fakeCloudbase = {
  SYMBOL_CURRENT_ENV: Symbol("current-env"),
  init() {
    return {
      auth() {
        return {
          getUserInfo() {
            return currentUid ? { uid: currentUid } : {};
          }
        };
      },
      database() {
        return {
          collection() {
            return roomCollection(false);
          },
          async runTransaction(callback) {
            return callback({
              collection() {
                return roomCollection(true);
              }
            });
          }
        };
      }
    };
  }
};

const fakeWxCloud = {
  DYNAMIC_CURRENT_ENV: Symbol("dynamic-current-env"),
  init() {},
  openapi: {
    security: {
      async msgSecCheck(options) {
        moderationCalls.push(clone(options));
        const suggest = nextModerationSuggestion;
        nextModerationSuggestion = "pass";
        return { result: { suggest } };
      }
    }
  },
  getWXContext() {
    return currentWxContext || {};
  }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "@cloudbase/node-sdk") return fakeCloudbase;
  if (request === "wx-server-sdk") return fakeWxCloud;
  return originalLoad.call(this, request, parent, isMain);
};

const gatewayPath = path.join(__dirname, "..", "cloudfunctions", "roomGateway", "index.js");
const gateway = require(gatewayPath);
Module._load = originalLoad;

async function call(uid, data) {
  currentUid = uid;
  currentWxContext = null;
  return gateway.main(data || {});
}

async function callWx(openid, data, appid = "wx-test-pintu") {
  currentUid = null;
  currentWxContext = openid ? { OPENID: openid, APPID: appid } : {};
  return gateway.main(data || {});
}

async function main() {
  const spoofed = await call(null, { action: "create", userInfo: { uid: "forged" }, room: {} });
  assert.equal(spoofed.code, "UNAUTHENTICATED", "client-supplied uid must never be trusted");

  const miniSpoofed = await callWx(null, { action: "create", userInfo: { uid: "forged-wx" }, room: {} });
  assert.equal(miniSpoofed.code, "UNAUTHENTICATED", "a forged mini-program event identity must never be trusted");

  const wxOwnerUid = "wx:wx-test-pintu:openid-owner";
  const wxMemberUid = "wx:wx-test-pintu:openid-member";
  const wxCreated = await callWx("openid-owner", {
    action: "create",
    room: { toolType: "ledger", name: "微信账本", members: [{ id: "wx-owner", name: "微信房主" }] }
  });
  assert.equal(wxCreated.ok, true, "a trusted WeChat OPENID can create a room");
  assert.deepEqual(wxCreated.data.room.memberUids, [wxOwnerUid]);
  assert.equal(wxCreated.data.viewer.uid, wxOwnerUid);
  assert.equal(wxCreated.data.viewer.isOwner, true);
  assert.equal(wxCreated.data.room.schemaVersion, 4);
  assert.equal(wxCreated.data.room.accessPlatform, "wechat-mini-program");
  assert.ok(wxCreated.data.viewer.memberId);
  assert.ok(wxCreated.data.viewer.membershipEpoch);
  assert.equal(moderationCalls.some((call) => call.openid === "openid-owner" && call.version === 2), true);
  const wxDocId = wxCreated.data.docId;
  const wxJoined = await callWx("openid-member", {
    action: "join", type: "ledger", code: wxCreated.data.room.code, name: "微信成员"
  });
  assert.equal(wxJoined.ok, true, "a second WeChat OPENID can join by room code");
  assert.equal(wxJoined.data.viewer.uid, wxMemberUid);
  assert.equal(wxJoined.data.viewer.isOwner, false);
  const wxRead = await callWx("openid-member", { action: "getRoom", docId: wxDocId });
  assert.equal(wxRead.ok, true, "a joined WeChat identity can read the room");
  assert.equal(wxRead.data.room.members.some((member) => member.uid === wxMemberUid), true);
  assert.equal(wxRead.data.viewer.uid, wxMemberUid, "room reads return only the authenticated caller viewer");
  const wxLedger = clone(wxRead.data.room.ledger);
  wxLedger.name = "微信同步账本";
  wxLedger.nameUpdatedAt = Date.now();
  wxLedger.updatedAt = wxLedger.nameUpdatedAt;
  wxLedger.revision = wxLedger.nameUpdatedAt;
  const wxSynced = await callWx("openid-member", {
    action: "syncLedger", docId: wxDocId, ledger: wxLedger, membershipEpoch: wxRead.data.viewer.membershipEpoch
  });
  assert.equal(wxSynced.ok, true, "a joined WeChat identity can sync a ledger");
  const wxOwnerRead = await callWx("openid-owner", { action: "getRoom", docId: wxDocId });
  assert.equal(wxOwnerRead.data.room.ledger.name, "微信同步账本", "WeChat writes are shared between OPENIDs");
  const wxOutsiderRead = await callWx("openid-outsider", { action: "getRoom", docId: wxDocId });
  assert.equal(wxOutsiderRead.data.room, null, "different WeChat OPENIDs remain isolated from private rooms");
  assert.equal(wxOutsiderRead.data.viewer, null);
  const wxForgedIdentity = await callWx("openid-outsider", {
    action: "getRoom", docId: wxDocId, userInfo: { uid: wxOwnerUid }
  });
  assert.equal(wxForgedIdentity.data.room, null, "event.userInfo cannot impersonate a WeChat room owner");
  const forgedPlatformRead = await call(wxOwnerUid, {
    action: "getRoom", docId: wxDocId, accessPlatform: "wechat-mini-program"
  });
  assert.equal(forgedPlatformRead.data.room, null, "event platform fields cannot expose a mini-program room to web callers");
  const forgedPlatformJoin = await call("web-joiner", {
    action: "join", code: wxCreated.data.room.code, type: "ledger", name: "Web forged platform", accessPlatform: "wechat-mini-program"
  });
  assert.equal(forgedPlatformJoin.code, "ROOM_NOT_FOUND");
  const forgedPlatformWrite = await call(wxOwnerUid, {
    action: "syncLedger", docId: wxDocId, ledger: wxLedger, membershipEpoch: wxCreated.data.viewer.membershipEpoch,
    accessPlatform: "wechat-mini-program"
  });
  assert.equal(forgedPlatformWrite.code, "ROOM_NOT_FOUND", "web writes must not cross into a mini-program room");
  const platformRequestId = "platform_idempotency_123";
  const wxIdempotent = await callWx("openid-idempotent", {
    action: "create", clientRequestId: platformRequestId,
    room: { toolType: "ledger", name: "平台幂等", members: [{ name: "平台房主" }] }
  });
  const crossPlatformRetry = await call("wx:wx-test-pintu:openid-idempotent", {
    action: "create", clientRequestId: platformRequestId,
    room: { toolType: "ledger", name: "平台幂等", members: [{ name: "平台房主" }] },
    accessPlatform: "wechat-mini-program"
  });
  assert.equal(crossPlatformRetry.ok, true);
  assert.notEqual(crossPlatformRetry.data.docId, wxIdempotent.data.docId, "create idempotency must not reuse a room from another platform");
  assert.equal(crossPlatformRetry.data.room.accessPlatform, "web");

  const wxMidpoint = await callWx("openid-owner", {
    action: "create", room: { toolType: "midpoint", name: "微信碰面", members: [{ name: "微信房主" }] }
  });
  nextModerationSuggestion = "risky";
  const riskyCandidates = await callWx("openid-owner", {
    action: "publishDecisionCandidates", docId: wxMidpoint.data.docId, membershipEpoch: wxMidpoint.data.viewer.membershipEpoch,
    candidates: [{ name: "危险候选", lat: 22.5, lng: 113.9, typeStr: "餐厅", dist: 1, isMall: false, isDrink: false }]
  });
  assert.equal(riskyCandidates.code, "CONTENT_REJECTED", "candidate text must fail closed when mini-program moderation flags it");
  const wxLegacy = await callWx("openid-owner", {
    action: "create", room: { name: "微信旧房间", members: [{ name: "甲" }, { name: "乙" }] }
  });
  nextModerationSuggestion = "risky";
  const riskyLegacyAdd = await callWx("openid-owner", {
    action: "updateLegacyMembers", docId: wxLegacy.data.docId, operation: "add", name: "危险成员"
  });
  assert.equal(riskyLegacyAdd.code, "CONTENT_REJECTED", "legacy member additions must fail closed when moderation flags them");
  assert.equal(rooms.get(wxLegacy.data.docId).members.length, 2);

  const beforeRiskyCreate = rooms.size;
  nextModerationSuggestion = "risky";
  const riskyCreate = await callWx("openid-risky", {
    action: "create",
    room: { toolType: "ledger", name: "不合规内容", members: [{ name: "风险用户" }] }
  });
  assert.equal(riskyCreate.code, "CONTENT_REJECTED", "risky mini-program text must be rejected server-side");
  assert.equal(rooms.size, beforeRiskyCreate, "rejected content must not create a room");

  const created = await call("owner", {
    action: "create",
    room: {
      toolType: "ledger",
      name: "安全测试账本",
      members: [{ id: "owner-member", name: "房主" }]
    }
  });
  assert.equal(created.ok, true);
  assert.match(created.data.room.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  assert.equal(created.data.docId, `room-code-${created.data.room.code}`, "the room code is reserved by an atomic document id");
  assert.deepEqual(
    { uid: created.data.viewer.uid, isOwner: created.data.viewer.isOwner },
    { uid: "owner", isOwner: true }
  );
  assert.deepEqual(created.data.room.memberUids, ["owner"]);
  assert.equal(created.data.room.schemaVersion, 4);
  assert.equal(created.data.room.accessPlatform, "web");
  assert.deepEqual(created.data.room.lifecycle.policy, "owner-disband-only");
  assert.equal(typeof created.data.room.lifecycle.createdAtMs, "number");
  assert.equal(Object.hasOwn(created.data.room, "expiresAt"), false);
  const { docId, room } = created.data;

  const ownerRead = await call("owner", { action: "getRoom", docId });
  assert.equal(ownerRead.ok, true);
  assert.equal(ownerRead.data.room._id, docId);
  assert.equal(ownerRead.data.viewer.uid, "owner");
  const miniForgedWebRead = await callWx("openid-owner", {
    action: "getRoom", docId, accessPlatform: "web"
  });
  assert.equal(miniForgedWebRead.data.room, null, "event platform fields cannot expose a web room to mini-program callers");
  const miniForgedWebJoin = await callWx("openid-member", {
    action: "join", code: created.data.room.code, type: "ledger", name: "Mini forged platform", accessPlatform: "web"
  });
  assert.equal(miniForgedWebJoin.code, "ROOM_NOT_FOUND");
  const miniForgedWebWrite = await callWx("openid-owner", {
    action: "syncLedger", docId, ledger: clone(created.data.room.ledger), membershipEpoch: created.data.viewer.membershipEpoch,
    accessPlatform: "web"
  });
  assert.equal(miniForgedWebWrite.code, "ROOM_NOT_FOUND", "mini-program writes must not cross into a web room");
  const outsiderRead = await call("not-a-member", { action: "getRoom", docId });
  assert.equal(outsiderRead.ok, true);
  assert.equal(outsiderRead.data.room, null, "getRoom must not expose rooms to non-members");

  const idempotentRequest = {
    action: "create",
    clientRequestId: "request_12345678",
    room: { toolType: "ledger", name: "幂等创建", members: [{ name: "创建者" }] }
  };
  const idempotentFirst = await call("idempotent-owner", idempotentRequest);
  const roomCountAfterFirstCreate = rooms.size;
  const idempotentSecond = await call("idempotent-owner", idempotentRequest);
  assert.equal(idempotentFirst.ok, true);
  assert.equal(idempotentSecond.ok, true);
  assert.equal(idempotentSecond.data.docId, idempotentFirst.data.docId);
  assert.equal(idempotentSecond.data.room.code, idempotentFirst.data.room.code);
  assert.equal(rooms.size, roomCountAfterFirstCreate, "a retried create request must not create a duplicate room");

  const duplicate = await call("stranger-1", {
    action: "join",
    type: "ledger",
    code: room.code,
    name: "房主"
  });
  assert.equal(duplicate.code, "DUPLICATE_NAME");
  assert.equal(rooms.get(docId).memberUids.includes("stranger-1"), false);

  const joined = await call("member", {
    action: "join",
    type: "ledger",
    code: room.code,
    name: "成员"
  });
  assert.equal(joined.ok, true);
  assert.equal(joined.data.room.memberUids.includes("member"), true);
  assert.equal(joined.data.room.members.some((item) => item.uid === "member"), true);
  assert.equal(joined.data.room.ledger.members.some((item) => item.uid === "member"), true);
  const ownerEpoch = created.data.viewer.membershipEpoch;
  const memberEpoch = joined.data.viewer.membershipEpoch;
  const memberRead = await call("member", { action: "getRoom", docId });
  assert.equal(memberRead.data.room.memberUids.includes("member"), true);

  const wrongType = await call("stranger-2", {
    action: "join",
    type: "midpoint",
    code: room.code,
    name: "路人"
  });
  assert.equal(wrongType.code, "WRONG_ROOM_TYPE");
  assert.equal(rooms.get(docId).memberUids.includes("stranger-2"), false);

  const autoLedger = await call("auto-ledger", {
    action: "join",
    type: "auto",
    code: room.code,
    name: "自动账本成员"
  });
  assert.equal(autoLedger.ok, true);
  assert.equal(autoLedger.data.type, "ledger");
  assert.equal(autoLedger.data.room.toolType, "ledger");

  const baseLedger = clone(rooms.get(docId).ledger);
  const ownerMember = baseLedger.members.find((item) => item.uid === "owner");
  const joinedMember = baseLedger.members.find((item) => item.uid === "member");
  const stamp = Date.now();
  const ownerExpense = {
    id: "expense-owner",
    desc: "房主的车票",
    amountCents: 12000,
    payerId: ownerMember.id,
    splitIds: [ownerMember.id, joinedMember.id],
    createdAt: stamp,
    updatedAt: stamp,
    updatedBy: "owner"
  };
  const memberExpense = {
    id: "expense-member",
    desc: "成员的酒店",
    amountCents: 24000,
    payerId: joinedMember.id,
    splitIds: [ownerMember.id, joinedMember.id],
    createdAt: stamp + 1,
    updatedAt: stamp + 1,
    updatedBy: "member"
  };

  const ownerSync = await call("owner", {
    action: "syncLedger",
    docId,
    membershipEpoch: ownerEpoch,
    ledger: { ...clone(baseLedger), expenses: [ownerExpense], revision: stamp, updatedAt: stamp, updatedBy: "owner" }
  });
  assert.equal(ownerSync.ok, true);
  const memberSync = await call("member", {
    action: "syncLedger",
    docId,
    membershipEpoch: memberEpoch,
    ledger: { ...clone(baseLedger), expenses: [memberExpense], revision: stamp + 1, updatedAt: stamp + 1, updatedBy: "member" }
  });
  assert.equal(memberSync.ok, true);
  assert.deepEqual(
    memberSync.data.ledger.expenses.map((item) => item.id).sort(),
    ["expense-member", "expense-owner"],
    "two stale devices must converge without losing either expense"
  );

  const forgedUidLedger = clone(rooms.get(docId).ledger);
  const forgedAt = Date.now() + 1000;
  forgedUidLedger.members = forgedUidLedger.members.map((item) => ({
    ...item,
    uid: `forged-${item.uid || item.id}`,
    updatedAt: forgedAt,
    updatedBy: "owner"
  }));
  forgedUidLedger.members.push({
    id: "manual-member",
    uid: "forged-manual-uid",
    name: "Manual participant",
    color: "#0F3D36",
    createdAt: forgedAt,
    updatedAt: forgedAt,
    updatedBy: "owner"
  });
  forgedUidLedger.revision = forgedAt;
  forgedUidLedger.updatedAt = forgedAt;
  const forgedUidSync = await call("owner", { action: "syncLedger", docId, membershipEpoch: ownerEpoch, ledger: forgedUidLedger });
  assert.equal(forgedUidSync.ok, true);
  assert.equal(forgedUidSync.data.ledger.members.find((item) => item.id === ownerMember.id).uid, "owner");
  assert.equal(forgedUidSync.data.ledger.members.find((item) => item.id === joinedMember.id).uid, "member");
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      forgedUidSync.data.ledger.members.find((item) => item.id === "manual-member"),
      "uid"
    ),
    false,
    "a client-created ledger identity must not be allowed to claim an authentication uid"
  );

  const beforeDeniedSync = JSON.stringify(rooms.get(docId).ledger);
  const deniedSync = await call("stranger-3", { action: "syncLedger", docId, ledger: baseLedger });
  assert.equal(deniedSync.code, "ROOM_NOT_FOUND");
  assert.equal(JSON.stringify(rooms.get(docId).ledger), beforeDeniedSync);

  const futureLedger = clone(memberSync.data.ledger);
  futureLedger.nameUpdatedAt = Date.now() + 10 * 60 * 1000;
  const futureSync = await call("owner", { action: "syncLedger", docId, membershipEpoch: ownerEpoch, ledger: futureLedger });
  assert.equal(futureSync.code, "INVALID_LEDGER");
  assert.equal(JSON.stringify(rooms.get(docId).ledger), beforeDeniedSync);

  const invalidReferenceLedger = clone(memberSync.data.ledger);
  invalidReferenceLedger.expenses.push({
    id: "expense-invalid",
    desc: "无效支出",
    amountCents: 100,
    payerId: "missing-member",
    splitIds: [ownerMember.id],
    createdAt: stamp + 2,
    updatedAt: stamp + 2,
    updatedBy: "owner"
  });
  const invalidReference = await call("owner", { action: "syncLedger", docId, membershipEpoch: ownerEpoch, ledger: invalidReferenceLedger });
  assert.equal(invalidReference.code, "INVALID_LEDGER");
  assert.equal(JSON.stringify(rooms.get(docId).ledger), beforeDeniedSync);

  const injectedIdLedger = clone(memberSync.data.ledger);
  injectedIdLedger.members[0].id = 'x" onmouseover="alert(1)';
  const injectedId = await call("owner", { action: "syncLedger", docId, membershipEpoch: ownerEpoch, ledger: injectedIdLedger });
  assert.equal(injectedId.code, "INVALID_LEDGER");
  assert.equal(JSON.stringify(rooms.get(docId).ledger), beforeDeniedSync);

  const midpointCreated = await call("mid-owner", {
    action: "create",
    room: { toolType: "midpoint", name: "碰面测试", members: [{ name: "碰面房主" }] }
  });
  assert.equal(midpointCreated.ok, true);
  assert.equal(midpointCreated.data.room.schemaVersion, 4);
  assert.deepEqual(midpointCreated.data.room.lifecycle.policy, "owner-disband-only");
  assert.equal(typeof midpointCreated.data.room.lifecycle.createdAtMs, "number");
  assert.equal(Object.hasOwn(midpointCreated.data.room, "expiresAt"), false);
  const midpointDocId = midpointCreated.data.docId;
  const midpointEpoch = midpointCreated.data.room.members[0].membershipEpoch;
  const midpointSync = await call("mid-owner", { action: "syncLedger", docId: midpointDocId, ledger: baseLedger });
  assert.equal(midpointSync.code, "WRONG_ROOM_TYPE");
  const autoMidpoint = await call("auto-midpoint", {
    action: "join",
    type: "auto",
    code: midpointCreated.data.room.code,
    name: "自动碰面成员"
  });
  assert.equal(autoMidpoint.ok, true);
  assert.equal(autoMidpoint.data.type, "midpoint");
  assert.equal(autoMidpoint.data.room.toolType, "midpoint");
  const autoMidpointLeft = await call("auto-midpoint", { action: "leave", docId: midpointDocId });
  assert.equal(autoMidpointLeft.ok, true);
  const pointSaved = await call("mid-owner", {
    action: "setMeetupPoint",
    docId: midpointDocId,
    membershipEpoch: midpointEpoch,
    mutationAt: stamp + 10,
    person: { name: "新名字", address: "深圳市南山区华侨城", lat: 22.54, lng: 113.98, color: "red;onmouseover=alert(1)" }
  });
  assert.equal(pointSaved.ok, true);
  assert.equal(rooms.get(midpointDocId).meetup.people[0].uid, "mid-owner");
  assert.match(rooms.get(midpointDocId).meetup.people[0].color, /^#[0-9A-F]{6}$/);
  const stalePoint = await call("mid-owner", {
    action: "setMeetupPoint",
    docId: midpointDocId,
    membershipEpoch: midpointEpoch,
    mutationAt: stamp + 9,
    person: { name: "旧名字", address: "旧地址", lat: 1, lng: 1 }
  });
  assert.equal(stalePoint.ok, true);
  assert.equal(rooms.get(midpointDocId).meetup.people[0].address, "深圳市南山区华侨城");
  const pointDeleted = await call("mid-owner", {
    action: "setMeetupPoint",
    docId: midpointDocId,
    membershipEpoch: midpointEpoch,
    mutationAt: stamp + 12,
    person: null
  });
  assert.equal(pointDeleted.ok, true);
  assert.equal(rooms.get(midpointDocId).meetup.people.length, 0);
  await call("mid-owner", {
    action: "setMeetupPoint",
    docId: midpointDocId,
    membershipEpoch: midpointEpoch,
    mutationAt: stamp + 11,
    person: { name: "迟到请求", address: "不应复活", lat: 2, lng: 2 }
  });
  assert.equal(rooms.get(midpointDocId).meetup.people.length, 0, "a stale request must not resurrect a deleted point");

  const midpointMemberJoined = await call("mid-member", {
    action: "join",
    type: "midpoint",
    code: midpointCreated.data.room.code,
    name: "碰面成员"
  });
  assert.equal(midpointMemberJoined.ok, true);
  const oldMemberEpoch = midpointMemberJoined.data.room.members.find((item) => item.uid === "mid-member").membershipEpoch;
  const midpointMemberLeft = await call("mid-member", { action: "leave", docId: midpointDocId });
  assert.equal(midpointMemberLeft.ok, true);
  const midpointMemberRejoined = await call("mid-member", {
    action: "join",
    type: "midpoint",
    code: midpointCreated.data.room.code,
    name: "碰面成员"
  });
  const newMemberEpoch = midpointMemberRejoined.data.room.members.find((item) => item.uid === "mid-member").membershipEpoch;
  assert.notEqual(newMemberEpoch, oldMemberEpoch, "rejoining must rotate the membership epoch");
  const delayedOldMembershipPoint = await call("mid-member", {
    action: "setMeetupPoint",
    docId: midpointDocId,
    membershipEpoch: oldMemberEpoch,
    mutationAt: stamp + 30,
    person: { name: "旧身份", address: "不应写入", lat: 3, lng: 3 }
  });
  assert.equal(delayedOldMembershipPoint.code, "STALE_MEMBERSHIP");
  assert.equal(rooms.get(midpointDocId).meetup.people.some((item) => item.address === "不应写入"), false);

  /* Shared decision: all writes are membership-, round-, and revision-bound. */
  const ownerDecisionEpoch = rooms.get(midpointDocId).members.find((item) => item.uid === "mid-owner").membershipEpoch;
  const decisionCandidates = [
    { id: "forged-client-id", name: "候选商场", lat: 22.54000001, lng: 113.98000001, typeStr: "购物中心", dist: 320, isMall: true, isDrink: false },
    { id: "also-forged", name: "候选咖啡", lat: 22.55, lng: 113.99, typeStr: "咖啡厅", dist: 610, isMall: false, isDrink: true }
  ];
  const outsiderPublish = await call("decision-outsider", {
    action: "publishDecisionCandidates", docId: midpointDocId, membershipEpoch: "epoch_decision_outsider_123", candidates: decisionCandidates
  });
  assert.equal(outsiderPublish.code, "ROOM_NOT_FOUND", "outsiders must not publish candidates");
  const wrongTypeDecision = await call("idempotent-owner", {
    action: "publishDecisionCandidates", docId: idempotentFirst.data.docId,
    membershipEpoch: idempotentFirst.data.room.members[0].membershipEpoch, candidates: decisionCandidates
  });
  assert.equal(wrongTypeDecision.code, "WRONG_ROOM_TYPE");
  const emptyDecision = await call("mid-owner", {
    action: "publishDecisionCandidates", docId: midpointDocId, membershipEpoch: ownerDecisionEpoch, candidates: []
  });
  assert.equal(emptyDecision.code, "INVALID_DECISION", "an empty candidate list must not erase the shared decision");
  const publishedDecision = await call("mid-owner", {
    action: "publishDecisionCandidates", docId: midpointDocId, membershipEpoch: ownerDecisionEpoch, candidates: decisionCandidates
  });
  assert.equal(publishedDecision.ok, true);
  assert.equal(publishedDecision.data.decision.candidates.length, 2);
  assert.notEqual(publishedDecision.data.decision.candidates[0].id, "forged-client-id", "server must derive candidate ids");
  assert.match(publishedDecision.data.decision.roundId, /^round_/);
  const candidateOne = publishedDecision.data.decision.candidates[0];
  const candidateTwo = publishedDecision.data.decision.candidates[1];
  const outsiderVote = await call("decision-outsider", {
    action: "setDecisionVote", docId: midpointDocId, membershipEpoch: "epoch_decision_outsider_123",
    roundId: publishedDecision.data.decision.roundId, revision: publishedDecision.data.decision.revision,
    candidateId: candidateOne.id, value: "want"
  });
  assert.equal(outsiderVote.code, "ROOM_NOT_FOUND", "outsiders must not vote");
  const outsiderConfirm = await call("decision-outsider", {
    action: "confirmDecisionCandidate", docId: midpointDocId, membershipEpoch: "epoch_decision_outsider_123",
    roundId: publishedDecision.data.decision.roundId, revision: publishedDecision.data.decision.revision,
    candidateId: candidateOne.id
  });
  assert.equal(outsiderConfirm.code, "ROOM_NOT_FOUND", "outsiders must not confirm a destination");
  const staleDecisionPublish = await call("mid-owner", {
    action: "publishDecisionCandidates", docId: midpointDocId, membershipEpoch: ownerDecisionEpoch,
    roundId: "round_stale_decision_1234567890", revision: 0, candidates: decisionCandidates
  });
  assert.equal(staleDecisionPublish.code, "STALE_DECISION");
  const memberVote = await call("mid-member", {
    action: "setDecisionVote", docId: midpointDocId, membershipEpoch: newMemberEpoch,
    roundId: publishedDecision.data.decision.roundId, revision: publishedDecision.data.decision.revision,
    candidateId: candidateOne.id, uid: "mid-owner", value: "want"
  });
  assert.equal(memberVote.ok, true);
  assert.deepEqual(memberVote.data.decision.votes[0].uid, "mid-member", "client uid must never choose whose vote is written");
  const ownerVote = await call("mid-owner", {
    action: "setDecisionVote", docId: midpointDocId, membershipEpoch: ownerDecisionEpoch,
    roundId: publishedDecision.data.decision.roundId, revision: publishedDecision.data.decision.revision,
    candidateId: candidateOne.id, uid: "mid-member", value: "no"
  });
  assert.equal(ownerVote.ok, true);
  assert.equal(ownerVote.data.decision.votes.filter((vote) => vote.candidateId === candidateOne.id).length, 2, "two same-round votes based on the same old revision must merge");
  const staleEpochVote = await call("mid-member", {
    action: "setDecisionVote", docId: midpointDocId, membershipEpoch: oldMemberEpoch,
    roundId: ownerVote.data.decision.roundId, revision: ownerVote.data.decision.revision, candidateId: candidateTwo.id, value: "ok"
  });
  assert.equal(staleEpochVote.code, "STALE_MEMBERSHIP");
  const nonOwnerConfirm = await call("mid-member", {
    action: "confirmDecisionCandidate", docId: midpointDocId, membershipEpoch: newMemberEpoch,
    roundId: ownerVote.data.decision.roundId, revision: ownerVote.data.decision.revision, candidateId: candidateOne.id
  });
  assert.equal(nonOwnerConfirm.code, "NOT_OWNER");
  const blankConfirm = await call("mid-owner", {
    action: "confirmDecisionCandidate", docId: midpointDocId, membershipEpoch: ownerDecisionEpoch,
    roundId: ownerVote.data.decision.roundId, revision: ownerVote.data.decision.revision, candidateId: ""
  });
  assert.equal(blankConfirm.code, "INVALID_DECISION", "confirming requires a real server-issued candidate id");
  const confirmed = await call("mid-owner", {
    action: "confirmDecisionCandidate", docId: midpointDocId, membershipEpoch: ownerDecisionEpoch,
    roundId: ownerVote.data.decision.roundId, revision: ownerVote.data.decision.revision, candidateId: candidateOne.id
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.data.decision.state, "confirmed");
  const lockedVote = await call("mid-member", {
    action: "setDecisionVote", docId: midpointDocId, membershipEpoch: newMemberEpoch,
    roundId: confirmed.data.decision.roundId, revision: confirmed.data.decision.revision, candidateId: candidateTwo.id, value: "ok"
  });
  assert.equal(lockedVote.code, "DECISION_CONFIRMED");
  const lockedPublish = await call("mid-owner", {
    action: "publishDecisionCandidates", docId: midpointDocId, membershipEpoch: ownerDecisionEpoch,
    roundId: confirmed.data.decision.roundId, revision: confirmed.data.decision.revision, candidates: [decisionCandidates[0]]
  });
  assert.equal(lockedPublish.code, "DECISION_CONFIRMED");
  const reopened = await call("mid-owner", {
    action: "reopenDecision", docId: midpointDocId, membershipEpoch: ownerDecisionEpoch,
    roundId: confirmed.data.decision.roundId, revision: confirmed.data.decision.revision
  });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.data.decision.state, "open");
  assert.notEqual(reopened.data.decision.roundId, confirmed.data.decision.roundId, "reopening must rotate the decision round");
  assert.equal(reopened.data.decision.votes.length, 0, "a new decision round starts with fresh votes");
  const freshRoundVote = await call("mid-member", {
    action: "setDecisionVote", docId: midpointDocId, membershipEpoch: newMemberEpoch,
    roundId: reopened.data.decision.roundId, revision: reopened.data.decision.revision, candidateId: candidateOne.id, value: "want"
  });
  assert.equal(freshRoundVote.ok, true);
  const voteForSoonRemovedCandidate = await call("mid-owner", {
    action: "setDecisionVote", docId: midpointDocId, membershipEpoch: ownerDecisionEpoch,
    roundId: reopened.data.decision.roundId, revision: reopened.data.decision.revision, candidateId: candidateTwo.id, value: "ok"
  });
  assert.equal(voteForSoonRemovedCandidate.ok, true);
  const refreshedCandidates = await call("mid-owner", {
    action: "publishDecisionCandidates", docId: midpointDocId, membershipEpoch: ownerDecisionEpoch,
    roundId: voteForSoonRemovedCandidate.data.decision.roundId, revision: voteForSoonRemovedCandidate.data.decision.revision, candidates: [decisionCandidates[0]]
  });
  assert.equal(refreshedCandidates.ok, true);
  assert.equal(refreshedCandidates.data.decision.votes.length, 1, "retained-candidate votes survive while removed-candidate votes are discarded");
  assert.notEqual(refreshedCandidates.data.decision.roundId, reopened.data.decision.roundId, "publishing candidates starts a new round");
  const delayedOldRoundVote = await call("mid-member", {
    action: "setDecisionVote", docId: midpointDocId, membershipEpoch: newMemberEpoch,
    roundId: reopened.data.decision.roundId, revision: reopened.data.decision.revision, candidateId: candidateOne.id, value: "no"
  });
  assert.equal(delayedOldRoundVote.code, "STALE_DECISION", "late writes from a prior round must not pollute refreshed candidates");
  const leaveWithVote = await call("mid-member", { action: "leave", docId: midpointDocId });
  assert.equal(leaveWithVote.ok, true);
  assert.equal(rooms.get(midpointDocId).meetup.decision.votes.some((vote) => vote.uid === "mid-member"), false, "leaving clears that user's votes");
  rooms.get(midpointDocId).meetup.decision.votes.push({ candidateId: candidateOne.id, uid: "removed-member", value: "want", updatedAt: stamp + 99 });
  const sanitizedDecisionRead = await call("mid-owner", { action: "getRoom", docId: midpointDocId });
  assert.equal(sanitizedDecisionRead.ok, true);
  assert.equal(sanitizedDecisionRead.data.room.meetup.decision.votes.some((vote) => vote.uid === "removed-member"), false, "room reads must hide votes from inactive members");
  const invalidDecision = await call("mid-owner", {
    action: "publishDecisionCandidates", docId: midpointDocId, membershipEpoch: ownerDecisionEpoch,
    roundId: refreshedCandidates.data.decision.roundId, revision: refreshedCandidates.data.decision.revision,
    candidates: Array.from({ length: 13 }, (_, index) => ({ name: `超限${index}`, lat: 20 + index / 100, lng: 110, typeStr: "餐厅", dist: 1, isMall: false, isDrink: false }))
  });
  assert.equal(invalidDecision.code, "INVALID_DECISION");
  const invalidCandidate = await call("mid-owner", {
    action: "publishDecisionCandidates", docId: midpointDocId, membershipEpoch: ownerDecisionEpoch,
    roundId: refreshedCandidates.data.decision.roundId, revision: refreshedCandidates.data.decision.revision,
    candidates: [{ name: "x".repeat(81), lat: "22.54", lng: 113.98, typeStr: "餐厅", dist: -1, isMall: false, isDrink: false }]
  });
  assert.equal(invalidCandidate.code, "INVALID_DECISION", "invalid text, coordinate type, and range must be rejected");

  const legacyCreated = await call("legacy-owner", {
    action: "create",
    room: { name: "旧版测试", members: [{ name: "甲" }, { name: "乙" }] }
  });
  assert.equal(legacyCreated.ok, true);
  const legacyDocId = legacyCreated.data.docId;
  const autoLegacy = await call("auto-legacy", {
    action: "join",
    type: "auto",
    code: legacyCreated.data.room.code,
    name: "自动加入者"
  });
  assert.equal(autoLegacy.code, "ROOM_LEGACY_UNSUPPORTED");
  const legacyLedger = {
    name: "旧版测试",
    nameUpdatedAt: stamp,
    members: legacyCreated.data.room.members.map((item) => ({ ...item, createdAt: stamp, updatedAt: stamp })),
    expenses: [],
    memberTombstones: {},
    expenseTombstones: {},
    nextMemberId: 3,
    nextExpenseId: 1,
    revision: stamp,
    updatedAt: stamp
  };
  const legacySync = await call("legacy-owner", { action: "syncLedger", docId: legacyDocId, ledger: legacyLedger });
  assert.equal(legacySync.ok, true);
  const legacyAdd = await call("legacy-owner", {
    action: "updateLegacyMembers",
    docId: legacyDocId,
    operation: "add",
    name: "丙"
  });
  assert.equal(legacyAdd.ok, true);
  assert.equal(rooms.get(legacyDocId).members.length, 3);

  const left = await call("member", { action: "leave", docId });
  assert.equal(left.ok, true);
  assert.equal(rooms.get(docId).memberUids.includes("member"), false);
  assert.equal(rooms.get(docId).members.some((item) => item.uid === "member"), false);
  assert.equal(rooms.get(docId).ledger.members.some((item) => item.uid === "member"), true);
  const leftRead = await call("member", { action: "getRoom", docId });
  assert.equal(leftRead.data.room, null, "a member must lose read access immediately after leaving");
  const leftSync = await call("member", { action: "syncLedger", docId, membershipEpoch: memberEpoch, ledger: memberSync.data.ledger });
  assert.equal(leftSync.code, "ROOM_NOT_FOUND");
  const rejoined = await call("member", {
    action: "join",
    type: "ledger",
    code: room.code,
    name: "成员"
  });
  assert.equal(rejoined.ok, true, "a member can rejoin after leaving with the same room code");
  const staleRejoinedSync = await call("member", {
    action: "syncLedger", docId, membershipEpoch: memberEpoch, ledger: memberSync.data.ledger
  });
  assert.equal(staleRejoinedSync.code, "STALE_MEMBERSHIP", "a pre-leave ledger write must be rejected after rejoining");
  const currentRejoinedSync = await call("member", {
    action: "syncLedger", docId, membershipEpoch: rejoined.data.viewer.membershipEpoch, ledger: memberSync.data.ledger
  });
  assert.equal(currentRejoinedSync.ok, true, "the current membership epoch can sync the ledger");

  const oldTypedDocId = "room-old-typed-without-member-uids";
  rooms.set(oldTypedDocId, {
    _id: oldTypedDocId,
    toolType: "ledger",
    ownerUid: "old-owner",
    members: [
      { id: "old-owner-member", uid: "old-owner", name: "Old owner" },
      { id: "old-member-member", uid: "old-member", name: "Old member" }
    ],
    ledger: { members: [], expenses: [], memberTombstones: {}, expenseTombstones: {} }
  });
  const oldTypedRead = await call("old-member", { action: "getRoom", docId: oldTypedDocId });
  assert.equal(oldTypedRead.data.room, null, "rooms without the v4 access platform must fail closed");
  const oldTypedLeave = await call("old-member", { action: "leave", docId: oldTypedDocId });
  assert.equal(oldTypedLeave.code, "ROOM_NOT_FOUND", "old rooms cannot be mutated without a trusted platform binding");

  const ownerLeave = await call("owner", { action: "leave", docId });
  assert.equal(ownerLeave.code, "OWNER_MUST_DISBAND");
  assert.equal(rooms.get(docId).memberUids.includes("owner"), true);

  const deniedDisband = await call("member", { action: "disband", docId });
  assert.equal(deniedDisband.code, "NOT_OWNER");
  assert.equal(rooms.has(docId), true);
  const ownerDisband = await call("owner", { action: "disband", docId });
  assert.equal(ownerDisband.ok, true);
  assert.equal(rooms.has(docId), false);
  const disbandedRead = await call("owner", { action: "getRoom", docId });
  assert.equal(disbandedRead.data.room, null);
  const disbandedJoin = await call("after-disband", {
    action: "join",
    type: "ledger",
    code: room.code,
    name: "解散后加入者"
  });
  assert.equal(disbandedJoin.code, "ROOM_NOT_FOUND", "a disbanded room code must no longer be available");
  const repeatedDisband = await call("owner", { action: "disband", docId });
  assert.equal(repeatedDisband.ok, true);

  const inferredOwnerDocId = "room-inferred-owner";
  rooms.set(inferredOwnerDocId, {
    _id: inferredOwnerDocId,
    code: "QWERTY",
    toolType: "legacy",
    accessPlatform: "web",
    memberUids: ["inferred-owner"],
    members: [],
    ledger: { members: [], expenses: [], memberTombstones: {}, expenseTombstones: {} }
  });
  const inferredDisband = await call("inferred-owner", { action: "disband", docId: inferredOwnerDocId });
  assert.equal(inferredDisband.ok, true, "legacy rooms must infer their original owner safely");
  assert.equal(rooms.has(inferredOwnerDocId), false);

  const pollutedOwnerDocId = "room-polluted-owner";
  rooms.set(pollutedOwnerDocId, {
    _id: pollutedOwnerDocId,
    code: "PLUTED",
    toolType: "ledger",
    accessPlatform: "web",
    memberUids: ["historical", "forged", "active-owner"],
    members: [{ id: "active-id", uid: "active-owner", name: "Active owner" }],
    ledger: {
      members: [{ id: "historical-id", uid: "historical", name: "Historical member" }],
      expenses: [],
      memberTombstones: {},
      expenseTombstones: {}
    }
  });
  for (const unauthorizedUid of ["historical", "forged"]) {
    const pollutedRead = await call(unauthorizedUid, { action: "getRoom", docId: pollutedOwnerDocId });
    assert.equal(pollutedRead.data.room, null, "a polluted memberUids entry must not grant read access");
    const pollutedSync = await call(unauthorizedUid, {
      action: "syncLedger",
      docId: pollutedOwnerDocId,
      ledger: clone(rooms.get(pollutedOwnerDocId).ledger)
    });
    assert.equal(pollutedSync.code, "ROOM_NOT_FOUND", "a polluted memberUids entry must not grant ledger writes");
  }
  const historicalDisband = await call("historical", { action: "disband", docId: pollutedOwnerDocId });
  assert.equal(historicalDisband.code, "NOT_OWNER", "ledger history must never confer room ownership");
  assert.equal(rooms.has(pollutedOwnerDocId), true);
  const activeOwnerDisband = await call("active-owner", { action: "disband", docId: pollutedOwnerDocId });
  assert.equal(activeOwnerDisband.ok, true);

  const pollutedJoinDocId = "room-polluted-join";
  rooms.set(pollutedJoinDocId, {
    _id: pollutedJoinDocId,
    code: "JKLMNP",
    toolType: "ledger",
    accessPlatform: "web",
    ownerUid: "active-owner",
    memberUids: ["active-owner", "departed", "forged"],
    members: [{ id: "active-id", uid: "active-owner", name: "Active owner", color: "#0F3D36" }],
    memberEpochs: {},
    ledger: {
      name: "Polluted room",
      members: [
        { id: "active-id", uid: "active-owner", name: "Active owner", color: "#0F3D36" },
        { id: "departed-id", uid: "departed", name: "Departed", color: "#B8842A" }
      ],
      expenses: [],
      memberTombstones: {},
      expenseTombstones: {},
      nextMemberId: 3,
      nextExpenseId: 1
    }
  });
  const cleanedJoin = await call("new-member", {
    action: "join",
    code: "JKLMNP",
    type: "ledger",
    name: "New member"
  });
  assert.equal(cleanedJoin.ok, true);
  assert.deepEqual(
    [...rooms.get(pollutedJoinDocId).memberUids].sort(),
    ["active-owner", "new-member"].sort(),
    "joining a typed room must clean access ids that are not active top-level members"
  );

  const pollutedMidpointDocId = "room-polluted-midpoint";
  rooms.set(pollutedMidpointDocId, {
    _id: pollutedMidpointDocId,
    code: "MNPQRS",
    toolType: "midpoint",
    accessPlatform: "web",
    ownerUid: "mid-active-owner",
    memberUids: ["mid-active-owner", "mid-departed"],
    members: [{ id: "mid-active-id", uid: "mid-active-owner", name: "Active midpoint owner" }],
    memberEpochs: {},
    meetup: { people: [] }
  });
  const pollutedMidpointRead = await call("mid-departed", {
    action: "getRoom",
    docId: pollutedMidpointDocId
  });
  assert.equal(pollutedMidpointRead.data.room, null);
  const pollutedPoint = await call("mid-departed", {
    action: "setMeetupPoint",
    docId: pollutedMidpointDocId,
    membershipEpoch: "epoch_mid_departed_123456",
    mutationAt: Date.now(),
    person: { name: "Departed", address: "Should not save", lat: 22.5, lng: 113.9 }
  });
  assert.equal(pollutedPoint.code, "ROOM_NOT_FOUND", "a polluted memberUids entry must not grant meetup writes");
  assert.equal(rooms.get(pollutedMidpointDocId).meetup.people.length, 0);

  const orphanJoinDocId = "room-orphan-join";
  rooms.set(orphanJoinDocId, {
    _id: orphanJoinDocId,
    code: "ZXCVBN",
    name: "待认领旧房间",
    toolType: "midpoint",
    accessPlatform: "web",
    memberUids: [],
    members: [],
    meetup: { people: [] }
  });
  const orphanJoined = await call("first-valid-joiner", {
    action: "join",
    code: "ZXCVBN",
    type: "midpoint",
    name: "新房主"
  });
  assert.equal(orphanJoined.ok, true);
  assert.equal(rooms.get(orphanJoinDocId).ownerUid, "first-valid-joiner");
  const orphanDisband = await call("first-valid-joiner", { action: "disband", docId: orphanJoinDocId });
  assert.equal(orphanDisband.ok, true);

  const limitCreated = await call("limit-owner", {
    action: "create",
    room: { toolType: "ledger", name: "合并上限测试", members: [{ name: "上限房主" }] }
  });
  const limitDocId = limitCreated.data.docId;
  const limitOwnerEpoch = limitCreated.data.viewer.membershipEpoch;
  const limitBase = clone(limitCreated.data.room.ledger);
  const firstTombstones = {};
  const secondTombstones = {};
  for (let i = 0; i < 1100; i += 1) {
    firstTombstones[`deleted_a_${i}`] = { deletedAt: stamp + 20, deletedBy: "limit-owner" };
    secondTombstones[`deleted_b_${i}`] = { deletedAt: stamp + 21, deletedBy: "limit-owner" };
  }
  const firstLimitSync = await call("limit-owner", {
    action: "syncLedger",
    docId: limitDocId,
    membershipEpoch: limitOwnerEpoch,
    ledger: { ...clone(limitBase), memberTombstones: firstTombstones, updatedAt: stamp + 20, revision: stamp + 20 }
  });
  assert.equal(firstLimitSync.ok, true);
  const beforeRejectedMerge = JSON.stringify(rooms.get(limitDocId).ledger);
  const rejectedLimitSync = await call("limit-owner", {
    action: "syncLedger",
    docId: limitDocId,
    membershipEpoch: limitOwnerEpoch,
    ledger: { ...clone(limitBase), memberTombstones: secondTombstones, updatedAt: stamp + 21, revision: stamp + 21 }
  });
  assert.equal(rejectedLimitSync.code, "INVALID_LEDGER");
  assert.equal(JSON.stringify(rooms.get(limitDocId).ledger), beforeRejectedMerge, "an oversized merged ledger must not be written");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const missingRoom = await call("brute-force-client", {
      action: "join",
      code: "AAAAAAAA",
      type: "ledger",
      name: "猜码者"
    });
    assert.equal(missingRoom.code, "ROOM_NOT_FOUND");
  }
  const rateLimited = await call("brute-force-client", {
    action: "join",
    code: "AAAAAAAA",
    type: "ledger",
    name: "猜码者"
  });
  assert.equal(rateLimited.code, "RATE_LIMITED", "rapid room-code guessing must be throttled");

  console.log("roomGateway unit checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

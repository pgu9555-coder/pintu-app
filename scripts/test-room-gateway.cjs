const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

let currentUid = null;
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

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "@cloudbase/node-sdk") return fakeCloudbase;
  return originalLoad.call(this, request, parent, isMain);
};

const gatewayPath = path.join(__dirname, "..", "cloudfunctions", "roomGateway", "index.js");
const gateway = require(gatewayPath);
Module._load = originalLoad;

async function call(uid, data) {
  currentUid = uid;
  return gateway.main(data || {});
}

async function main() {
  const spoofed = await call(null, { action: "create", userInfo: { uid: "forged" }, room: {} });
  assert.equal(spoofed.code, "UNAUTHENTICATED", "client-supplied uid must never be trusted");

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
  assert.deepEqual(created.data.room.memberUids, ["owner"]);
  const { docId, room } = created.data;

  const ownerRead = await call("owner", { action: "getRoom", docId });
  assert.equal(ownerRead.ok, true);
  assert.equal(ownerRead.data.room._id, docId);
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
    ledger: { ...clone(baseLedger), expenses: [ownerExpense], revision: stamp, updatedAt: stamp, updatedBy: "owner" }
  });
  assert.equal(ownerSync.ok, true);
  const memberSync = await call("member", {
    action: "syncLedger",
    docId,
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
  const forgedUidSync = await call("owner", { action: "syncLedger", docId, ledger: forgedUidLedger });
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
  const futureSync = await call("owner", { action: "syncLedger", docId, ledger: futureLedger });
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
  const invalidReference = await call("owner", { action: "syncLedger", docId, ledger: invalidReferenceLedger });
  assert.equal(invalidReference.code, "INVALID_LEDGER");
  assert.equal(JSON.stringify(rooms.get(docId).ledger), beforeDeniedSync);

  const injectedIdLedger = clone(memberSync.data.ledger);
  injectedIdLedger.members[0].id = 'x" onmouseover="alert(1)';
  const injectedId = await call("owner", { action: "syncLedger", docId, ledger: injectedIdLedger });
  assert.equal(injectedId.code, "INVALID_LEDGER");
  assert.equal(JSON.stringify(rooms.get(docId).ledger), beforeDeniedSync);

  const midpointCreated = await call("mid-owner", {
    action: "create",
    room: { toolType: "midpoint", name: "碰面测试", members: [{ name: "碰面房主" }] }
  });
  assert.equal(midpointCreated.ok, true);
  const midpointDocId = midpointCreated.data.docId;
  const midpointEpoch = midpointCreated.data.room.members[0].membershipEpoch;
  const midpointSync = await call("mid-owner", { action: "syncLedger", docId: midpointDocId, ledger: baseLedger });
  assert.equal(midpointSync.code, "WRONG_ROOM_TYPE");
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

  const legacyCreated = await call("legacy-owner", {
    action: "create",
    room: { name: "旧版测试", members: [{ name: "甲" }, { name: "乙" }] }
  });
  assert.equal(legacyCreated.ok, true);
  const legacyDocId = legacyCreated.data.docId;
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
  const leftSync = await call("member", { action: "syncLedger", docId, ledger: memberSync.data.ledger });
  assert.equal(leftSync.code, "ROOM_NOT_FOUND");

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
  const repeatedDisband = await call("owner", { action: "disband", docId });
  assert.equal(repeatedDisband.ok, true);

  const inferredOwnerDocId = "room-inferred-owner";
  rooms.set(inferredOwnerDocId, {
    _id: inferredOwnerDocId,
    code: "QWERTY",
    toolType: "legacy",
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
    ledger: { ...clone(limitBase), memberTombstones: firstTombstones, updatedAt: stamp + 20, revision: stamp + 20 }
  });
  assert.equal(firstLimitSync.ok, true);
  const beforeRejectedMerge = JSON.stringify(rooms.get(limitDocId).ledger);
  const rejectedLimitSync = await call("limit-owner", {
    action: "syncLedger",
    docId: limitDocId,
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

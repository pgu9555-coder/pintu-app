const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

let currentUid = null;
let currentWxContext = null;
let nextModerationSuggestion = "pass";
const moderationCalls = [];
let nextId = 1;
const rooms = new Map();
const profiles = new Map();
const profileCleanupTasks = new Map();
let nextDeleteFileResponse = null;
let nextDeleteFileError = null;

function clone(value) {
  return structuredClone(value);
}

function collectionFor(name, inTransaction) {
  const records = name === "user_profiles"
    ? profiles
    : name === "profile_avatar_cleanup"
      ? profileCleanupTasks
      : rooms;
  return {
    where(query) {
      return {
        orderBy(field, direction) {
          this.orderFields = this.orderFields || [];
          this.orderFields.push({ field, direction });
          return this;
        },
        limit(count) {
          this.limitCount = count;
          return this;
        },
        skip(count) {
          this.skipCount = count;
          return this;
        },
        async get() {
          const matchesQuery = (record, condition) => {
            if (condition && Array.isArray(condition.__or)) {
              return condition.__or.some((part) => matchesQuery(record, part));
            }
            return Object.keys(condition || {}).every((key) => {
              const expected = condition[key];
              if (expected && Object.hasOwn(expected, "__elemMatch")) {
                return Array.isArray(record[key]) && record[key].includes(expected.__elemMatch);
              }
              if (expected && Object.hasOwn(expected, "__lt")) {
                const actualValue = record[key] instanceof Date ? record[key].getTime() : record[key];
                const expectedValue = expected.__lt instanceof Date ? expected.__lt.getTime() : expected.__lt;
                return actualValue < expectedValue;
              }
              if (record[key] instanceof Date && expected instanceof Date) return record[key].getTime() === expected.getTime();
              return record[key] === expected;
            });
          };
          const matches = [...records.values()].filter((record) => matchesQuery(record, query));
          if (this.orderFields && this.orderFields.length) {
            matches.sort((first, second) => {
              for (const { field, direction } of this.orderFields) {
                const firstValue = first[field] instanceof Date ? first[field].getTime() : first[field];
                const secondValue = second[field] instanceof Date ? second[field].getTime() : second[field];
                if (firstValue === secondValue) continue;
                const diff = firstValue > secondValue ? 1 : -1;
                return direction === "desc" ? -diff : diff;
              }
              return 0;
            });
          }
          const start = this.skipCount || 0;
          const page = this.limitCount ? matches.slice(start, start + this.limitCount) : matches.slice(start);
          return { data: clone(page) };
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
          const record = records.get(id);
          return { data: inTransaction ? clone(record || null) : record ? [clone(record)] : [] };
        },
        async update(patch) {
          const record = records.get(id);
          if (!record) return { updated: 0 };
          records.set(id, { ...record, ...clone(patch) });
          return { updated: 1 };
        },
        async set(value) {
          records.set(id, { ...clone(value), _id: id });
          return { set: 1 };
        },
        async remove() {
          if (!records.has(id)) return { deleted: 0 };
          records.delete(id);
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
      async deleteFile({ fileList }) {
        if (nextDeleteFileError) {
          const error = nextDeleteFileError;
          nextDeleteFileError = null;
          throw error;
        }
        if (nextDeleteFileResponse) {
          const response = nextDeleteFileResponse;
          nextDeleteFileResponse = null;
          return clone(response);
        }
        return { fileList: (fileList || []).map((fileID) => ({ fileID, code: "SUCCESS" })) };
      },
      database() {
        return {
          command: {
            eq(value) {
              return { __eq: value };
            },
            lt(value) {
              return { __lt: value };
            },
            elemMatch(condition) {
              return { __elemMatch: condition.__eq };
            },
            or(conditions) {
              return { __or: conditions };
            }
          },
          collection(name) {
            return collectionFor(name, false);
          },
          async runTransaction(callback) {
            return callback({
              collection(name) {
                return collectionFor(name, true);
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

  const webProfile = await call("web-user", { action: "getProfile" });
  assert.equal(webProfile.code, "WECHAT_MINIPROGRAM_ONLY", "profiles must reject web callers");
  const webProfileUpdate = await call("web-user", { action: "updateProfile", nickname: "Forged web profile" });
  assert.equal(webProfileUpdate.code, "WECHAT_MINIPROGRAM_ONLY", "web callers cannot update WeChat profiles");
  const webProfileDelete = await call("web-user", { action: "deleteProfile" });
  assert.equal(webProfileDelete.code, "WECHAT_MINIPROGRAM_ONLY", "web callers cannot delete WeChat profiles");
  const emptyProfile = await callWx("openid-profile", { action: "getProfile", userInfo: { uid: "forged-profile" } });
  assert.deepEqual(
    { exists: emptyProfile.data.exists, nickname: emptyProfile.data.nickname, avatarFileId: emptyProfile.data.avatarFileId, updatedAt: emptyProfile.data.updatedAt, avatarCleanupPendingCount: emptyProfile.data.avatarCleanupPendingCount },
    { exists: false, nickname: "", avatarFileId: "", updatedAt: null, avatarCleanupPendingCount: 0 }
  );
  assert.match(emptyProfile.data.avatarUploadPrefix, /^avatars\/profile-[a-f0-9]{64}\/$/, "the trusted user receives only their opaque avatar upload prefix");
  const invalidProfile = await callWx("openid-profile", { action: "updateProfile", nickname: "  " });
  assert.equal(invalidProfile.code, "INVALID_PROFILE", "profile nicknames must be non-empty after trimming");
  const invalidAvatar = await callWx("openid-profile", {
    action: "updateProfile", nickname: "Profile user", avatarFileId: "https://attacker.invalid/avatar.png"
  });
  assert.equal(invalidAvatar.code, "INVALID_PROFILE", "only CloudBase avatar file ids may be stored");
  const otherProfilePrefix = (await callWx("openid-other-profile", { action: "getProfile" })).data.avatarUploadPrefix;
  const crossAccountAvatar = await callWx("openid-profile", {
    action: "updateProfile", nickname: "Profile user", avatarFileId: `cloud://pintu/${otherProfilePrefix}other.png`
  });
  assert.equal(crossAccountAvatar.code, "INVALID_PROFILE", "one identity cannot register another identity's avatar file for server-side cleanup");
  const profileAvatarFileId = `cloud://pintu/${emptyProfile.data.avatarUploadPrefix}profile.png`;
  const savedProfile = await callWx("openid-profile", {
    action: "updateProfile", nickname: "  Profile user  ", avatarFileId: profileAvatarFileId, uid: "forged-profile"
  });
  assert.equal(savedProfile.ok, true);
  assert.deepEqual(
    { exists: savedProfile.data.exists, nickname: savedProfile.data.nickname, avatarFileId: savedProfile.data.avatarFileId },
    { exists: true, nickname: "Profile user", avatarFileId: profileAvatarFileId },
    "profile responses must be trimmed and omit trusted identity fields"
  );
  const profileStored = [...profiles.values()][0];
  assert.equal(Object.hasOwn(profileStored, "uid"), false, "profiles must not persist caller uid/openid fields");
  const profileUpdated = await callWx("openid-profile", { action: "updateProfile", nickname: "New profile name" });
  assert.equal(profileUpdated.data.avatarFileId, profileAvatarFileId, "partial updates retain an existing avatar");
  const profileIdempotent = await callWx("openid-profile", { action: "updateProfile", nickname: "New profile name" });
  assert.equal(profileIdempotent.data.updatedAt, profileUpdated.data.updatedAt, "identical profile writes are idempotent");
  nextModerationSuggestion = "risky";
  const riskyProfile = await callWx("openid-risky-profile", { action: "updateProfile", nickname: "risky name" });
  assert.equal(riskyProfile.code, "CONTENT_REJECTED", "profile nickname moderation must fail closed");
  const otherProfileDelete = await callWx("openid-other-profile", { action: "deleteProfile" });
  assert.equal(otherProfileDelete.ok, true, "deleting a missing own profile is idempotent");
  assert.equal((await callWx("openid-profile", { action: "getProfile" })).data.exists, true, "one caller cannot delete another caller's opaque profile");
  const replacementAvatarFileId = `cloud://pintu/${emptyProfile.data.avatarUploadPrefix}replacement.png`;
  nextDeleteFileResponse = { fileList: [{ fileID: profileAvatarFileId, code: "FAILED" }] };
  const profileReplaced = await callWx("openid-profile", { action: "updateProfile", avatarFileId: replacementAvatarFileId });
  assert.equal(profileReplaced.data.avatarCleanup.pendingCount, 1, "failed old-avatar deletion is returned to the caller");
  assert.equal(profileCleanupTasks.size, 1, "failed old-avatar deletion is persisted for retry");
  const cleanupRetried = await callWx("openid-profile", { action: "retryAvatarCleanup" });
  assert.equal(cleanupRetried.data.avatarCleanup.pendingCount, 0, "the owner can retry server-side avatar cleanup");
  assert.equal(profileCleanupTasks.size, 0, "successful cleanup removes only the owner's retry record");
  nextDeleteFileError = new Error("storage temporarily unavailable");
  const deletedProfile = await callWx("openid-profile", { action: "deleteProfile" });
  assert.equal(deletedProfile.data.deleted, true);
  assert.equal(deletedProfile.data.avatarCleanup.pendingCount, 1, "profile deletion reports a queued avatar cleanup instead of claiming full removal");
  const repeatedProfileDelete = await callWx("openid-profile", { action: "deleteProfile" });
  assert.equal(repeatedProfileDelete.data.deleted, true, "deleting an already deleted profile remains successful");
  assert.equal(repeatedProfileDelete.data.avatarCleanup.pendingCount, 0, "a repeated delete retries the durable cleanup record");
  const profileAfterDelete = await callWx("openid-profile", { action: "getProfile" });
  assert.deepEqual(
    { exists: profileAfterDelete.data.exists, nickname: profileAfterDelete.data.nickname, avatarFileId: profileAfterDelete.data.avatarFileId, updatedAt: profileAfterDelete.data.updatedAt, avatarCleanupPendingCount: profileAfterDelete.data.avatarCleanupPendingCount },
    { exists: false, nickname: "", avatarFileId: "", updatedAt: null, avatarCleanupPendingCount: 0 }
  );

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
  assert.equal(wxCreated.data.room.schemaVersion, 5);
  assert.equal(wxCreated.data.room.accessPlatform, "shared");
  assert.equal(wxCreated.data.room.creatorPlatform, "wechat-mini-program");
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
  const seededMyRoom = {
    _id: "room-my-older",
    name: "Earlier shared ledger",
    code: "ABCDEFGH",
    toolType: "ledger",
    accessPlatform: "wechat-mini-program",
    memberUids: [wxOwnerUid],
    members: [{ uid: wxOwnerUid, name: "Owner" }],
    ledger: { expenses: [{ amountCents: 1234 }, { amountCents: 66 }] },
    createdAt: new Date(1000),
    updatedAt: new Date(1000),
    ownerUid: wxOwnerUid,
    inviteHash: "must-not-leak"
  };
  const newerMyRoom = {
    _id: "room-my-newer",
    name: "Latest midpoint",
    code: "JKLMNPQR",
    toolType: "midpoint",
    accessPlatform: "wechat-mini-program",
    memberUids: [wxOwnerUid],
    members: [{ uid: wxOwnerUid, name: "Owner" }, { uid: wxMemberUid, name: "Member" }],
    ledger: { expenses: [] },
    createdAt: new Date(2000),
    updatedAt: new Date(2000),
    ownerUid: wxOwnerUid
  };
  rooms.set(seededMyRoom._id, seededMyRoom);
  rooms.set(newerMyRoom._id, newerMyRoom);
  rooms.set("room-my-web", { ...seededMyRoom, _id: "room-my-web", accessPlatform: "web", updatedAt: new Date(3000) });
  rooms.set("room-my-left", {
    ...seededMyRoom,
    _id: "room-my-left",
    ownerUid: "someone-else",
    memberUids: [wxOwnerUid],
    members: [{ uid: "someone-else" }]
  });
  const myRooms = await callWx("openid-owner", { action: "listMyRooms", userInfo: { uid: "forged-owner" } });
  assert.equal(myRooms.ok, true);
  assert.deepEqual(
    myRooms.data.rooms.filter((item) => item.docId !== wxDocId).map((item) => item.docId).slice(0, 3),
    ["room-my-web", "room-my-newer", "room-my-older"],
    "my rooms include both clients and are sorted newest first"
  );
  assert.equal(myRooms.data.rooms.some((item) => item.docId === "room-my-web"), true, "Web-created rooms must be recoverable in the mini program");
  assert.equal(myRooms.data.rooms.some((item) => item.docId === "room-my-left"), false, "departed members must be excluded");
  const myRoomSummary = myRooms.data.rooms.find((item) => item.docId === "room-my-older");
  assert.deepEqual(
    { memberCount: myRoomSummary.memberCount, expenseCount: myRoomSummary.expenseCount, totalCents: myRoomSummary.totalCents },
    { memberCount: 1, expenseCount: 2, totalCents: 1300 }
  );
  assert.deepEqual(
    Object.keys(myRoomSummary).sort(),
    ["docId", "expenseCount", "memberCount", "room", "totalCents", "updatedAt"],
    "room summaries must contain only page-safe fields"
  );
  assert.equal(Object.hasOwn(myRoomSummary, "ownerUid"), false, "room summaries must not leak ownership or invite data");
  const webMyRooms = await call("web-user", { action: "listMyRooms", accessPlatform: "wechat-mini-program" });
  assert.equal(webMyRooms.code, "WECHAT_MINIPROGRAM_ONLY", "web callers cannot list WeChat rooms by forging a platform");
  const manyUid = "wx:wx-test-pintu:openid-many";
  for (let index = 0; index < 55; index += 1) {
    const code = `MANY${String(index).padStart(4, "0")}`;
    rooms.set(`room-many-${index}`, {
      _id: `room-many-${index}`,
      name: `Many room ${index}`,
      code,
      toolType: "ledger",
      accessPlatform: "wechat-mini-program",
      memberUids: [manyUid],
      members: [{ uid: manyUid, name: "Many" }],
      ledger: { expenses: [] },
      createdAt: new Date(index),
      updatedAt: new Date(index)
    });
  }
  const invalidMyRoomsCursor = await callWx("openid-many", { action: "listMyRooms", cursor: { createdAt: -1, docId: "room" } });
  assert.equal(invalidMyRoomsCursor.code, "INVALID_PAGINATION", "my rooms rejects unsafe cursors");
  const invalidMyRoomsLimit = await callWx("openid-many", { action: "listMyRooms", limit: 51 });
  assert.equal(invalidMyRoomsLimit.code, "INVALID_PAGINATION", "my rooms caps page size at 50");
  const manyRooms = await callWx("openid-many", { action: "listMyRooms", cursor: null, limit: 50 });
  assert.equal(manyRooms.data.rooms.length, 50, "my rooms are server-limited to 50 summaries");
  assert.equal(manyRooms.data.hasMore, true, "my rooms returns a continuation when more results exist");
  assert.deepEqual(manyRooms.data.nextCursor, { createdAt: 5, docId: "room-many-5" }, "my rooms returns an immutable keyset cursor");
  rooms.get("room-many-4").updatedAt = new Date(999999999);
  const moreManyRooms = await callWx("openid-many", {
    action: "listMyRooms", cursor: manyRooms.data.nextCursor, limit: 50
  });
  assert.equal(moreManyRooms.data.rooms.length, 5, "my rooms can retrieve rooms after the first 50");
  assert.equal(moreManyRooms.data.rooms.some((room) => room.docId === "room-many-4"), true, "a room updated after page one is not skipped because pagination uses immutable creation time");
  assert.equal(moreManyRooms.data.hasMore, false, "the final my-rooms page has no continuation");
  const lifecycleRoom = await callWx("openid-list-owner", {
    action: "create", room: { toolType: "ledger", name: "Lifecycle room", members: [{ name: "List owner" }] }
  });
  await callWx("openid-list-member", {
    action: "join", type: "ledger", code: lifecycleRoom.data.room.code, name: "List member"
  });
  const beforeLeaveRooms = await callWx("openid-list-member", { action: "listMyRooms" });
  assert.equal(beforeLeaveRooms.data.rooms.some((item) => item.docId === lifecycleRoom.data.docId), true, "joined rooms appear in my rooms");
  const leftLifecycleRoom = await callWx("openid-list-member", { action: "leave", docId: lifecycleRoom.data.docId });
  assert.equal(leftLifecycleRoom.ok, true);
  const afterLeaveRooms = await callWx("openid-list-member", { action: "listMyRooms" });
  assert.equal(afterLeaveRooms.data.rooms.some((item) => item.docId === lifecycleRoom.data.docId), false, "left rooms disappear from my rooms");
  const disbandedLifecycleRoom = await callWx("openid-list-owner", { action: "disband", docId: lifecycleRoom.data.docId });
  assert.equal(disbandedLifecycleRoom.ok, true);
  const afterDisbandRooms = await callWx("openid-list-owner", { action: "listMyRooms" });
  assert.equal(afterDisbandRooms.data.rooms.some((item) => item.docId === lifecycleRoom.data.docId), false, "disbanded rooms disappear from my rooms");
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
  const crossPlatformOutsiderRead = await call("web-outsider", {
    action: "getRoom", docId: wxDocId, accessPlatform: "wechat-mini-program"
  });
  assert.equal(crossPlatformOutsiderRead.data.room, null, "event platform fields cannot bypass room membership");
  const webJoinedMiniRoom = await call("web-joiner", {
    action: "join", code: wxCreated.data.room.code, type: "ledger", name: "Web forged platform", accessPlatform: "wechat-mini-program"
  });
  assert.equal(webJoinedMiniRoom.ok, true, "a Web identity can join a mini-program-created room");
  assert.equal(webJoinedMiniRoom.data.room.accessPlatform, "shared");
  assert.match(
    rooms.get(wxDocId).contentReviewPendingId,
    /^[a-f0-9]{32}$/,
    "Web text entering a shared room must be queued for a trusted mini-program review"
  );
  const moderationCountBeforeWebWrite = moderationCalls.length;
  const webCrossPlatformLedger = clone(webJoinedMiniRoom.data.room.ledger);
  webCrossPlatformLedger.name = "网页与微信共享账本";
  webCrossPlatformLedger.nameUpdatedAt = Date.now() + 10;
  webCrossPlatformLedger.updatedAt = webCrossPlatformLedger.nameUpdatedAt;
  webCrossPlatformLedger.revision = webCrossPlatformLedger.nameUpdatedAt;
  const webCrossPlatformWrite = await call("web-joiner", {
    action: "syncLedger", docId: wxDocId, ledger: webCrossPlatformLedger, membershipEpoch: webJoinedMiniRoom.data.viewer.membershipEpoch,
    accessPlatform: "wechat-mini-program"
  });
  assert.equal(webCrossPlatformWrite.ok, true, "Web ledger writes must sync into a mini-program-created room");
  assert.equal(
    moderationCalls.length,
    moderationCountBeforeWebWrite,
    "a Web invocation must not try to borrow a stored WeChat OPENID for OpenAPI authentication"
  );
  const miniReviewedWebWrite = await callWx("openid-owner", { action: "getRoom", docId: wxDocId });
  assert.equal(miniReviewedWebWrite.ok, true, "the next trusted mini-program read reviews pending Web text");
  assert.equal(miniReviewedWebWrite.data.room.ledger.name, "网页与微信共享账本");
  assert.equal(rooms.get(wxDocId).contentReviewPendingId, "", "a successful trusted review clears only the reviewed marker");
  assert.equal(
    moderationCalls.some((entry) => entry.openid === "openid-owner" && entry.content.includes("网页与微信共享账本")),
    true,
    "Web text must be moderated before it is returned to WeChat"
  );
  const riskyPendingLedger = clone(miniReviewedWebWrite.data.room.ledger);
  riskyPendingLedger.name = "待审核网页内容";
  riskyPendingLedger.nameUpdatedAt = Date.now() + 100;
  riskyPendingLedger.updatedAt = riskyPendingLedger.nameUpdatedAt;
  riskyPendingLedger.revision = riskyPendingLedger.nameUpdatedAt;
  const riskyPendingWrite = await call("web-joiner", {
    action: "syncLedger", docId: wxDocId, ledger: riskyPendingLedger,
    membershipEpoch: webJoinedMiniRoom.data.viewer.membershipEpoch
  });
  assert.equal(riskyPendingWrite.ok, true);
  assert.match(rooms.get(wxDocId).contentReviewEntriesJson, /待审核网页内容/, "Web writes queue only their changed text for a trusted review");
  /* A Web user can fix their own pending text before any mini client reads it.
     The later safe text must replace (not accumulate with) the earlier risk. */
  const restoredPendingLedger = clone(riskyPendingLedger);
  restoredPendingLedger.name = "网页与微信共享账本";
  restoredPendingLedger.nameUpdatedAt += 1;
  restoredPendingLedger.updatedAt = restoredPendingLedger.nameUpdatedAt;
  restoredPendingLedger.revision = restoredPendingLedger.nameUpdatedAt;
  assert.equal((await call("web-joiner", {
    action: "syncLedger", docId: wxDocId, ledger: restoredPendingLedger,
    membershipEpoch: webJoinedMiniRoom.data.viewer.membershipEpoch
  })).ok, true, "a safe replacement can overwrite pending risky text");
  nextModerationSuggestion = "pass";
  const safeReplacementRead = await callWx("openid-owner", { action: "getRoom", docId: wxDocId });
  assert.equal(safeReplacementRead.ok, true, "safe replacement unblocks the room without surfacing the old risky text");
  assert.equal(safeReplacementRead.data.room.ledger.name, "网页与微信共享账本");
  assert.equal(rooms.get(wxDocId).contentReviewPendingId, "", "the reviewed replacement clears the marker");
  assert.equal(
    moderationCalls.at(-1).content.includes("待审核网页内容"), false,
    "replaced risky text is never submitted or returned after a safe overwrite"
  );

  /* Simulate a well-established (and therefore already approved) large
     ledger. A later one-line Web edit must not try to re-review all history. */
  const approvedLargeRoom = rooms.get(wxDocId);
  const approvedLargeLedger = clone(approvedLargeRoom.ledger);
  const largeMember = approvedLargeLedger.members[0];
  const baseStamp = Date.now() - 1000;
  approvedLargeLedger.expenses = Array.from({ length: 220 }, (_, index) => ({
    id: `approved-${index}`, desc: `已审核历史${index}-${"a".repeat(90)}`,
    amountCents: 100, payerId: largeMember.id, splitIds: [largeMember.id],
    createdAt: baseStamp + index, updatedAt: baseStamp + index, updatedBy: "openid-owner"
  }));
  approvedLargeLedger.nextExpenseId = 300;
  approvedLargeLedger.revision = baseStamp + 500;
  approvedLargeLedger.updatedAt = baseStamp + 500;
  rooms.set(wxDocId, { ...approvedLargeRoom, ledger: approvedLargeLedger });
  const largeWebEdit = clone(approvedLargeLedger);
  largeWebEdit.expenses.push({
    id: "web-small-change", desc: "网页单条增量", amountCents: 200,
    payerId: largeMember.id, splitIds: [largeMember.id],
    createdAt: Date.now(), updatedAt: Date.now(), updatedBy: "web-joiner"
  });
  largeWebEdit.updatedAt = Date.now();
  largeWebEdit.revision = largeWebEdit.updatedAt;
  assert.equal((await call("web-joiner", {
    action: "syncLedger", docId: wxDocId, ledger: largeWebEdit,
    membershipEpoch: webJoinedMiniRoom.data.viewer.membershipEpoch
  })).ok, true, "a single Web edit in a >16KiB approved ledger remains writable");
  const callsBeforeLargeRead = moderationCalls.length;
  const largeLedgerRead = await callWx("openid-owner", { action: "getRoom", docId: wxDocId });
  assert.equal(largeLedgerRead.ok, true, "mini readers can review just the incremental Web text in a large ledger");
  assert.equal(moderationCalls.length, callsBeforeLargeRead + 1);
  assert.equal(moderationCalls.at(-1).content, "网页单条增量", "the review payload excludes approved historical ledger data");

  const riskyExitLedger = clone(largeLedgerRead.data.room.ledger);
  riskyExitLedger.expenses.push({
    id: "web-risky-exit", desc: "违规网页支出", amountCents: 300,
    payerId: largeMember.id, splitIds: [largeMember.id],
    createdAt: Date.now(), updatedAt: Date.now(), updatedBy: "web-joiner"
  });
  riskyExitLedger.updatedAt = Date.now();
  riskyExitLedger.revision = riskyExitLedger.updatedAt;
  assert.equal((await call("web-joiner", {
    action: "syncLedger", docId: wxDocId, ledger: riskyExitLedger,
    membershipEpoch: webJoinedMiniRoom.data.viewer.membershipEpoch
  })).ok, true);
  assert.equal((await call("web-joiner", { action: "leave", docId: wxDocId })).ok, true, "the Web author can leave before review");
  nextModerationSuggestion = "risky";
  const recoveredAfterExit = await callWx("openid-owner", { action: "getRoom", docId: wxDocId });
  assert.equal(recoveredAfterExit.ok, true, "a rejected Web update is sanitized instead of permanently freezing the room");
  assert.equal(JSON.stringify(recoveredAfterExit.data.room).includes("违规网页支出"), false, "risky text is never returned to the mini program");
  assert.equal(recoveredAfterExit.data.room.ledger.expenses.some((expense) => expense.id === "web-risky-exit" && expense.desc === "待修改支出"), true);

  /* A marker written by the short-lived pre-incremental rollout has no entity
     queue. It must fail closed without attempting an oversized full-ledger
     moderation request or leaking whichever field was risky. */
  const legacyPendingRoom = clone(rooms.get(wxDocId));
  legacyPendingRoom.name = "旧版未知待审文本";
  legacyPendingRoom.ledger.expenses[0].desc = "旧版未知风险支出";
  legacyPendingRoom.contentReviewPendingId = "a".repeat(32);
  legacyPendingRoom.contentReviewEntriesJson = "";
  rooms.set(wxDocId, legacyPendingRoom);
  const legacyPendingRead = await callWx("openid-owner", { action: "getRoom", docId: wxDocId });
  assert.equal(legacyPendingRead.ok, false, "legacy pending rooms fail closed instead of exposing unreviewed text");
  assert.equal(legacyPendingRead.code, "CONTENT_REVIEW_LEGACY");
  assert.equal(rooms.get(wxDocId).name, "旧版未知待审文本", "legacy fallback never destroys the original room name");
  assert.equal(rooms.get(wxDocId).ledger.expenses[0].desc, "旧版未知风险支出", "legacy fallback never destroys historical ledger data");
  assert.equal(rooms.get(wxDocId).contentReviewPendingId, "a".repeat(32), "legacy pending marker remains fail-closed");
  rooms.set(wxDocId, clone(recoveredAfterExit.data.room));
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
  assert.equal(crossPlatformRetry.data.docId, wxIdempotent.data.docId, "shared-room create retries are idempotent regardless of the forged event platform field");
  assert.equal(crossPlatformRetry.data.room.accessPlatform, "shared");

  const wxMidpoint = await callWx("openid-owner", {
    action: "create", room: { toolType: "midpoint", name: "微信碰面", members: [{ name: "微信房主" }] }
  });
  nextModerationSuggestion = "risky";
  const riskyCandidates = await callWx("openid-owner", {
    action: "publishDecisionCandidates", docId: wxMidpoint.data.docId, membershipEpoch: wxMidpoint.data.viewer.membershipEpoch,
    candidates: [{ name: "危险候选", lat: 22.5, lng: 113.9, typeStr: "餐厅", dist: 1, isMall: false, isDrink: false }]
  });
  assert.equal(riskyCandidates.code, "CONTENT_REJECTED", "candidate text must fail closed when mini-program moderation flags it");
  const safeWxCandidate = await callWx("openid-owner", {
    action: "publishDecisionCandidates", docId: wxMidpoint.data.docId, membershipEpoch: wxMidpoint.data.viewer.membershipEpoch,
    candidates: [{
      name: "安全候选", lat: 22.5, lng: 113.9, typeStr: "餐厅", dist: 1, isMall: false, isDrink: false,
      phone: "0755-12345678", rating: "4.7", averageCost: "86"
    }]
  });
  assert.equal(safeWxCandidate.ok, true);
  assert.equal(
    moderationCalls.some((entry) => entry.content.includes("0755-12345678") && entry.content.includes("4.7") && entry.content.includes("86")),
    true,
    "every persisted candidate detail shown in WeChat must pass content moderation"
  );
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
  assert.equal(created.data.room.schemaVersion, 5);
  assert.equal(created.data.room.accessPlatform, "shared");
  assert.equal(created.data.room.creatorPlatform, "web");
  assert.deepEqual(created.data.room.lifecycle.policy, "owner-disband-only");
  assert.equal(typeof created.data.room.lifecycle.createdAtMs, "number");
  assert.equal(Object.hasOwn(created.data.room, "expiresAt"), false);
  const { docId, room } = created.data;

  const ownerRead = await call("owner", { action: "getRoom", docId });
  assert.equal(ownerRead.ok, true);
  assert.equal(ownerRead.data.room._id, docId);
  assert.equal(ownerRead.data.viewer.uid, "owner");
  const miniOutsiderWebRead = await callWx("openid-cross-outsider", {
    action: "getRoom", docId, accessPlatform: "web"
  });
  assert.equal(miniOutsiderWebRead.data.room, null, "event platform fields cannot bypass room membership from WeChat");
  const miniJoinedWebRoom = await callWx("openid-cross-member", {
    action: "join", code: created.data.room.code, type: "ledger", name: "Mini forged platform", accessPlatform: "web"
  });
  assert.equal(miniJoinedWebRoom.ok, true, "a mini-program identity can join a Web-created room");
  const miniCrossPlatformLedger = clone(miniJoinedWebRoom.data.room.ledger);
  miniCrossPlatformLedger.name = "微信改网页账本";
  miniCrossPlatformLedger.nameUpdatedAt = Date.now() + 20;
  miniCrossPlatformLedger.updatedAt = miniCrossPlatformLedger.nameUpdatedAt;
  miniCrossPlatformLedger.revision = miniCrossPlatformLedger.nameUpdatedAt;
  const miniCrossPlatformWrite = await callWx("openid-cross-member", {
    action: "syncLedger", docId, ledger: miniCrossPlatformLedger, membershipEpoch: miniJoinedWebRoom.data.viewer.membershipEpoch,
    accessPlatform: "web"
  });
  assert.equal(miniCrossPlatformWrite.ok, true, "mini-program writes must sync into a Web-created room");
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

  const protectedOwnerBefore = forgedUidSync.data.ledger.members.find((item) => item.uid === "owner");
  const protectedRenameLedger = clone(forgedUidSync.data.ledger);
  const protectedRenameAt = Date.now() + 2000;
  protectedRenameLedger.members = protectedRenameLedger.members.map((item) => item.uid === "owner"
    ? { ...item, name: "伪造的房主名字", updatedAt: protectedRenameAt, updatedBy: "owner" }
    : item);
  protectedRenameLedger.updatedAt = protectedRenameAt;
  protectedRenameLedger.revision = protectedRenameAt;
  const protectedRename = await call("owner", {
    action: "syncLedger", docId, membershipEpoch: ownerEpoch, ledger: protectedRenameLedger
  });
  assert.equal(protectedRename.ok, true);
  assert.equal(
    protectedRename.data.ledger.members.find((item) => item.uid === "owner").name,
    protectedOwnerBefore.name,
    "whole-ledger writes must not rename a real room identity"
  );

  const protectedDeleteLedger = clone(protectedRename.data.ledger);
  const protectedDeleteAt = protectedRenameAt + 1;
  protectedDeleteLedger.members = protectedDeleteLedger.members.filter((item) => item.uid !== "owner");
  protectedDeleteLedger.memberTombstones[String(protectedOwnerBefore.id)] = {
    deletedAt: protectedDeleteAt,
    deletedBy: "owner"
  };
  protectedDeleteLedger.updatedAt = protectedDeleteAt;
  protectedDeleteLedger.revision = protectedDeleteAt;
  const protectedDelete = await call("owner", {
    action: "syncLedger", docId, membershipEpoch: ownerEpoch, ledger: protectedDeleteLedger
  });
  assert.equal(protectedDelete.ok, true);
  assert.equal(
    protectedDelete.data.ledger.members.some((item) => item.uid === "owner"),
    true,
    "whole-ledger writes must not remove a real room identity"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(protectedDelete.data.ledger.memberTombstones, String(protectedOwnerBefore.id)),
    false,
    "a real room identity must not retain a destructive ledger tombstone"
  );

  const migratedMissingUidRoom = clone(rooms.get(docId));
  const migratedOwner = migratedMissingUidRoom.ledger.members.find((item) => String(item.id) === String(protectedOwnerBefore.id));
  delete migratedOwner.uid;
  rooms.set(docId, migratedMissingUidRoom);
  const migratedRenameLedger = clone(migratedMissingUidRoom.ledger);
  const migratedRenameAt = protectedDeleteAt + 10;
  migratedRenameLedger.members = migratedRenameLedger.members.map((item) => String(item.id) === String(protectedOwnerBefore.id)
    ? { ...item, name: "伪造的迁移成员名", updatedAt: migratedRenameAt, updatedBy: "owner" }
    : item);
  migratedRenameLedger.updatedAt = migratedRenameAt;
  migratedRenameLedger.revision = migratedRenameAt;
  const migratedRename = await call("owner", {
    action: "syncLedger", docId, membershipEpoch: ownerEpoch, ledger: migratedRenameLedger
  });
  assert.equal(migratedRename.ok, true);
  assert.equal(
    migratedRename.data.ledger.members.find((item) => String(item.id) === String(protectedOwnerBefore.id)).name,
    protectedOwnerBefore.name,
    "a room-backed migrated ledger member without uid must still be protected from rename"
  );
  assert.equal(
    migratedRename.data.ledger.members.find((item) => String(item.id) === String(protectedOwnerBefore.id)).uid,
    "owner",
    "a room-backed migrated ledger member must recover its trusted uid"
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
  assert.equal(midpointCreated.data.room.schemaVersion, 5);
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
    { id: "forged-client-id", name: "候选商场", lat: 22.54000001, lng: 113.98000001, typeStr: "购物中心", dist: 320, isMall: true, isDrink: false,
      address: "深圳市福田区测试路 1 号", category: "商场;购物中心", phone: "0755-12345678", rating: "4.7", averageCost: "86" },
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
  assert.equal(publishedDecision.data.decision.candidates[0].address, "深圳市福田区测试路 1 号", "candidate address must survive shared-room normalization");
  assert.equal(publishedDecision.data.decision.candidates[0].phone, "0755-12345678", "candidate details must sync to every room member");
  assert.equal(publishedDecision.data.decision.candidates[0].rating, "4.7");
  assert.equal(publishedDecision.data.decision.candidates[0].averageCost, "86");
  assert.match(publishedDecision.data.decision.roundId, /^round_/);
  const invalidCandidateDetails = await call("mid-owner", {
    action: "publishDecisionCandidates", docId: midpointDocId, membershipEpoch: ownerDecisionEpoch,
    roundId: publishedDecision.data.decision.roundId, revision: publishedDecision.data.decision.revision,
    candidates: [Object.assign({}, decisionCandidates[0], { phone: "联系我加微信", rating: "9.9" })]
  });
  assert.equal(invalidCandidateDetails.code, "INVALID_DECISION", "candidate phone and numeric details must use restricted formats");
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

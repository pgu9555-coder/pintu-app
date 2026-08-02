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
  assert.match(created.data.room.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  assert.deepEqual(created.data.room.memberUids, ["owner"]);
  const { docId, room } = created.data;

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

  const wrongType = await call("stranger-2", {
    action: "join",
    type: "midpoint",
    code: room.code,
    name: "路人"
  });
  assert.equal(wrongType.code, "WRONG_ROOM_TYPE");
  assert.equal(rooms.get(docId).memberUids.includes("stranger-2"), false);

  const left = await call("member", { action: "leave", docId });
  assert.equal(left.ok, true);
  assert.equal(rooms.get(docId).memberUids.includes("member"), false);
  assert.equal(rooms.get(docId).members.some((item) => item.uid === "member"), false);
  assert.equal(rooms.get(docId).ledger.members.some((item) => item.uid === "member"), true);

  const ownerLeave = await call("owner", { action: "leave", docId });
  assert.equal(ownerLeave.code, "OWNER_MUST_DISBAND");
  assert.equal(rooms.get(docId).memberUids.includes("owner"), true);

  console.log("roomGateway unit checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

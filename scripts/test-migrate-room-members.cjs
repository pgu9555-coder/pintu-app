const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  ownerUidFor,
  memberUidsFor,
  migrationPatchFor
} = require("./migrate-room-members.cjs");

function test(name, run) {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test("the full-table migration refuses accidental execution", () => {
  const scriptPath = path.join(__dirname, "migrate-room-members.cjs");
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, RUN_ROOM_MEMBERSHIP_MIGRATION: "" }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /disabled by default/);
});

test("a departed ledger member is never restored to memberUids", () => {
  const room = {
    toolType: "ledger",
    ownerUid: "owner",
    memberUids: ["owner"],
    members: [{ uid: "owner", name: "房主" }],
    ledger: {
      members: [
        { uid: "owner", name: "房主" },
        { uid: "departed", name: "已退出成员" }
      ]
    }
  };

  const migration = migrationPatchFor(room);
  assert.deepEqual(migration.memberUids, ["owner"]);
  assert.equal(migration.memberUids.includes("departed"), false);
  assert.deepEqual(migration.patch, {});
});

test("a typed room removes access ids left behind by an unsafe old migration", () => {
  const room = {
    toolType: "ledger",
    ownerUid: "owner",
    memberUids: ["owner", "active-member", "departed"],
    members: [
      { uid: "owner", name: "房主" },
      { uid: "active-member", name: "仍在房间" }
    ],
    ledger: {
      members: [
        { uid: "owner", name: "房主" },
        { uid: "active-member", name: "仍在房间" },
        { uid: "departed", name: "已退出成员" }
      ]
    }
  };

  const migration = migrationPatchFor(room);
  assert.deepEqual(migration.memberUids, ["owner", "active-member"]);
  assert.deepEqual(migration.patch, { memberUids: ["owner", "active-member"] });
});

test("a typed room never infers its owner from a possibly polluted access list", () => {
  const room = {
    roomType: "midpoint",
    memberUids: ["departed"],
    members: [{ uid: "active-owner", name: "活跃发起者" }],
    meetup: { people: [{ uid: "departed", name: "旧位置" }] }
  };

  const migration = migrationPatchFor(room);
  assert.equal(migration.ownerUid, "active-owner");
  assert.deepEqual(migration.memberUids, ["active-owner"]);
  assert.deepEqual(migration.patch, {
    ownerUid: "active-owner",
    memberUids: ["active-owner"]
  });
});

test("ledger-only historical identities cannot become owner or member", () => {
  const room = {
    ledger: { members: [{ uid: "historical", name: "历史成员" }] },
    meetup: { people: [{ uid: "stale-meetup", name: "旧碰面成员" }] }
  };

  assert.equal(ownerUidFor(room), null);
  assert.deepEqual(memberUidsFor(room, ownerUidFor(room)), []);
  assert.deepEqual(migrationPatchFor(room).patch, {});
});

test("an old room can infer owner and access from active top-level members", () => {
  const room = {
    members: [
      { uid: "active-owner", name: "甲" },
      { uid: "active-member", name: "乙" }
    ],
    ledger: { members: [{ uid: "departed", name: "已退出成员" }] }
  };

  const migration = migrationPatchFor(room);
  assert.equal(migration.ownerUid, "active-owner");
  assert.deepEqual(migration.memberUids, ["active-owner", "active-member"]);
  assert.deepEqual(migration.patch, {
    ownerUid: "active-owner",
    memberUids: ["active-owner", "active-member"]
  });
});

test("an old room prefers its existing access list when inferring owner", () => {
  const room = {
    memberUids: ["existing-member"],
    members: [{ uid: "active-member", name: "活跃成员" }],
    ledger: { members: [{ uid: "historical", name: "历史成员" }] }
  };

  const migration = migrationPatchFor(room);
  assert.equal(migration.ownerUid, "existing-member");
  assert.deepEqual(migration.memberUids, ["existing-member", "active-member"]);
  assert.equal(migration.memberUids.includes("historical"), false);
});

test("explicit owner remains authorized while invalid and duplicate ids are cleaned", () => {
  const room = {
    ownerUid: "owner",
    memberUids: ["member", "member", ""],
    members: [{ uid: "member" }, { uid: "owner" }, { uid: null }]
  };

  const migration = migrationPatchFor(room);
  assert.deepEqual(migration.memberUids, ["member", "owner"]);
  assert.deepEqual(migration.patch, { memberUids: ["member", "owner"] });
});

console.log("Room membership migration tests passed.");

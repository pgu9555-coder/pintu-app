const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rulesPath = path.join(__dirname, "..", "cloudbase-security-rules.json");
const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
const rooms = rules.rooms || {};
const profiles = rules.user_profiles || {};
const cleanupTasks = rules.profile_avatar_cleanup || {};
const applyScript = fs.readFileSync(path.join(__dirname, "apply-cloudbase-security.cjs"), "utf8");

assert.equal(
  rooms.read,
  false,
  "browser clients must not read room documents directly; use roomGateway"
);
assert.equal(rooms.create, false, "browser clients must not create room documents directly");
assert.equal(rooms.update, false, "browser clients must not update room documents directly");
assert.equal(rooms.delete, false, "browser clients must not delete room documents directly");
assert.equal(profiles.read, false, "clients must not read user profiles directly");
assert.equal(profiles.create, false, "clients must not create user profiles directly");
assert.equal(profiles.update, false, "clients must not update user profiles directly");
assert.equal(profiles.delete, false, "clients must not delete user profiles directly");
assert.deepEqual(cleanupTasks, { read: false, create: false, update: false, delete: false }, "avatar cleanup retry records must remain cloud-function-only");
assert.match(applyScript, /createCollectionIfNotExists/, "deployment must create required collections automatically");
assert.match(applyScript, /member_access_platform_created_id/, "deployment must create the stable my-rooms cursor index");
assert.match(applyScript, /createdAt/, "the my-rooms cursor index must use immutable creation time");
assert.doesNotMatch(applyScript, /(?:setStorageAcl|getStorageAcl|READONLY)/, "deployment must never make the whole storage bucket public-read");

console.log("CloudBase security configuration checks passed.");

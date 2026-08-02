const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rulesPath = path.join(__dirname, "..", "cloudbase-security-rules.json");
const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
const rooms = rules.rooms || {};

assert.equal(
  rooms.read,
  "auth != null && (auth.openid in doc.memberUids || auth.uid in doc.memberUids)",
  "room reads must support both WeChat/openid and Web/uid identities"
);
assert.equal(rooms.create, false, "browser clients must not create room documents directly");
assert.equal(rooms.update, false, "browser clients must not update room documents directly");
assert.equal(rooms.delete, false, "browser clients must not delete room documents directly");

console.log("CloudBase security configuration checks passed.");

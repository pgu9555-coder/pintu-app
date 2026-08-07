const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rulesPath = path.join(__dirname, "..", "cloudbase-security-rules.json");
const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
const rooms = rules.rooms || {};
const profiles = rules.user_profiles || {};
const cleanupTasks = rules.profile_avatar_cleanup || {};
const applyScript = fs.readFileSync(path.join(__dirname, "apply-cloudbase-security.cjs"), "utf8");
const gatewayConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cloudfunctions", "roomGateway", "config.json"), "utf8"));
const mapGatewayConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cloudfunctions", "mapGateway", "config.json"), "utf8"));
const mapGatewayPackage = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cloudfunctions", "mapGateway", "package.json"), "utf8"));
const functionRules = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cloudbase-function-security-rules.json"), "utf8"));
const cloudbaseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cloudbaserc.json"), "utf8"));
const deployWorkflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "deploy-cloudbase.yml"), "utf8");
const mapConfigScript = fs.readFileSync(path.join(__dirname, "prepare-map-gateway-config.cjs"), "utf8");
const { withMapGatewaySecret } = require("./prepare-map-gateway-config.cjs");

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
assert.match(applyScript, /member_created_id/, "deployment must create the cross-platform my-rooms cursor index");
assert.doesNotMatch(applyScript, /MgoIndexKeys:[\s\S]*?accessPlatform/, "my-rooms index must not hide rooms created on another client");
assert.match(applyScript, /createdAt/, "the my-rooms cursor index must use immutable creation time");
assert.doesNotMatch(applyScript, /(?:setStorageAcl|getStorageAcl|READONLY)/, "deployment must never make the whole storage bucket public-read");
assert.ok(
  gatewayConfig.permissions && Array.isArray(gatewayConfig.permissions.openapi) && gatewayConfig.permissions.openapi.includes("security.msgSecCheck"),
  "roomGateway must declare the WeChat text-security cloud-call permission"
);
assert.deepEqual(mapGatewayConfig.permissions, { openapi: [] }, "mapGateway must remain an auth-only proxy with no broad OpenAPI permissions");
assert.equal(mapGatewayPackage.dependencies["wx-server-sdk"], "3.0.1", "mapGateway dependencies must be pinned");
assert.equal(functionRules["*"].invoke, false, "unknown cloud functions must remain closed by default");
assert.equal(functionRules.roomGateway.invoke, "auth != null", "roomGateway must require authentication");
assert.equal(functionRules.mapGateway.invoke, "auth != null", "mapGateway must require authentication");
assert.ok(cloudbaseConfig.functions.some((item) => item.name === "mapGateway"), "CloudBase deployment must include mapGateway");
assert.match(deployWorkflow, /secrets\.AMAP_WEB_SERVICE_KEY/, "deployment must source the map key from a GitHub secret");
assert.match(deployWorkflow, /id:\s*map-secret[\s\S]*?GITHUB_OUTPUT/, "deployment must detect whether the optional map secret exists without exposing it");
assert.match(deployWorkflow, /echo "available=false" >> "\$GITHUB_OUTPUT"/, "a missing map secret must produce an explicit false guard output");
assert.match(deployWorkflow, /name:\s*Prepare map search deployment configuration\s*\r?\n\s*if:\s*\$\{\{\s*steps\.map-secret\.outputs\.available\s*==\s*'true'\s*\}\}/, "mapGateway environment preparation must be skipped when the optional map secret is absent");
assert.match(deployWorkflow, /run:\s*node scripts\/prepare-map-gateway-config\.cjs/, "deployment must prepare the map function environment through the tested script");
assert.match(deployWorkflow, /name:\s*Deploy map search gateway\s*\r?\n\s*if:\s*\$\{\{\s*steps\.map-secret\.outputs\.available\s*==\s*'true'\s*\}\}/, "mapGateway deployment must be skipped when the optional map secret is absent");
assert.doesNotMatch(deployWorkflow, /Missing AMAP_WEB_SERVICE_KEY/, "a missing optional map secret must not fail the website and room deployment");
assert.doesNotMatch(deployWorkflow, /config update fn mapGateway|--env-mode|--env\s/, "deployment must not use unsupported CloudBase CLI environment flags");
assert.ok(!/AMAP_WEB_SERVICE_KEY\s*[:=]\s*[0-9a-z]{16,}/i.test(deployWorkflow), "deployment workflow must not contain a literal map key");
assert.doesNotMatch(mapConfigScript, /console\.|process\.stdout|process\.stderr/, "map configuration preparation must never print the secret");
const preparedConfig = withMapGatewaySecret(cloudbaseConfig, "\n testmapkey0123456789 \r\n");
const preparedMapGateway = preparedConfig.functions.find((item) => item.name === "mapGateway");
assert.equal(preparedMapGateway.envVariables.AMAP_WEB_SERVICE_KEY, "testmapkey0123456789", "mapGateway deployment configuration must normalize copied whitespace without changing the key");
assert.equal(cloudbaseConfig.functions.find((item) => item.name === "mapGateway").envVariables, undefined, "secret preparation must not mutate the checked-in configuration object");
assert.throws(() => withMapGatewaySecret(cloudbaseConfig, " short "), /missing or invalid/, "invalid map secrets must be rejected before deployment");
assert.throws(() => withMapGatewaySecret(cloudbaseConfig, "test map key 0123456789"), /missing or invalid/, "embedded whitespace in map secrets must be rejected before deployment");

console.log("CloudBase security configuration checks passed.");

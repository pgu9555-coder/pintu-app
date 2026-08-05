const fs = require("node:fs");
const path = require("node:path");
const CloudBaseModule = require("@cloudbase/manager-node");

const CloudBase = CloudBaseModule.default || CloudBaseModule;
const envId = process.env.CLOUDBASE_ENV_ID || "pintu-d4g77ecn24b674fa0";
const secretId = process.env.TCB_SECRET_ID;
const secretKey = process.env.TCB_SECRET_KEY;

if (!secretId || !secretKey) {
  throw new Error("Missing TCB_SECRET_ID or TCB_SECRET_KEY.");
}

const rulesPath = path.join(__dirname, "..", "cloudbase-security-rules.json");
const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
const cloudbase = new CloudBase({
  secretId,
  secretKey,
  envId,
  region: process.env.TCB_REGION || "ap-shanghai"
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

async function applyCollectionRule(collectionName, securityRule) {
  const serializedRule = JSON.stringify(securityRule);

  await cloudbase.permission.modifyResourcePermission({
    resourceType: "collection",
    resource: collectionName,
    permission: "CUSTOM",
    securityRule: serializedRule
  });

  const described = await cloudbase.permission.describeResourcePermission({
    resourceType: "collection",
    resources: [collectionName]
  });
  const permissions = described?.Data?.PermissionList || [];
  const applied =
    permissions.find((item) => item.Resource === collectionName) || permissions[0];

  if (!applied || applied.Permission !== "CUSTOM") {
    throw new Error(`Security rule verification failed for ${collectionName}.`);
  }

  const actualRule =
    typeof applied.SecurityRule === "string"
      ? JSON.parse(applied.SecurityRule || "{}")
      : applied.SecurityRule || {};
  if (
    JSON.stringify(canonicalize(actualRule)) !==
    JSON.stringify(canonicalize(securityRule))
  ) {
    console.error("Expected rule:", JSON.stringify(canonicalize(securityRule)));
    console.error("Applied rule:", JSON.stringify(canonicalize(actualRule)));
    throw new Error(`Security rule mismatch for ${collectionName}.`);
  }

  console.log(`Verified CUSTOM security rule for ${collectionName}.`);
}

async function ensureCollection(collectionName) {
  const databaseManager = cloudbase.database;
  if (
    !databaseManager ||
    typeof databaseManager.createCollectionIfNotExists !== "function"
  ) {
    throw new Error(
      `CloudBase manager cannot ensure collection ${collectionName}; refusing to deploy incomplete security rules.`
    );
  }

  await databaseManager.createCollectionIfNotExists(collectionName);
  console.log(`Verified database collection ${collectionName} exists.`);
}

async function ensureMyRoomsIndex() {
  const indexName = "member_created_id";
  const exists = await cloudbase.database.checkIndexExists("rooms", indexName);
  if (!exists || !exists.Exists) {
    await cloudbase.database.updateCollection("rooms", {
      CreateIndexes: [
        {
          IndexName: indexName,
          MgoKeySchema: {
            MgoIsUnique: false,
            MgoIndexKeys: [
              { Name: "memberUids", Direction: "1" },
              { Name: "createdAt", Direction: "-1" },
              { Name: "_id", Direction: "-1" }
            ]
          }
        }
      ]
    });
  }
  const verified = await cloudbase.database.checkIndexExists("rooms", indexName);
  if (!verified || !verified.Exists) {
    throw new Error("My-rooms database index verification failed.");
  }
  console.log(`Verified database index ${indexName} exists.`);
}

async function main() {
  for (const [collectionName, securityRule] of Object.entries(rules)) {
    await ensureCollection(collectionName);
    await applyCollectionRule(collectionName, securityRule);
  }
  await ensureMyRoomsIndex();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

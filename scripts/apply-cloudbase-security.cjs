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
    throw new Error(`Security rule mismatch for ${collectionName}.`);
  }

  console.log(`Verified CUSTOM security rule for ${collectionName}.`);
}

async function main() {
  for (const [collectionName, securityRule] of Object.entries(rules)) {
    await applyCollectionRule(collectionName, securityRule);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

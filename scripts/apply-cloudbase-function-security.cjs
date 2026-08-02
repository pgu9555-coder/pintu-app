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

const rulesPath = path.join(__dirname, "..", "cloudbase-function-security-rules.json");
const securityRule = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
const serializedRule = JSON.stringify(securityRule);
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

async function main() {
  await cloudbase.permission.modifyResourcePermission({
    resourceType: "function",
    permission: "CUSTOM",
    securityRule: serializedRule
  });

  const described = await cloudbase.permission.describeResourcePermission({
    resourceType: "function"
  });
  const permissions = described?.Data?.PermissionList || [];
  const applied = permissions.find((item) => item.Permission === "CUSTOM") || permissions[0];
  if (!applied || applied.Permission !== "CUSTOM") {
    throw new Error("Function security rule verification failed.");
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
    throw new Error("Function security rule mismatch.");
  }

  console.log("Verified CUSTOM security rule for CloudBase functions.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

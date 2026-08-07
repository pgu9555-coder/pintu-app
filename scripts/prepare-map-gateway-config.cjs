const fs = require("node:fs");
const path = require("node:path");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withMapGatewaySecret(sourceConfig, secret) {
  if (!isPlainObject(sourceConfig)) throw new Error("CloudBase configuration is invalid.");
  if (typeof secret !== "string" || secret !== secret.trim() || secret.length < 16 || secret.length > 256) {
    throw new Error("AMAP_WEB_SERVICE_KEY is missing or invalid.");
  }

  const config = JSON.parse(JSON.stringify(sourceConfig));
  const functions = Array.isArray(config.functions) ? config.functions : [];
  const mapGateway = functions.find((item) => item && item.name === "mapGateway");
  if (!mapGateway) throw new Error("mapGateway is missing from cloudbaserc.json.");

  const existing = isPlainObject(mapGateway.envVariables) ? mapGateway.envVariables : {};
  mapGateway.envVariables = { ...existing, AMAP_WEB_SERVICE_KEY: secret };
  return config;
}

function main() {
  const configPath = path.join(__dirname, "..", "cloudbaserc.json");
  const sourceConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const prepared = withMapGatewaySecret(sourceConfig, process.env.AMAP_WEB_SERVICE_KEY);
  fs.writeFileSync(configPath, `${JSON.stringify(prepared, null, 2)}\n`, "utf8");
}

if (require.main === module) main();

module.exports = { withMapGatewaySecret };

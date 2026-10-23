"use strict";

// Manual preview/upload only. This program never submits an audit or releases
// a public version, and never opens or prints the private key itself.
const fs = require("node:fs");
const path = require("node:path");
const APP_ID = "wxe1fe19432c29e3cd";
const CI_VERSION = "2.1.48";
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_PROJECT = path.join(REPO_ROOT, "miniprogram-shell");
const IGNORES = Object.freeze([
  "**/node_modules/**/*", "**/.git/**/*", "**/.env*", "**/*.key", "**/*.pem", "**/*.p12", "**/*.pfx",
  "**/*private*", "**/*secret*", "**/project.private.config.json", "**/README*", "**/*.test.*", "**/*.log"
]);

function publicError(message) {
  const error = new Error(message); error.isPublic = true; return error;
}

function parseArgs(args) {
  const result = {};
  const values = new Set(["mode", "version", "desc", "private-key", "project", "qrcode"]);
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--help" || option === "-h") { result.help = true; continue; }
    if (option === "--dry-run") { result.dryRun = true; continue; }
    if (!option.startsWith("--") || !values.has(option.slice(2))) throw publicError("存在不支持的参数，请运行 --help 查看用法。");
    const key = option.slice(2), value = args[++index];
    if (!value || value.startsWith("--") || Object.prototype.hasOwnProperty.call(result, key)) throw publicError("参数缺少值或重复，请运行 --help 查看用法。");
    result[key] = value;
  }
  return result;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function excluded(relative) {
  const parts = relative.split(/[\\/]/);
  return parts.some((part) => part === "node_modules" || part === ".git" || /^\.env/i.test(part) || /private|secret/i.test(part)) ||
    /\.(key|pem|p12|pfx|log)$/i.test(relative) || /^README/i.test(parts[parts.length - 1]) || /\.test\./i.test(relative);
}

function projectInventory(project) {
  let included = 0, ignored = 0, bytes = 0, sensitive = 0;
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, item.name), relative = path.relative(project, full);
      if (item.isSymbolicLink()) throw publicError("小程序项目中含符号链接，请移除后再打包，避免带入项目外文件。");
      if (excluded(relative)) {
        ignored++;
        if (item.name !== "project.private.config.json" && /private|secret|(^|[\\/])\.env|\.(key|pem|p12|pfx)$/i.test(relative)) sensitive++;
        continue;
      }
      if (item.isDirectory()) visit(full);
      else if (item.isFile()) { included++; bytes += fs.statSync(full).size; }
    }
  }
  visit(project);
  return { included, ignored, bytes, sensitive };
}

function configuration(options, env = process.env) {
  const mode = options.mode || "preview";
  if (!["preview", "upload"].includes(mode)) throw publicError("--mode 只支持 preview 或 upload。");
  if (!options.version || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.version)) throw publicError("请用 --version 提供 1 至 64 位版本号，例如 1.0.0。");
  const desc = options.desc || "拼途小程序手动构建";
  if (desc.length > 200 || /[\u0000-\u001f\u007f]/.test(desc)) throw publicError("--desc 需为不超过 200 字的单行说明。");
  const project = path.resolve(options.project || DEFAULT_PROJECT);
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) throw publicError("小程序项目目录不存在。");
  const realProject = fs.realpathSync(project);
  let projectConfig, appConfig;
  try {
    projectConfig = JSON.parse(fs.readFileSync(path.join(realProject, "project.config.json"), "utf8"));
    appConfig = JSON.parse(fs.readFileSync(path.join(realProject, "app.json"), "utf8"));
  } catch (_) { throw publicError("小程序项目配置缺失或 JSON 无效。"); }
  if (projectConfig.appid !== APP_ID || projectConfig.compileType !== "miniprogram") throw publicError("项目必须使用拼途现有 AppID 和 miniprogram 编译类型。");
  if (!Array.isArray(appConfig.pages) || !appConfig.pages.length || !fs.existsSync(path.join(realProject, "app.js"))) throw publicError("项目缺少 app.js 或有效页面清单。");
  for (const page of appConfig.pages) {
    if (typeof page !== "string" || !/^[A-Za-z0-9_/-]+$/.test(page) || page.split("/").includes("..") ||
        ![".js", ".wxml", ".wxss", ".json"].every((extension) => fs.existsSync(path.join(realProject, page + extension)))) throw publicError("页面清单含无效路径或页面文件不完整。");
  }
  const keyArgument = options["private-key"] || env.PRIVATE_KEY_PATH;
  let privateKeyPath = "";
  if (keyArgument) {
    const resolved = path.resolve(keyArgument);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile() || fs.statSync(resolved).size === 0) throw publicError("PRIVATE_KEY_PATH 指向的本地代码上传密钥不存在、为空或不是文件。");
    privateKeyPath = fs.realpathSync(resolved);
    if (inside(realProject, privateKeyPath) || inside(REPO_ROOT, privateKeyPath)) throw publicError("代码上传密钥必须放在小程序项目和 Git 仓库目录之外，不能随项目上传。");
  } else if (!options.dryRun) {
    throw publicError("缺少代码上传密钥。请管理员在微信后台下载并保存在项目目录外，再设置 PRIVATE_KEY_PATH 或 --private-key；不要在聊天或 Git 中发送密钥。");
  }
  const qrcode = path.resolve(options.qrcode || path.join(REPO_ROOT, "..", "wechat-preview.png"));
  if (mode === "preview" && (inside(realProject, qrcode) || (privateKeyPath && qrcode === privateKeyPath))) throw publicError("预览二维码输出路径必须位于小程序项目之外，且不能覆盖密钥。");
  const inventory = projectInventory(realProject);
  if (!options.dryRun && inventory.sensitive) throw publicError("小程序项目中含疑似凭据文件或私有配置。请移到项目目录之外后再预览/上传；干运行可检查排除数量。");
  return { mode, version: options.version, desc, projectPath: realProject, privateKeyPath, qrcode, inventory, dryRun: !!options.dryRun };
}

function loadOfficialCI() {
  const packageRoot = path.join(__dirname, "wechat-release", "node_modules", "miniprogram-ci");
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")); }
  catch (_) { throw publicError("缺少已固定版本的官方 miniprogram-ci。请在 scripts/wechat-release 目录执行 pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org；本脚本不会自动安装依赖。"); }
  if (metadata.name !== "miniprogram-ci" || metadata.version !== CI_VERSION) throw publicError("miniprogram-ci 版本不匹配，请按独立 package.json 安装固定官方版本。");
  return require(packageRoot);
}

async function execute(config, ci) {
  const project = new ci.Project({ appid: APP_ID, type: "miniProgram", projectPath: config.projectPath, privateKeyPath: config.privateKeyPath, ignores: [...IGNORES] });
  const parameters = { project, version: config.version, desc: config.desc, setting: { useProjectConfig: true }, robot: 1, onProgressUpdate() {} };
  if (config.mode === "preview") {
    fs.mkdirSync(path.dirname(config.qrcode), { recursive: true });
    await ci.preview({ ...parameters, qrcodeFormat: "image", qrcodeOutputDest: config.qrcode });
  } else await ci.upload(parameters);
}

const HELP = `拼途小程序手动预览/上传（不提审、不发布）
用法：node scripts/wechat-release.cjs --mode preview|upload --version 1.0.0 --desc "本次更新"
  --dry-run             只检查本地配置，不读取密钥内容、不调用微信或加载 CI
  --private-key <路径>  本地代码上传密钥；也可使用 PRIVATE_KEY_PATH 环境变量
  --project <目录>      默认 miniprogram-shell，AppID 固定为拼途现有账号
  --qrcode <路径>       预览二维码输出，必须位于小程序项目之外
  --help                显示帮助
请先由管理员下载代码上传密钥并配置当前出口 IP 白名单；不要把私钥放进 Git 或 ZIP。`;

async function main(args = process.argv.slice(2), env = process.env, logger = console.log) {
  const options = parseArgs(args);
  if (options.help) { logger(HELP); return; }
  const config = configuration(options, env);
  if (config.dryRun) {
    logger(JSON.stringify({ mode: config.mode, appid: APP_ID, version: config.version, privateKeyConfigured: !!config.privateKeyPath, files: config.inventory, excludedPatterns: IGNORES, networkAccessed: false, auditSubmitted: false, published: false }, null, 2));
    return;
  }
  await execute(config, loadOfficialCI());
  logger(config.mode === "preview" ? "预览成功，二维码已保存到指定本地路径。" : "开发版本上传成功。尚未提交审核或发布，请到微信后台查看开发版本。");
}

if (require.main === module) main().catch((error) => {
  console.error(error && error.isPublic ? error.message : "微信构建或上传失败。请核对管理员权限、出口 IP 白名单、代码上传密钥和项目配置；为保护凭据未输出第三方原始错误。");
  process.exitCode = 1;
});

module.exports = { APP_ID, CI_VERSION, IGNORES, parseArgs, configuration, excluded, projectInventory, execute, main };

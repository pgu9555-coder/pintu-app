"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const release = require("./wechat-release.cjs");

async function main() {
  const parent = fs.realpathSync(path.resolve(__dirname, "..", ".."));
  const temporary = fs.mkdtempSync(path.join(parent, "pintu-wechat-release-test-"));
  try {
    const project = path.join(temporary, "project"); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "project.config.json"), JSON.stringify({ appid: release.APP_ID, compileType: "miniprogram" }));
    fs.writeFileSync(path.join(project, "app.json"), JSON.stringify({ pages: ["pages/home/index"] }));
    fs.writeFileSync(path.join(project, "app.js"), "App({})");
    fs.mkdirSync(path.join(project, "pages/home"), { recursive: true });
    for (const suffix of [".js", ".wxml", ".wxss", ".json"]) fs.writeFileSync(path.join(project, "pages/home/index" + suffix), suffix === ".json" ? "{}" : "");
    const key = path.join(temporary, "private-upload.key");
    fs.writeFileSync(key, "TEST-FIXTURE-NOT-A-REAL-PRIVATE-KEY");
    const args = ["--mode", "preview", "--version", "1.2.3", "--project", project, "--desc", "界面更新"];
    const options = release.parseArgs(args);
    assert.throws(() => release.parseArgs(["--publish"]), /不支持/);
    assert.throws(() => release.parseArgs(["--version"]), /缺少/);
    assert.throws(() => release.parseArgs(["--mode", "preview", "--mode", "upload"]), /重复/);
    assert.throws(() => release.configuration({ ...options, mode: "audit" }, {}), /只支持/);
    assert.throws(() => release.configuration({ ...options, version: "" }, {}), /版本号/);
    assert.throws(() => release.configuration(options, {}), /缺少代码上传密钥/);
    assert.throws(() => release.configuration({ ...options, "private-key": path.join(temporary, "absent.key") }, {}), /不存在/);

    let keyReads = 0;
    const realRead = fs.readFileSync;
    fs.readFileSync = function(file, ...rest) {
      if (path.resolve(String(file)) === key) { keyReads++; throw new Error("must not read private key"); }
      return realRead.call(this, file, ...rest);
    };
    let config;
    try { config = release.configuration(options, { PRIVATE_KEY_PATH: key }); }
    finally { fs.readFileSync = realRead; }
    assert.equal(keyReads, 0);
    assert.equal(config.privateKeyPath, key);
    assert.equal(config.inventory.included, 7);
    assert.throws(() => release.configuration({ ...options, "private-key": path.join(project, "app.js") }, {}), /项目和 Git 仓库目录之外/);
    assert.throws(() => release.configuration({ ...options, qrcode: path.join(project, "preview.png") }, { PRIVATE_KEY_PATH: key }), /二维码输出路径/);
    assert.throws(() => release.configuration({ ...options, qrcode: key }, { PRIVATE_KEY_PATH: key }), /覆盖密钥/);

    fs.writeFileSync(path.join(project, "CONFIG.KEY"), "should-never-upload");
    fs.writeFileSync(path.join(project, ".env.local"), "fixture");
    fs.writeFileSync(path.join(project, "project.private.config.json"), "{}");
    fs.writeFileSync(path.join(project, "README.md"), "documentation");
    const local = release.configuration({ ...options, dryRun: true }, {});
    assert.equal(local.inventory.ignored, 4); assert.equal(local.inventory.sensitive, 2);
    assert.throws(() => release.configuration(options, { PRIVATE_KEY_PATH: key }), /疑似凭据/);
    const messages = [];
    await release.main([...args, "--dry-run"], {}, (message) => messages.push(message));
    assert.match(messages.join(""), /"networkAccessed": false/);
    assert.doesNotMatch(messages.join(""), /should-never-upload|TEST-FIXTURE/);
    fs.rmSync(path.join(project, "CONFIG.KEY")); fs.rmSync(path.join(project, ".env.local"));

    const calls = [];
    const ci = {
      Project: function(projectOptions) { calls.push({ action: "project", options: projectOptions }); this.options = projectOptions; },
      async preview(parameters) { calls.push({ action: "preview", parameters }); fs.writeFileSync(parameters.qrcodeOutputDest, "test-qr"); },
      async upload(parameters) { calls.push({ action: "upload", parameters }); },
      async submitAudit() { throw Error("must never audit"); },
      async release() { throw Error("must never publish"); }
    };
    const qrcode = path.join(temporary, "preview.png");
    config = release.configuration({ ...options, qrcode }, { PRIVATE_KEY_PATH: key });
    await release.execute(config, ci);
    assert.equal(calls[0].options.appid, release.APP_ID);
    assert.equal(calls[0].options.privateKeyPath, key);
    assert.equal(calls[0].options.privateKey, undefined);
    assert.ok(calls[0].options.ignores.includes("**/*.key"));
    assert.equal(calls[1].action, "preview"); assert.equal(calls[1].parameters.qrcodeFormat, "image");
    assert.equal(fs.readFileSync(qrcode, "utf8"), "test-qr");
    await release.execute({ ...config, mode: "upload" }, ci);
    assert.deepEqual(calls.map((call) => call.action), ["project", "preview", "project", "upload"]);
    assert.equal(calls[3].parameters.version, "1.2.3");
    assert.equal(calls[3].parameters.desc, "界面更新");
    assert.equal(calls[3].parameters.setting.useProjectConfig, true);
    console.log("WeChat release checks passed: manual modes, local validation, credential exclusion, dry run, official CI contract, no audit/publish.");
  } finally {
    const resolved = fs.realpathSync(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(resolved).startsWith("pintu-wechat-release-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

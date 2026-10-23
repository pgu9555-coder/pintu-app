"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../miniprogram-shell");
const profile = (letter) => ({ exists: true, nickname: letter, avatarFileId: `avatar-${letter}`, avatarUploadPrefix: `avatars/profile-${letter.toLowerCase().repeat(64)}/` });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function tick() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

function harness() {
  let scope = "guest", app, page;
  const calls = { names: [], rooms: [], updates: [], deletes: [], uploads: [], cleanup: [], navigation: [], toasts: [], modals: [] };
  const storage = {
    localScopeToken: () => scope,
    scopeFromProfile(value) { const match = String(value && value.avatarUploadPrefix || "").match(/^avatars\/profile-([a-f0-9]{64})\/$/); return match ? match[1] : ""; },
    setAccountScope(value) { scope = this.scopeFromProfile(value) || "guest"; return scope !== "guest"; },
    clearAccountScope() { scope = "guest"; }, isAccountScoped: () => scope !== "guest",
    saveName(name) { calls.names.push({ scope, name }); }, getName: () => "",
    save(room) { calls.rooms.push({ scope, room }); }
  };
  const gateway = {
    getProfile() { return Promise.resolve(profile("A")); },
    updateProfile(value) { calls.updates.push({ scope, value }); return Promise.resolve(profile("A")); },
    deleteProfile() { calls.deletes.push(scope); return Promise.resolve({ avatarCleanup: { pendingCount: 0 } }); },
    retryAvatarCleanup() { calls.cleanup.push(scope); return Promise.resolve({ avatarCleanup: { pendingCount: 0 } }); },
    join() { return Promise.resolve({ docId: "room-a", room: { toolType: "ledger" } }); }
  };
  const wx = {
    cloud: { init() {}, uploadFile(options) { calls.uploads.push(options); return Promise.resolve({ fileID: "new-avatar-a" }); }, deleteFile(options) { calls.deletes.push(options); return Promise.resolve({ fileList: [] }); } },
    showToast: (message) => calls.toasts.push(message), showModal: (options) => calls.modals.push(options), hideTabBar() {}, showTabBar() {}, showLoading() {}, hideLoading() {},
    navigateTo(options) { calls.navigation.push(options); if (options.success) options.success(); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "app.js"), "utf8"), {
    require: (name) => name.includes("roomGateway") ? gateway : name.includes("storage") ? storage : { cloudbaseEnvId: "test-env" },
    App: (value) => { app = value; }, wx, console
  });
  vm.runInNewContext(fs.readFileSync(path.join(root, "pages/home/index.js"), "utf8"), {
    require: (name) => name.includes("roomGateway") ? gateway : name.includes("storage") ? storage : require(path.join(root, "utils/invite.js")),
    Page: (value) => { page = value; }, wx, getApp: () => app, console
  });
  page.setData = (patch) => Object.assign(page.data, patch);
  function switchTo(letter) {
    app.resetAccountScope(); app.grantAccountConsent(); app.applyAccountProfile(profile(letter));
    page.profileScope = scope;
    page.setData({ profileLoaded: true, profileBusy: false, busy: false, wechatLoginBusy: false, profileNickname: letter,
      profileAvatarFileId: `avatar-${letter}`, profileAvatarPreview: `avatar-${letter}`, pendingAvatarUrl: "", avatarUploadPrefix: profile(letter).avatarUploadPrefix,
      profileAvatarCleanupPending: 9, profileError: "", name: letter, code: "ABCDEFGH" });
  }
  return { app, page, storage, gateway, wx, calls, switchTo };
}

async function main() {
  {
    const h = harness(), old = deferred(), fresh = deferred(); let count = 0;
    h.gateway.getProfile = () => (++count === 1 ? old.promise : fresh.promise);
    h.app.grantAccountConsent();
    const first = h.app.ensureAccountScope();
    h.app.resetAccountScope(); h.app.grantAccountConsent();
    const second = h.app.ensureAccountScope();
    const oldRejected = assert.rejects(first, /账号空间已切换/);
    old.resolve(profile("A")); await oldRejected;
    assert.equal(h.app.globalData.accountPromise, second, "old response must not erase the new login promise");
    fresh.resolve(profile("B")); await second;
    assert.equal(h.app.globalData.accountProfile.nickname, "B");
    assert.equal(h.storage.localScopeToken(), "b".repeat(64));
  }
  {
    const h = harness(), old = deferred(); h.gateway.getProfile = () => old.promise;
    h.app.grantAccountConsent(); const first = h.app.ensureAccountScope();
    h.switchTo("B"); const rejected = assert.rejects(first, /old network error/);
    old.reject(Error("old network error")); await rejected;
    assert.equal(h.app.globalData.accountProfile.nickname, "B", "old failed login cannot clear a newly established profile");
    assert.equal(h.storage.localScopeToken(), "b".repeat(64));
  }
  {
    const h = harness(); h.page.ensurePrivacyAuthorized = async () => {};
    h.page.setData({ privacyConsentChecked: true });
    await h.page.confirmWechatLogin();
    assert.equal(h.page.data.profileNickname, "A"); assert.equal(h.page.data.wechatLoginBusy, false);
    assert.equal(h.app.hasAccountConsent(), true, "the normal consent/login flow still completes");
  }
  {
    const h = harness(); h.page.ensurePrivacyAuthorized = async () => {};
    h.gateway.getProfile = () => Promise.reject(Error("network failure"));
    h.page.setData({ privacyConsentChecked: true });
    await h.page.confirmWechatLogin();
    assert.equal(h.page.data.wechatLoginBusy, false, "a failed current login remains retryable after its own scope reset");
    assert.equal(h.app.hasAccountConsent(), false);
  }
  {
    const h = harness(), pending = deferred(); h.switchTo("A");
    h.gateway.updateProfile = (value) => { h.calls.updates.push(value); return pending.promise; };
    const saving = h.page.saveProfile(); h.switchTo("B"); pending.resolve(profile("A")); await saving;
    assert.equal(h.page.data.profileNickname, "B"); assert.equal(h.app.globalData.accountProfile.nickname, "B");
    assert.equal(h.calls.names.length, 0, "old profile success cannot save its name in the new scope");
  }
  {
    const h = harness(), upload = deferred(); h.switchTo("A");
    h.page.data.pendingAvatarUrl = "/local/avatar-a.png"; h.wx.cloud.uploadFile = () => upload.promise;
    const saving = h.page.saveProfile(); h.switchTo("B"); upload.resolve({ fileID: "uploaded-for-A" }); await saving;
    assert.equal(h.calls.updates.length, 0, "an upload finished after account change must not submit profile data under B");
    assert.equal(h.calls.deletes.length, 0, "old avatar cleanup must not execute under the new account");
    assert.equal(h.page.data.profileAvatarFileId, "avatar-B");
  }
  {
    const h = harness(), reconcile = deferred(); h.switchTo("A");
    h.gateway.updateProfile = () => Promise.reject(Object.assign(Error("timeout"), { code: "NETWORK_ERROR" }));
    h.gateway.getProfile = () => reconcile.promise;
    const saving = h.page.saveProfile(); await tick(); h.switchTo("B"); reconcile.resolve(profile("A")); await saving;
    assert.equal(h.app.globalData.accountProfile.nickname, "B", "ambiguous save reconciliation is account-bound too");
  }
  {
    const h = harness(); h.switchTo("A"); h.page.deleteProfile();
    h.switchTo("B"); await h.calls.modals[0].success({ confirm: true });
    assert.equal(h.calls.deletes.length, 0, "a confirmation opened for A cannot delete B's profile");
  }
  for (const action of ["removeAvatar", "deleteProfile", "retryAvatarCleanup"]) {
    const h = harness(), pending = deferred(); h.switchTo("A");
    if (action === "removeAvatar") h.gateway.updateProfile = () => pending.promise;
    else if (action === "deleteProfile") h.gateway.deleteProfile = () => pending.promise;
    else h.gateway.retryAvatarCleanup = () => pending.promise;
    let completion;
    if (action === "deleteProfile") { h.page.deleteProfile(); completion = h.calls.modals[0].success({ confirm: true }); }
    else completion = h.page[action]();
    h.switchTo("B"); pending.resolve({ ...profile("A"), avatarCleanup: { pendingCount: 0 } }); await completion;
    assert.equal(h.page.data.profileAvatarFileId, "avatar-B", action + " must ignore an old-account completion");
    assert.equal(h.page.data.profileAvatarCleanupPending, 9);
    assert.equal(h.app.globalData.accountProfile.nickname, "B");
  }
  {
    const h = harness(), pending = deferred(); h.switchTo("A"); h.gateway.join = () => pending.promise;
    const joining = h.page.join(); h.switchTo("B"); pending.resolve({ docId: "room-a", room: { toolType: "ledger" } }); await joining;
    assert.equal(h.calls.rooms.length, 0); assert.equal(h.calls.names.length, 0); assert.equal(h.calls.navigation.length, 0);
  }
  {
    const h = harness(); h.switchTo("A"); const loading = h.page.loadProfile(); h.switchTo("B"); await loading;
    assert.equal(h.page.data.profileNickname, "B"); assert.equal(h.storage.localScopeToken(), "b".repeat(64));
  }
  {
    const h = harness(), pending = deferred(); h.switchTo("A"); h.gateway.updateProfile = () => pending.promise;
    const saving = h.page.saveProfile(); h.page.onUnload(); pending.resolve(profile("A")); await saving;
    assert.equal(h.calls.names.length, 0, "an unloaded page must not apply pending profile callbacks");
  }
  console.log("Native account isolation checks passed: login generations, old success/failure, avatar upload/reconciliation, delete confirmations, profile cleanup, room join, and unloaded pages.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

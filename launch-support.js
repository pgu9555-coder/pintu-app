(function () {
  'use strict';
  var consentPromise = null;
  window.pintuCloudConsentGranted = false;
  var entryDialog = null;

  function dialog(title, paragraphs) {
    var box = document.createElement('dialog');
    box.className = 'launch-dialog';
    var heading = document.createElement('h2'); heading.textContent = title; box.appendChild(heading);
    paragraphs.forEach(function (text) { var p = document.createElement('p'); p.textContent = text; box.appendChild(p); });
    document.body.appendChild(box);
    box.addEventListener('close', function () { box.remove(); });
    return box;
  }
  function button(box, text, action) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = action; box.appendChild(b); return b;
  }
  function link(box, text, href) {
    var a = document.createElement('a'); a.textContent = text; a.href = href; a.target = '_blank'; a.rel = 'noopener'; box.appendChild(a); box.appendChild(document.createTextNode('　'));
  }

  window.pintuCheckCloudOrigin = function () {
    var origin = (window.PINTU_CONFIG || {}).collaborationOrigin;
    if (!origin || window.location.origin === origin) return true;
    window.rmTcbError = Object.assign(new Error('多人协作请使用测试入口；当前页面的本机功能仍可使用。'), { code: 'COLLABORATION_ENTRY_REQUIRED', publicMessage: true });
    if (!entryDialog) {
      var box = entryDialog = dialog('打开多人协作测试版', [
        '多人协作目前使用独立的测试地址。请在新页面创建或加入房间，测试服务可能受访问限额影响。',
        '当前页面的本机账本不会自动搬过去。如需迁移，请先从首页“备份与迁移”导出，再在新页面导入。'
      ]);
      var target = new URL(origin);
      // Preserve room invitation links while leaving local ledger data on-device.
      target.search = window.location.search;
      target.hash = window.location.hash;
      link(box, '打开协作测试版', target.href);
      button(box, '留在当前页面', function () { box.close(); });
      box.addEventListener('close', function () { entryDialog = null; });
      box.showModal();
    }
    return false;
  };

  window.pintuRequestCloudConsent = function () {
    if (window.pintuCloudConsentGranted) return Promise.resolve(true);
    if (consentPromise) return consentPromise;
    consentPromise = new Promise(function (resolve) {
      var box = dialog('使用多人协作', [
        '协作功能会建立匿名身份，并将你提交的昵称、地点或账目保存到云端。房间成员可以查看共享内容，请只向信任的人分享房间码。',
        '匿名身份保存在当前浏览器。清理浏览器数据或换域名前，请备份账本，并将房主权限转交给已加入的可信成员（可使用你自己的微信账号）。'
      ]);
      link(box, '隐私说明', '/privacy.html'); link(box, '用户协议', '/terms.html');
      var label = document.createElement('label'); label.style.display = 'block'; label.style.marginTop = '16px';
      var check = document.createElement('input'); check.type = 'checkbox'; label.appendChild(check);
      label.appendChild(document.createTextNode('我已阅读并同意用户协议与隐私说明')); box.appendChild(label);
      var accepted = false;
      button(box, '暂不使用', function () { box.close(); });
      var proceed = button(box, '同意并继续', function () { accepted = true; window.pintuCloudConsentGranted = true; box.close(); });
      proceed.disabled = true; check.onchange = function () { proceed.disabled = !check.checked; };
      box.addEventListener('close', function () {
        consentPromise = null;
        if (!accepted) window.rmTcbError = Object.assign(new Error('已取消云端操作，本机功能仍可使用。'), { code: 'CONSENT_REQUIRED', publicMessage: true });
        resolve(accepted);
      });
      box.showModal();
    });
    return consentPromise;
  };

  window.pintuRoomErrorText = function (error) {
    if (error && error.publicMessage && typeof error.message === 'string') return error.message;
    var parts = [];
    function read(value, depth) {
      if (depth > 3 || value == null) return;
      if (typeof value === 'string' || typeof value === 'number') { parts.push(String(value)); return; }
      ['code', 'errCode', 'message', 'errorMessage', 'errMsg', 'error', 'data'].forEach(function (key) { if (value[key] !== value) read(value[key], depth + 1); });
    }
    read(error, 0);
    var diagnostic = parts.join(' ');
    if (/RATE_LIMIT|QUOTA/i.test(diagnostic)) return '操作较频繁或已达到今日上限，请稍后再试。';
    if (/SYNC_TIMEOUT|timeout|超时/i.test(diagnostic)) return '连接超时，请检查网络后重试；已保存的本机记录不会丢失。';
    if (/INVALID_ENV|ENV_NOT_FOUND|env not found|INVALID_USER_DOMAIN|DOMAIN|INVALID_ORIGIN|-601034/i.test(diagnostic)) return '房间服务暂未就绪，请联系开发者。你仍可使用本机账本和转盘。';
    return '暂时无法连接房间，请稍后重试；持续失败可通过首页联系开发者。';
  };

  function backupTrip(trip) {
    if (!trip || !Array.isArray(trip.members) || !Array.isArray(trip.expenses) || trip.members.length > 500 || trip.expenses.length > 1000) throw new Error('账本格式或大小无效');
    var seen = new Set();
    var members = trip.members.map(function (m) {
      if (!m || !['string','number'].includes(typeof m.id)) throw new Error('成员数据无效');
      var id = String(m.id); var name = String(m.name || '').trim();
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || seen.has(id) || !name || name.length > 24) throw new Error('成员数据无效');
      seen.add(id); return { id: id, name: name, color: /^#[a-f0-9]{6}$/i.test(m.color || '') ? m.color : '#0F3D36' };
    });
    var expenses = trip.expenses.map(function (e, i) {
      if (!e || typeof e !== 'object') throw new Error('支出数据无效');
      var desc = String(e.desc || '').trim(), splits = Array.isArray(e.splitIds) ? e.splitIds.map(String) : [];
      if (!desc || desc.length > 100 || !Number.isSafeInteger(e.amountCents) || e.amountCents <= 0 || e.amountCents > 1e12 || !seen.has(String(e.payerId)) || !splits.length || new Set(splits).size !== splits.length || !splits.every(function (id) { return seen.has(id); })) throw new Error('支出数据无效');
      return { id: 'import-expense-' + i, desc: desc, amountCents: e.amountCents, payerId: String(e.payerId), splitIds: splits };
    });
    return { name: String(trip.name || '未命名账本').slice(0,60), members: members, expenses: expenses };
  }
  window.pintuBackupTrip = backupTrip;
  window.pintuOpenDataTools = function () {
    var box = dialog('备份与迁移', ['备份包含本机现有账本及已缓存的共享账本快照。尚未下载到本机的云端记录不在备份中。', '备份文件含成员名字和账目，请妥善保管。导入会新增独立本机账本，不会覆盖现有记录或恢复云端身份。换域名前，房主还应在房间内完成权限转交。']);
    var status = document.createElement('p'); status.setAttribute('role','status'); box.appendChild(status);
    button(box, '导出账本', function () {
      try {
        var trips = GL_TRIPS.filter(function (t) { return (t.members || []).length; }).map(backupTrip);
        if (!trips.length) { status.textContent = '暂无可备份的账本。'; return; }
        var blob = new Blob([JSON.stringify({ format: 'pintu-ledger-backup', version: 1, exportedAt: new Date().toISOString(), trips: trips }, null, 2)], { type:'application/json' });
        var url = URL.createObjectURL(blob), a = document.createElement('a'); a.href=url; a.download='pintu-ledgers-'+new Date().toISOString().slice(0,10)+'.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){ URL.revokeObjectURL(url); },1000);
        status.textContent = '已生成备份，请确认文件已保存。';
      } catch (_) { status.textContent = '备份失败，请检查账本内容后重试。'; }
    });
    var file = document.createElement('input'); file.type='file'; file.accept='.json,application/json'; file.setAttribute('aria-label','选择账本备份'); box.appendChild(file);
    button(box, '导入为本机账本', async function () {
      try {
        var selected=file.files[0]; if(!selected || selected.size > 5*1024*1024) throw new Error('请选择小于 5MB 的备份');
        var data=JSON.parse(await selected.text());
        if(data.format!=='pintu-ledger-backup'||data.version!==1||!Array.isArray(data.trips)||data.trips.length>100) throw new Error('不支持的备份格式');
        var nextId=glNextTripId, stamp=Date.now();
        var imported=data.trips.map(backupTrip).map(function(t){
          t.id=nextId++; t.nameUpdatedAt=stamp; t.memberTombstones={};t.expenseTombstones={};
          var idMap=new Map();t.members.forEach(function(m,i){idMap.set(m.id,i+1);m.id=i+1;m.createdAt=stamp;m.updatedAt=stamp;});
          t.expenses.forEach(function(e,i){e.id=i+1;e.payerId=idMap.get(e.payerId);e.splitIds=e.splitIds.map(function(id){return idMap.get(id);});e.createdAt=stamp;e.updatedAt=stamp;});
          t.nextMemberId=t.members.length+1;t.nextExpenseId=t.expenses.length+1;return t;
        });
        var combined=GL_TRIPS.concat(imported);localStorage.setItem(GL_LS_KEY,JSON.stringify({trips:combined,nextTripId:nextId}));
        GL_TRIPS=combined;glNextTripId=nextId;glRenderHomeTripList();status.textContent='已新增 '+imported.length+' 个本机账本，可在“行程”中查看。';
      } catch (_) { status.textContent='导入失败：备份格式不正确、文件过大或本机存储空间不足。现有账本未修改。'; }
    });
    button(box,'关闭',function(){box.close();});box.showModal();
  };

  window.pintuTransferOwner = async function () {
    var room=rmCurrentRoom(); if(!room)return;
    var box=dialog('房主管理',['网页身份与当前浏览器绑定。换设备或域名前，可先让自己的微信账号加入，再将房主权限交给它。转交后，原房主仍是普通成员，接收人可以解散房间。']);
    var status=document.createElement('p');status.setAttribute('role','status');box.appendChild(status);
    button(box,'关闭',function(){box.close();});box.showModal();
    try {
      var fresh=await rmRoomGateway('getRoom',{docId:room.docId});
      if(!fresh.room || fresh.room.ownerUid!==window.rmMyUid){status.textContent='只有当前房主可以转交权限。';return;}
      var candidates=(fresh.room.members||[]).filter(function(m){return m.uid && m.uid!==window.rmMyUid;});
      if(!candidates.length){status.textContent='请先让接收人加入房间，然后重新打开此窗口。';return;}
      var select=document.createElement('select');select.setAttribute('aria-label','接收房主权限的成员');
      candidates.forEach(function(m){var o=document.createElement('option');o.value=m.uid;o.textContent=m.name+(m.uid.indexOf('wx:')===0?'（微信）':'（网页）');select.appendChild(o);});box.appendChild(select);
      var send=button(box,'转交房主',async function(){
        var target=candidates.find(function(m){return m.uid===select.value;});
        if(!target||!confirm('确认将房主权限转交给“'+target.name+'”？对方将可以解散房间。'))return;
        send.disabled=true;
        try{
          var result=await rmRoomGateway('transferOwnership',{docId:room.docId,targetUid:target.uid,membershipEpoch:rmMembershipEpochForRoom(room)});
          rmUpsertLocalRoom(room.docId,result.room);rmRefreshTypedRoomUI(room.toolType);status.textContent='房主权限已转交。';select.disabled=true;
        }catch(e){status.textContent=pintuRoomErrorText(e);send.disabled=false;}
      });
    }catch(e){status.textContent=pintuRoomErrorText(e);}
  };
})();

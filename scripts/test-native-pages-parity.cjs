'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'../miniprogram-shell');
const ledgerKey='pintu-local-ledger-trips-v1';
function loadPage(name,options={}){
 let definition;const local=new Map(),scoped=new Map(),navigations=[],notices=[],modals=[],effects=[];let scopedCalls=0,scope=options.scope||'guest';
 const storage={localScopeToken:()=>scope,getLocal:(key,fallback)=>local.has(key)?structuredClone(local.get(key)):fallback,setLocal(key,value){if(options.storageFailure)return false;effects.push({scope,type:'local'});local.set(key,structuredClone(value));return true;},getScoped(key,fallback){scopedCalls++;return scoped.has(scope+':'+key)?scoped.get(scope+':'+key):fallback;},setScoped(key,value){scopedCalls++;effects.push({scope,type:'scoped'});scoped.set(scope+':'+key,value);return true;},removeScoped(key){effects.push({scope,type:'removeScoped'});return scoped.delete(scope+':'+key);},isAccountScoped:()=>scope!=='guest',getName:()=>'',saveName(){effects.push({scope,type:'name'});},save(){effects.push({scope,type:'roomCache'});},remove(){effects.push({scope,type:'roomRemove'});},cacheLedgerSnapshot(){effects.push({scope,type:'ledgerCache'});},getLedgerBackupCache:()=>[]};
 const wx={getSystemInfoSync:()=>({windowWidth:options.width||375,statusBarHeight:20}),showModal:value=>modals.push(value),showToast:value=>notices.push(value.title),navigateTo:value=>navigations.push(value.url),switchTab:value=>{navigations.push(value.url);if(value.success)value.success();},setNavigationBarTitle(){},openPrivacyContract(){}};
 const context={Page:value=>{definition=value;},wx,getApp:()=>({hasAccountConsent:()=>Boolean(options.consent),ensureAccountScope:async()=>({})}),setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},console,require(request){if(request==='../../utils/storage')return storage;if(request==='../../utils/layout')return{headerTopPx:()=>72,headerMetrics:()=>({statusBarPx:20,headerHeightPx:44,headerSidePx:96})};if(request==='../../services/roomGateway')return new Proxy(options.gateway||{}, {get(target,key){return target[key]||(()=>{throw Error('Unexpected cloud call: '+String(key));});}});return require(path.resolve(root,'pages',name,request));}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'pages',name,'index.js'),'utf8'),context);
 const page=Object.assign({},definition,{data:structuredClone(definition.data||{}),setData(patch,callback){Object.assign(this.data,patch);if(callback)callback();}});
 return {page,storage,local,scoped,effects,navigations,notices,modals,changeScope(value){scope=value;local.clear();},get scopedCalls(){return scopedCalls;}};
}

async function localLedgerAfterLogin(){
 const h=loadPage('ledger',{scope:'account-a',consent:true});await h.page.onLoad({tripId:'device-trip'});assert.equal(h.page.data.guestMode,false);assert.equal(h.page.docId,'');
 const ledger={name:'登录后的行程',members:[{id:1,name:'甲'},{id:2,name:'乙'}],expenses:[{id:1,desc:'车费',amountCents:101,payerId:1,splitIds:[1,2]}],nextMemberId:3,nextExpenseId:2};
 await h.page.syncLedger(ledger);assert.equal(h.local.get(ledgerKey).trips[0].ledger.expenses[0].amountCents,101);assert.equal(h.scopedCalls,0,'standalone edits never touch account-scoped storage');
 await h.page.onLoad({tripId:'device-trip'});assert.equal(h.page.data.ledger.name,'登录后的行程');assert.equal(h.page.data.ledger.expenses.length,1);assert.equal(h.page.data.step,2,'an account-scoped local trip can be reopened after login');
 h.changeScope('another-account');await assert.rejects(h.page.syncLedger(ledger),/账号范围/);assert.equal(h.local.size,0,'an old in-memory draft must not cross account namespaces');h.page.onShow();assert.equal(h.page.data.ledger.expenses.length,0);assert.equal(h.page.data.ledger.name,'');
 const broken=loadPage('ledger',{storageFailure:true,scope:'account-a',consent:true});await broken.page.onLoad({});await assert.rejects(broken.page.syncLedger(ledger),/保存/);assert.equal(broken.page.data.ledger.expenses.length,0,'failed storage must not be shown as saved');assert.match(broken.notices.join(' '),/未保存/);
}

async function localTripsWithoutLogin(){
 const h=loadPage('trips');h.local.set(ledgerKey,{trips:[{tripId:'trip-a',ledger:{name:'本机行程',members:[{id:1,name:'甲'}],expenses:[]}}]});h.page.onLoad();h.page.onShow();assert.equal(h.page.data.loginRequired,true);assert.equal(h.page.data.localTrips.length,1,'cloud login prompt must not hide device trips');
 await h.page.newLocal();await h.page.openLocal({currentTarget:{dataset:{id:'trip-a'}}});assert.ok(h.navigations.includes('/pages/home/index'));assert.equal(h.modals.length,1,'opening a guest ledger must offer login or backup');h.modals[0].success({confirm:false});assert.ok(h.navigations.includes('/pages/data-tools/index'),'the guest backup choice must open existing backup/import tooling');assert.ok(!h.navigations.some(url=>url.includes('trip-a')),'a guest ledger id must never enter the signed-in ledger route');assert.equal(h.scopedCalls,0);
 await h.page.deleteLocal({currentTarget:{dataset:{id:'trip-a'}}});h.changeScope('account-b');h.local.set(ledgerKey,{trips:[{tripId:'trip-a',ledger:{name:'另一个账号的账本',members:[],expenses:[]}}]});h.modals[1].success({confirm:true});assert.equal(h.local.get(ledgerKey).trips.length,1,'an old delete confirmation cannot delete from a new account namespace');
 const request=h.page.myRoomsRequestId;h.page.onShow();assert.ok(h.page.myRoomsRequestId>request,'signed-out rendering invalidates pending cloud-list responses');
}

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
async function tick(){for(let i=0;i<8;i++)await Promise.resolve();}
function prepareShared(h){Object.assign(h.page,{localScope:'account-a',scopeGeneration:0,scopeReady:true,docId:'room-a',tripId:'local-a',viewer:{uid:'wx:a',membershipEpoch:'epoch-a'}});h.page.data.room={name:'账号A房间',code:'ABCD2345'};}
async function staleSharedLedger(){
 const ledger={name:'账号A私有账目',members:[{id:1,name:'甲'}],expenses:[]};
 for(const action of ['create','join']){
  const h=loadPage('ledger',{scope:'account-a',consent:true,gateway:{[action]:async()=>({docId:'room-created',room:{name:'正常房间',code:'ABCD2345',ledger},viewer:{uid:'wx:a',isOwner:true,membershipEpoch:'epoch-a'}})}});prepareShared(h);h.page.docId='';h.page.data.name='测试甲';h.page.data.code='ABCD2345';h.page.guestMode=false;
  await h.page[action]();assert.equal(h.page.docId,'room-created');assert.equal(h.page.data.room.name,'正常房间');assert.equal(h.page.data.busy,false);assert.ok(h.effects.some(effect=>effect.type==='roomCache'),'current-account successful create/join must still populate the room cache');
 }
 for(const reject of [false,true]){
  const response=deferred();let calls=0;const h=loadPage('ledger',{scope:'account-a',gateway:{getRoom(){calls++;return response.promise;}}});prepareShared(h);
  const task=h.page.fetchRoom();h.changeScope('account-b');h.page.onShow();assert.equal(h.page.docId,'');assert.equal(h.page.viewer,null);assert.equal(h.page.scopeReady,false);assert.equal(h.page.data.room,null);h.page.startPolling();assert.equal(calls,1,'a stale shared poll cannot restart after switching account');
  if(reject)response.reject(Error('old A failure'));else response.resolve({room:{ledger},viewer:{uid:'wx:a'}});await task;
  assert.equal(h.effects.filter(effect=>effect.scope==='account-b').length,0,'late A polls must never cache or persist into B');assert.equal(h.page.data.ledger.name,'');assert.equal(h.notices.length,1,'the only notice after a stale failure is the account-scope switch guard');assert.match(String(h.notices[0]),/账号空间已切换/);
 }
 const response=deferred();const h=loadPage('ledger',{scope:'account-a',gateway:{syncLedger:()=>response.promise}});prepareShared(h);
 h.scoped.set('account-a:pintu-ledger-outbox-v1',{entries:{'room-a':{mutationId:'a-write',membershipEpoch:'epoch-a',ledger}}});
 const task=h.page.flushLedgerOutbox(true);await tick();h.changeScope('account-b');h.page.onShow();response.resolve({ledger});await task;
 assert.equal(h.effects.filter(effect=>effect.scope==='account-b').length,0,'late shared writes must not clear B outboxes, cache A ledgers, or save recovery copies in B');assert.equal(h.page.outboxFlushPromise,null);
 for(const action of ['create','join']){
  const response=deferred();const h=loadPage('ledger',{scope:'account-a',consent:true,gateway:{[action]:()=>response.promise}});prepareShared(h);h.page.docId='';h.page.data.name='测试甲';h.page.data.code='ABCD2345';h.page.guestMode=false;
  const task=h.page[action]();await tick();h.changeScope('account-b');h.page.onShow();response.resolve({docId:'room-a',room:{ledger},viewer:{uid:'wx:a'}});await task;
  assert.equal(h.page.docId,'');assert.equal(h.effects.filter(effect=>effect.scope==='account-b').length,0,'late room creation/join must not bind another account');
 }
 const exit=loadPage('ledger',{scope:'account-a',gateway:{leave(){throw Error('must not leave after scope change');}}});prepareShared(exit);exit.page.exitRoom();exit.changeScope('account-b');await exit.modals[0].success({confirm:true});assert.equal(exit.effects.length,0,'an old exit confirmation must have no effect in the new account');
 for(const method of ['renameMember','removeMember','deleteExpense']){
  const h=loadPage('ledger',{scope:'account-a'});prepareShared(h);h.page.data.ledger={name:'A',members:[{id:1,name:'甲'}],expenses:method==='deleteExpense'?[{id:1,desc:'A支出',amountCents:100,payerId:1,splitIds:[1]}]:[]};
  const pending=h.page[method]({currentTarget:{dataset:{id:1}}});h.changeScope('account-b');h.page.onShow();await h.modals[0].success({confirm:true,content:'旧确认'});if(pending)await pending;
  assert.equal(h.effects.filter(effect=>effect.scope==='account-b').length,0,'old editor confirmations must never modify the new account');
 }
}

async function staleTripsRecovery(){
 const ledger={name:'A待恢复账目',members:[],expenses:[{amountCents:100}]};
 for(const reject of [false,true]){
  const response=deferred();const h=loadPage('trips',{scope:'account-a',gateway:{getRoom:async()=>({room:{},viewer:{membershipEpoch:'epoch-a'}}),syncLedger:()=>response.promise}});h.page.onLoad();h.page.scopeReady=true;h.page.myRoomsRequestId=1;
  h.scoped.set('account-a:pintu-ledger-outbox-v1',{entries:{'room-a':{mutationId:'old-write',membershipEpoch:'epoch-a',ledger}}});
  const task=h.page.reconcileLedgerOutbox(1);await tick();h.changeScope('account-b');
  if(reject)response.reject(Object.assign(Error('stale'),{code:'STALE_MEMBERSHIP'}));else response.resolve({ledger});await task;
  assert.equal(h.effects.length,0,'late A recovery must not clear B outboxes or save A data in B');assert.equal(h.notices.length,0);
 }
 const response=deferred();const h=loadPage('trips',{scope:'account-a',gateway:{getRoom:()=>response.promise}});h.page.onLoad();h.page.scopeReady=true;h.page.myRoomsRequestId=1;h.page.data.rooms=[{docId:'room-a',room:{name:'A'}}];
 const task=h.page.roomAction({currentTarget:{dataset:{id:'room-a'}}});await tick();h.changeScope('account-b');response.resolve({room:{name:'A',ledger},viewer:{isOwner:true,membershipEpoch:'epoch-a'}});await task;assert.equal(h.modals.length,0,'late room read must not open A confirmation in B');assert.equal(h.effects.length,0);
 let leaves=0;const confirm=loadPage('trips',{scope:'account-a',gateway:{getRoom:async()=>({room:{name:'A',ledger},viewer:{isOwner:false,membershipEpoch:'epoch-a'}}),leave:async()=>{leaves++;}}});confirm.page.onLoad();confirm.page.scopeReady=true;confirm.page.myRoomsRequestId=1;confirm.page.data.rooms=[{docId:'room-a',room:{name:'A'}}];
 const leaving=confirm.page.roomAction({currentTarget:{dataset:{id:'room-a'}}});await tick();confirm.changeScope('account-b');confirm.modals[0].success({confirm:true});await leaving;assert.equal(leaves,0,'a previous-account exit dialog must not send a mutation under the next account');assert.equal(confirm.effects.length,0);
}

async function ownershipScopeIsolation(){
 const source=fs.readFileSync(path.join(root,'utils/ownership.js'),'utf8');
 for(const phase of ['read','confirm','write']){
  let scope='a',changed=false,writesAfterChange=0,transfers=0,applies=0;const response=deferred();const latest={room:{members:[{uid:'wx:owner',name:'房主'},{uid:'wx:target',name:'目标'}]},viewer:{uid:'wx:owner',isOwner:true,membershipEpoch:'epoch-a'}};
  const gateway={getRoom:()=>phase==='read'?response.promise:Promise.resolve(latest),transferOwnership:()=>{transfers++;return phase==='write'?response.promise:Promise.resolve({room:{},viewer:{}});}};
  const box={module:{exports:{}},require:request=>request==='./storage'?{localScopeToken:()=>scope}:gateway,wx:{showActionSheet:async()=>({tapIndex:0}),showModal:()=>phase==='confirm'?response.promise:Promise.resolve({confirm:true}),showToast(){if(changed)writesAfterChange++;}}};
  vm.runInNewContext(source,box);const page={data:{busy:false},docId:'room-a',scopeGeneration:0,setData(patch){if(changed)writesAfterChange++;Object.assign(this.data,patch);},applyRoom(){applies++;}};
  const task=box.module.exports(page);await tick();changed=true;scope='b';page.docId='room-b';response.resolve(phase==='read'?latest:phase==='confirm'?{confirm:true}:{room:{},viewer:{}});await task;
  assert.equal(applies,0);assert.equal(writesAfterChange,0,'late ownership responses must not change the new account UI');assert.equal(transfers,phase==='write'?1:0,'scope changes before confirmation must prevent the transfer; already-sent requests are only ignored on return');
 }
}

function navigationAndDocuments(){
 const h=loadPage('home');h.page.openPrivacyNotice();h.page.openServiceAgreement();h.page.openDataTools();assert.deepEqual(h.navigations,['/pages/agreement/index?type=privacy','/pages/agreement/index?type=terms','/pages/data-tools/index']);assert.equal(typeof h.page.openPrivacy,'function','native privacy-contract action remains separate');
 const markup=fs.readFileSync(path.join(root,'pages/home/index.wxml'),'utf8');const labels=['隐私说明','用户协议','联系开发者','备份与迁移'];assert.ok(labels.every((label,i)=>markup.indexOf(label)>=0&&(i===0||markup.indexOf(label)>markup.indexOf(labels[i-1]))));
 const docs=loadPage('agreement');docs.page.onLoad({type:'privacy'});assert.equal(docs.page.data.privacy,true);assert.match(docs.page.data.sections.map(s=>s.text).join(' '),/OpenID/);docs.page.onLoad({type:'terms'});assert.equal(docs.page.data.privacy,false);assert.match(fs.readFileSync(path.join(root,'pages/agreement/index.wxml'),'utf8'),/2026 年 10 月 22 日/);
 const css=fs.readFileSync(path.join(root,'app.wxss'),'utf8');assert.match(css,/max-width:480px/);assert.match(css,/IBM Plex Sans SC/);assert.doesNotMatch(css,/@import|https?:\/\//);
 const ledgerMarkup=fs.readFileSync(path.join(root,'pages/ledger/index.wxml'),'utf8');assert.match(ledgerMarkup,/expense-editor-backdrop[\s\S]*?bindtap="cancelEdit"/);assert.match(ledgerMarkup,/expense-editor-sheet/);
}

function wheelSizing(){
 for(const [width,expected] of [[240,200],[320,280],[375,280],[1024,280]]){const h=loadPage('spinner',{width});h.page.onLoad();assert.equal(h.page.data.canvasSize,expected,'canvas matches the bounded CSS-pixel wheel');}
 const markup=fs.readFileSync(path.join(root,'pages/spinner/index.wxml'),'utf8');assert.match(markup,/wheel-rotor" style="width:\{\{canvasSize\}\}px;height:\{\{canvasSize\}\}px;" animation=/);assert.match(markup,/canvasSize \/ 2 \+ 10/);
}

(async()=>{await localLedgerAfterLogin();await localTripsWithoutLogin();await staleSharedLedger();await staleTripsRecovery();await ownershipScopeIsolation();navigationAndDocuments();wheelSizing();console.log('Native page parity checks passed: signed-in local ledger persistence, guest backup gate, create/join success, cross-account cloud/ownership isolation, local trips, legal/data navigation, editor sheet, and bounded wheel geometry.');})().catch(error=>{console.error(error);process.exitCode=1;});

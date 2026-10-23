'use strict';
// Offline behavioral checks. No SDK/network or live user data is accessed.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function functionsBetween(start,end,context){vm.createContext(context);vm.runInContext(html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start))),context);return context;}
function plain(value){return JSON.parse(JSON.stringify(value));}

function ledgerMerge(){
 const c=functionsBetween('function glClone(value){','function glLedgerContentSignature(',{window:{}});
 const common={name:'旅行',nameUpdatedAt:1,members:[{id:'a',name:'甲',updatedAt:1}],expenses:[]};
 const a={...common,expenses:[{id:'x',desc:'午饭',updatedAt:10},{id:'local',desc:'车费',updatedAt:11}]};
 const b={...common,expenses:[{id:'x',desc:'晚饭',updatedAt:12},{id:'remote',desc:'住宿',updatedAt:11}]};
 const merged=c.glMergeLedgers(a,b);
 assert.deepEqual(plain(merged.expenses.map(e=>e.id).sort()),['local','remote','x']);
 assert.equal(merged.expenses.find(e=>e.id==='x').desc,'晚饭');
 const deleted=c.glMergeLedgers(a,{...b,expenseTombstones:{x:{deletedAt:12}}});
 assert.equal(deleted.expenses.some(e=>e.id==='x'),false,'a deletion must survive a stale-device merge');
 assert.equal(c.glMergeLedgers(deleted,a).expenses.some(e=>e.id==='x'),false,'merging a stale device again must not resurrect deleted data');
 assert.equal(JSON.stringify(c.glPickNewerItem({id:'x',name:'A',updatedAt:12},{id:'x',name:'B',updatedAt:12})),JSON.stringify(c.glPickNewerItem({id:'x',name:'B',updatedAt:12},{id:'x',name:'A',updatedAt:12})),'same-millisecond edits converge regardless of input order');
 assert.equal(a.expenses[0].desc,'午饭','merge must not mutate caller data');
}

function ledgerPersistence(){
 let stored,fail=false,queued=0;const notices=[];
 const c=functionsBetween('function glPersistTrips(){','function glFindTripByRoom(',{
  GL_LS_KEY:'offline-ledger',GL_TRIPS:[{id:5,name:'本机行程',members:[],expenses:[]}],glNextTripId:6,glHydrating:false,rmDb:{},
  localStorage:{setItem(key,value){if(fail)throw Error('quota');stored=value;},getItem(){return stored;}},
  glCurrentTrip(){return c.GL_TRIPS[0];},glQueueCloudSync(){queued++;},glSetSyncBadge(){},showAppToast(message){notices.push(message);}
 });
 assert.equal(c.glSave(),true);assert.equal(queued,0);c.GL_TRIPS=[];c.glNextTripId=1;c.glLoad();assert.equal(c.GL_TRIPS[0].name,'本机行程');assert.equal(c.glNextTripId,6);
 c.GL_TRIPS[0].roomDocId='test-room';assert.equal(c.glSave(),true);assert.equal(queued,1);
 fail=true;assert.equal(c.glSave(),false);assert.equal(queued,1,'failed local persistence must not upload a change reported as saved');assert.ok(notices.length);
 delete c.GL_TRIPS[0].roomDocId;notices.length=0;assert.equal(c.glSave(),false);assert.match(notices.join(' '),/未保存/,'standalone storage failures also need an explicit warning');
 stored='{invalid';assert.doesNotThrow(()=>c.glLoad());
}

async function mapFailures(){
 let timerId=0,geocodeCallback,nearbyCallback;const timers=new Map();
 const AMap={plugin(name,callback){callback();},Geocoder:function(){this.getLocation=(address,callback)=>{geocodeCallback=callback;};},PlaceSearch:function(){this.searchNearBy=(text,point,radius,callback)=>{nearbyCallback=callback;};}};
 const c={window:{AMap},AMap,getCurrentSearchCityName:()=>'',setTimeout(callback,delay){const id=++timerId;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id)};
 functionsBetween('function pintuMapRequest(start) {','/* —— 核心计算主流程 —— */',c);
 let lateResolve,completed=false;
 const timeout=c.pintuMapRequest(resolve=>{lateResolve=resolve;}).then(()=>{completed=true;},error=>{assert.match(error.message,/超时/);});
 for(const [id,timer] of [...timers]){assert.equal(timer.delay,10000);timers.delete(id);timer.callback();}await timeout;lateResolve('late');await Promise.resolve();assert.equal(completed,false,'a late SDK response must not revive a timed-out request');
 const missing=c.window.AMap;delete c.window.AMap;await assert.rejects(c.getCoordinates('地点'),/地图服务/);c.window.AMap=missing;
 let request=c.getCoordinates('地点');geocodeCallback('no_data',{});assert.equal(await request,null);
 request=c.getCoordinates('地点');geocodeCallback('error',{info:'SERVICE_ERROR'});await assert.rejects(request,/失败/);
 request=c.getCoordinates('地点');geocodeCallback('complete',{geocodes:[{location:{lat:31,lng:121}}]});assert.deepEqual(plain(await request),{lat:31,lng:121});
 request=c.fetchPOIs(31,121,'餐厅',1000,20);nearbyCallback('no_data',{});assert.deepEqual(plain(await request),[]);
 request=c.fetchPOIs(31,121,'餐厅',1000,20);nearbyCallback('error',{info:'SERVICE_ERROR'});await assert.rejects(request,/失败/,'an upstream failure must not appear as an empty search result');
 request=c.fetchPOIs(31,121,'餐厅',1000,20);nearbyCallback('complete',{info:'OK',poiList:{pois:[{id:'poi'}]}});assert.equal((await request)[0].id,'poi');assert.equal(timers.size,0);
}

async function pointSaveLifecycle(){
 const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
 function harness(){
  let resolve,reject;const writes=[],notices=[];const input={value:'测试地址',dataset:{},focus(){}},name={value:'测试甲',focus(){}};
  const c={mpRoomRef:{docId:'room-a',epoch:1,meetup:{people:[]}},mpRoomMode:true,mpPointSaveGeneration:0,window:{rmMyUid:'me'},LOC_COLORS:['green'],localStorage:{setItem(){}},setTimeout(){},
   document:{getElementById:id=>({mpMineName:name,mpMineInput:input,viewMidpoint:{classList:{contains:()=>true}},mpMineSet:{}}[id])},
   rmMembershipEpochForRoom:room=>room.epoch,getCoordinates:()=>new Promise((a,b)=>{resolve=a;reject=b;}),mpRoomWrite:(room,people)=>writes.push({room,people}),mpSetMineEditing(){},showAppToast:message=>notices.push(message),alert:message=>notices.push(message)};
  functionsBetween('function mpSetMyPoint(){','function mpRemoveMyPoint(',c);
  return {c,input,name,writes,notices,resolve:()=>resolve({lat:31,lng:121}),reject:()=>reject(Error('timeout'))};
 }
 let h=harness();h.c.mpSetMyPoint();h.reject();await settle();assert.equal(h.writes.length,0);assert.equal(h.input.value,'测试地址');assert.match(h.notices.join(' '),/失败|超时/);
 for(const change of [h=>{h.input.value='新地址';},h=>{h.name.value='新名字';},h=>{h.c.mpRoomRef={docId:'room-b',epoch:1};},h=>{h.c.mpRoomRef.epoch=2;},h=>{h.c.mpRoomMode=false;}]){
  h=harness();h.c.mpSetMyPoint();change(h);h.resolve();await settle();assert.equal(h.writes.length,0,'stale point lookup must never commit after address/name/room/epoch changes');assert.equal(h.notices.length,0);
 }
 h=harness();h.c.mpSetMyPoint();h.c.mpRoomRef={docId:'room-a',epoch:1,meetup:{people:[{uid:'other',name:'乙'}]}};h.resolve();await settle();assert.equal(h.writes.length,1);assert.equal(h.writes[0].people.length,2,'a refreshed snapshot for the same room is retained when saving');assert.equal(h.writes[0].room,h.c.mpRoomRef);
}

function perExpenseRounding(){
 const c=functionsBetween('function glComputeSettlement(trip){','function glRenderSettlement(',{glClone:value=>JSON.parse(JSON.stringify(value))});
 const trip={members:[{id:'a'},{id:'b'}],expenses:[1001,2,3].map(amountCents=>({amountCents,payerId:'a',splitIds:['a','b']}))};
 const result=c.glComputeSettlement(trip);assert.equal(result.balance.a,502);assert.equal(result.balance.b,-502);assert.equal(result.transfers[0].amountCents,502,'each expense assigns its remainder independently, so total/2 is not the settlement rule');
}

async function categoryFailureRetry(){
 let fail=true,categoryCalls=0;const elements=[];
 function element(){const n={style:{},children:[],appendChild(child){this.children.push(child);},addEventListener(name,callback){this[name]=callback;},firstElementChild:{tag:'navigation'}};Object.defineProperty(n,'innerHTML',{set(value){this.html=value;this.children=[];},get(){return this.html;}});elements.push(n);return n;}
 const c={setTimeout(callback){callback();},fetchFirstPageForHighlights(){categoryCalls++;return fail?Promise.reject(Error('category timeout')):Promise.resolve({pois:[],total:0});},mapHlPoi(){},fetchPoiFullDetail:async()=>({}),document:{createElement:element},buildPlatformLinksHtml:()=>'<a>导航</a>',buildPoiDetailHtml:()=>'<p>基本资料</p>',buildHighlightsEl:()=>({tag:'highlights'})};
 functionsBetween('function fetchCategoryHighlights(poi){','/* ---------- 二次展开',c);
 vm.runInContext(html.slice(html.indexOf('function renderPoiFullBack(poi, targetEl){'),html.indexOf('/* ---------- 覆盖：滑卡渲染')),c);
 const poi={isMall:true,name:'商场',lat:31,lng:121};await assert.rejects(c.fetchCategoryHighlights(poi),/timeout/);assert.equal(poi._highlightsCache,undefined,'a failed category must not poison the cache with an empty result');
 const target=element();c.renderPoiFullBack(poi,target);for(let i=0;i<10;i++)await Promise.resolve();
 const retry=target.children.find(n=>n.textContent==='重新加载');assert.ok(retry,'category failures must reach the visible retry control');const before=categoryCalls;
 fail=false;retry.click();for(let i=0;i<10;i++)await Promise.resolve();assert.ok(categoryCalls>before,'retry must perform fresh category requests');assert.equal(poi._highlightsCache.length,4);assert.equal(target.children.some(n=>n.textContent==='重新加载'),false,'successful retry replaces the failure UI');
}

function sharedToLocalLedger(){
 const local={id:7,name:'独立本机',members:[],expenses:[]},shared={id:8,roomDocId:'room-shared',members:[],expenses:[]};
 const rooms=[{docId:'room-shared',ownerUid:'me'}];let stops=0,queued=0,refreshes=0;const roomSnapshot=JSON.stringify(rooms);
 const c={window:{openGroupLedgerTrip(id){c.glCurrentTripId=id;}},GL_TRIPS:[local,shared],ROOMS:rooms,rmMyUid:'me',rmCurrentRoomId:'room-shared',rmReturnToRoom:true,glCurrentTripId:8,
  stopTypedSync(){stops++;},rmRefreshTypedRoomUI(type){assert.equal(type,'ledger');refreshes++;assert.equal(c.rmCurrentRoomId,null,'old room controls must refresh against an empty active-room pointer');},
  GL_LS_KEY:'offline-switch',glNextTripId:9,glHydrating:false,rmDb:{},localStorage:{setItem(){}},glCurrentTrip:()=>c.GL_TRIPS.find(t=>t.id===c.glCurrentTripId),glQueueCloudSync(){queued++;},glSetSyncBadge(){},showAppToast(){}
 };
 const start=html.indexOf('  var originalOpenGroupLedgerTrip = window.openGroupLedgerTrip;');
 vm.createContext(c);vm.runInContext(html.slice(start,html.indexOf('  /* 新式独立房间的返回键',start)),c);
 vm.runInContext(html.slice(html.indexOf('function glPersistTrips(){'),html.indexOf('function glFindTripByRoom(')),c);
 c.window.openGroupLedgerTrip(7);assert.equal(stops,1);assert.equal(refreshes,1);assert.equal(c.rmReturnToRoom,false);assert.equal(c.glCurrentTripId,7);assert.equal(local.roomDocId,undefined);assert.equal(shared.roomDocId,'room-shared');assert.equal(c.rmMyUid,'me');assert.equal(JSON.stringify(c.ROOMS),roomSnapshot,'switching local does not leave or delete the shared room');assert.equal(c.glSave(),true);assert.equal(queued,0,'saving the opened local trip must not touch the previous shared room');
}

function spinnerLifecycle(){
 let frameId=0,homeCalls=0;const frames=new Map(),notices=[];
 const node=()=>({style:{},classList:{add(){},remove(){}},setAttribute(){},innerHTML:'',textContent:''});
 const wrap=node(),canvas={...node(),closest:()=>wrap},button=node(),result=node();
 const ids={viewSpinner:node(),spinCanvas:canvas,spinGoBtn:button,spinResult:result,spinDecision:{value:'谁买单'}};
 let randomValues=[];const math=Object.create(Math);math.random=()=>randomValues.shift()??0;
 const c={spinnerBusy:false,spinnerNames:['甲','乙','丙'],spinnerAngle:0,spinnerRaf:null,Math:math,
  document:{getElementById:id=>ids[id]},window:{scrollTo(){}},hideAllViews(){},spinnerRenderNames(){},spinnerDrawWheel(){},showAppToast:message=>notices.push(message),appEscapeHtml:text=>String(text),
  requestAnimationFrame(callback){const id=++frameId;frames.set(id,callback);return id;},cancelAnimationFrame:id=>frames.delete(id),goHome(){homeCalls++;}
 };
 functionsBetween('function spinnerSpin(){','/* 绑定加名字的输入与按钮 */',c);
 vm.runInContext(html.slice(html.indexOf('function spinnerResetBusyState(){'),html.indexOf('function spinnerGoBack(){')),c);
 vm.runInContext(html.slice(html.indexOf('function spinnerGoBack(){'),html.indexOf('/* 渲染"在场的人"列表')),c);
 function finish(){for(const time of [1,10001]){const callbacks=[...frames.values()];frames.clear();callbacks.forEach(cb=>cb(time));}}
 for(const winner of [1,2,0]){
  randomValues=[(winner+.1)/3,0,0];c.spinnerSpin();assert.equal(button.disabled,true);const before=frames.size;c.spinnerSpin();assert.equal(frames.size,before,'a running wheel cannot start another animation');finish();
  assert.equal(c.spinnerBusy,false);assert.equal(button.disabled,false);assert.match(result.innerHTML,new RegExp(c.spinnerNames[winner]));
  const pointer=((270-c.spinnerAngle)%360+360)%360;assert.equal(Math.floor(pointer/120),winner,'the final pointer must identify the announced winner on repeated spins');
 }
 c.spinnerNames=['甲'];c.spinnerSpin();assert.ok(notices.length);assert.equal(frames.size,0);
 c.spinnerNames=['甲','乙'];c.spinnerSpin();assert.equal(frames.size,1);c.spinnerGoBack();assert.equal(frames.size,0);assert.equal(c.spinnerBusy,false);assert.equal(homeCalls,1);
 assert.equal(button.disabled,false,'leaving mid-spin must restore the button for the next visit');assert.equal(button.textContent,'转');
 c.openSpinner(false);assert.equal(c.spinnerNames.length,0);assert.equal(button.disabled,false);c.spinnerNames=['新甲','新乙'];c.spinnerSpin();finish();assert.equal(c.spinnerBusy,false);assert.equal(button.disabled,false,'the reopened wheel remains usable');
}

async function backupImport(){
 const nodes=[];let stored,exportBlob,fail=false,renders=0;
 function element(tag){const n={tag,children:[],appendChild(child){this.children.push(child);},setAttribute(){},addEventListener(){},showModal(){},close(){},remove(){},click(){if(this.onclick)return this.onclick();}};nodes.push(n);return n;}
 const existing={id:3,name:'保留行程',members:[{id:1,name:'原成员'}],expenses:[]};
 const c={window:{},Blob,URL:{createObjectURL(blob){exportBlob=blob;return 'blob:offline-test';},revokeObjectURL(){}},setTimeout(){},document:{createElement:element,body:{appendChild(){}}},GL_TRIPS:[existing],glNextTripId:4,GL_LS_KEY:'offline-backup',localStorage:{setItem(key,value){if(fail)throw Error('quota');stored=value;}},glRenderHomeTripList(){renders++;},console};
 vm.runInNewContext(fs.readFileSync(path.join(root,'launch-support.js'),'utf8'),c);
 c.window.pintuOpenDataTools();const file=nodes.find(n=>n.tag==='input'),importButton=nodes.find(n=>n.textContent==='导入为本机账本');
 const data={format:'pintu-ledger-backup',version:1,trips:[{name:'导入行程',ownerUid:'private',roomDocId:'private-room',members:[{id:'a',name:'甲'},{id:'b',name:'乙'}],expenses:[{desc:'晚饭',amountCents:101,payerId:'a',splitIds:['a','b']}]}]};
 file.files=[{size:100,text:async()=>JSON.stringify(data)}];
 fail=true;await importButton.onclick();assert.equal(c.GL_TRIPS.length,1);assert.equal(c.glNextTripId,4);assert.equal(renders,0,'failed persistence must leave memory and UI untouched');
 fail=false;await importButton.onclick();assert.equal(c.GL_TRIPS.length,2);assert.equal(c.GL_TRIPS[0],existing);const imported=c.GL_TRIPS[1];assert.equal(imported.id,4);assert.equal(c.glNextTripId,5);
 assert.equal(imported.roomDocId,undefined);assert.equal(imported.ownerUid,undefined);assert.equal(imported.expenses[0].payerId,1);assert.deepEqual(plain(imported.expenses[0].splitIds),[1,2]);assert.equal(JSON.parse(stored).trips.length,2);assert.equal(renders,1);
 imported.roomDocId='cloud-snapshot';imported.ownerUid='private-owner';await nodes.find(n=>n.textContent==='导出账本').onclick();
 const exported=JSON.parse(await exportBlob.text());assert.equal(exported.format,'pintu-ledger-backup');assert.equal(exported.version,1);assert.equal(exported.trips.length,2);assert.equal(exported.trips[1].roomDocId,undefined);assert.equal(exported.trips[1].ownerUid,undefined);
 data.trips[0].expenses[0].payerId='unknown';await importButton.onclick();assert.equal(c.GL_TRIPS.length,2,'invalid references must not partially import');
}

(async()=>{ledgerMerge();ledgerPersistence();spinnerLifecycle();await backupImport();await mapFailures();await pointSaveLifecycle();perExpenseRounding();await categoryFailureRetry();sharedToLocalLedger();console.log('Full audit offline behavior checks passed: ledger merging/persistence/rounding, wheel cancellation/re-entry, atomic backup import/export, map errors/timeouts/retry, stale point saves, and shared-to-local ledger isolation.');})().catch(error=>{console.error(error);process.exitCode=1;});

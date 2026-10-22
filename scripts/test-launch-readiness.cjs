'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const support = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'launch-support.js'), 'utf8'), support);
support.window.PINTU_CONFIG={collaborationOrigin:'https://shared.example'};
support.window.location={origin:'https://shared.example',search:'',hash:''};
assert.equal(support.window.pintuCheckCloudOrigin(),true);
const entryNodes=[];
support.URL=URL;
support.document={body:{appendChild(){}},createTextNode:text=>({text}),createElement(tag){const node={tag,appendChild(){},addEventListener(){},showModal(){},close(){}};entryNodes.push(node);return node;}};
support.window.location={origin:'https://tools.example',search:'?room=ABCDEFGH',hash:'#join'};
assert.equal(support.window.pintuCheckCloudOrigin(),false);
assert.equal(entryNodes.find(node=>node.tag==='a').href,'https://shared.example/?room=ABCDEFGH#join');
assert.equal(support.window.rmTcbError.publicMessage,true);
const validate = support.window.pintuBackupTrip;
const trip = { name: '迁移账本', members: [{id:'a',name:'A'}, {id:'b',name:'B'}, {id:'c',name:'C'}], expenses: [{desc:'晚饭',amountCents:1001,payerId:'a',splitIds:['a','b','c']}] };
const backup = validate({...trip, ownerUid:'private-owner', roomDocId:'private-room'});
assert.equal(backup.expenses[0].amountCents, 1001);
assert.equal(backup.ownerUid, undefined);
assert.equal(backup.roomDocId, undefined);
for (const invalid of [
  {...trip, members:[{name:'A'}]},
  {...trip, members:[null]},
  {...trip, members:[{id:'__proto__',name:'A'}]},
  {...trip, members:[{id:'a',name:'A'},{id:'a',name:'B'}]},
  {...trip, expenses:[null]},
  {...trip, expenses:[{...trip.expenses[0],amountCents:1.1}]},
  {...trip, expenses:[{...trip.expenses[0],payerId:'unknown'}]},
  {...trip, expenses:[{...trip.expenses[0],splitIds:['a','a']}]},
  {...trip, expenses:[{...trip.expenses[0],splitIds:['unknown']}]}
]) assert.throws(()=>validate(invalid));
assert.match(support.window.pintuRoomErrorText({error:{message:'env not found'}}), /暂未就绪/);
assert.match(support.window.pintuRoomErrorText({error:{errCode:'RATE_LIMITED'}}), /上限/);
assert.doesNotMatch(support.window.pintuRoomErrorText({}), /\[object Object\]/);
assert.equal(support.window.pintuCloudConsentGranted, false);
assert.doesNotMatch(html, /securityJsCode\s*:/, 'no browser-bundled security secret');
assert.match(html, /!window\.pintuCloudConsentGranted \|\| !rmGetMyRoomIds/, 'history refresh must not establish identity before consent');

const settlement = { glClone: value=>JSON.parse(JSON.stringify(value)) };
vm.createContext(settlement);
vm.runInContext(html.slice(html.indexOf('function glComputeSettlement(trip){'),html.indexOf('function glRenderSettlement(')),settlement);
const native = require('../miniprogram-shell/utils/ledger');
const example = settlement.glComputeSettlement(trip);
assert.equal(example.transfers.length,2);
assert.ok(example.transfers.every(t=>t.to==='a' && t.amountCents <= 334),'debtors pay only what they owe');
let seed=1792680480;
function rand(max){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max;}
for(let k=0;k<200;k++){
  const members=Array.from({length:2+rand(10)},(_,i)=>({id:String(i),name:String(i)}));
  const expenses=Array.from({length:1+rand(20)},()=>({amountCents:1+rand(100001),payerId:String(rand(members.length)),splitIds:members.filter(()=>rand(3)!==0).map(m=>m.id)}));
  expenses.forEach(e=>{if(!e.splitIds.length)e.splitIds=['0'];});
  const ledger={members,expenses}, web=settlement.glComputeSettlement(ledger), mini=native.settlementPlan(ledger);
  assert.equal(JSON.stringify(web.balance),JSON.stringify(Object.fromEntries(native.balances(ledger).map(x=>[x.id,x.cents]))));
  const remaining={...web.balance};
  for(const t of web.transfers){
    assert.ok(Number.isSafeInteger(t.amountCents)&&t.amountCents>0);
    assert.ok(remaining[t.from]<0&&remaining[t.to]>0);
    assert.ok(t.amountCents<=-remaining[t.from]&&t.amountCents<=remaining[t.to]);
    remaining[t.from]+=t.amountCents;remaining[t.to]-=t.amountCents;
  }
  assert.ok(Object.values(remaining).every(x=>x===0));
  assert.equal(web.transfers.length,mini.rows.length);
}

async function main(){
  const quota=require('../cloudfunctions/roomGateway/quota');
  assert.equal(fs.readFileSync(path.join(root,'cloudfunctions/roomGateway/quota.js'),'utf8'),fs.readFileSync(path.join(root,'cloudfunctions/mapGateway/quota.js'),'utf8'));
  const rows=new Map(), tx={collection(){return{doc(id){return{get:async()=>({data:rows.get(id)}),set:async value=>{rows.set(id,value);return{};}}}}}};
  const rules=[{key:'caller',windowMs:1000,limit:2},{key:'global',windowMs:1000,limit:1}];
  assert.equal(await quota.consume(tx,rules,100),true);
  const before=JSON.stringify([...rows]);
  assert.equal(await quota.consume(tx,rules,200),false);
  assert.equal(JSON.stringify([...rows]),before,'rejected multi-counter check must not consume tokens');
  assert.equal(await quota.consume(tx,rules,1100),true,'windows reset without a process restart');

  let cleanupQueries=[], cleanupReads=0;
  const cleanupDb={command:{lt:value=>({before:value}),in:value=>({ids:value})},collection(name){
    assert.equal(name,'request_limits');
    return{where(query){cleanupQueries.push(query);return{
      limit(value){assert.equal(value,100);return this;},
      async get(){return{data:cleanupReads++===0?[{_id:'expired'}]:[]};},
      async remove(){return{deleted:1};}
    };}};
  }};
  const cleanupBox={exports:{},require(){return{SYMBOL_CURRENT_ENV:'current',init(){return{database:()=>cleanupDb};}};},Date};
  vm.runInNewContext(fs.readFileSync(path.join(root,'cloudfunctions/quotaCleanup/index.js'),'utf8'),cleanupBox);
  assert.equal((await cleanupBox.exports.main()).deleted,1);
  assert.equal(cleanupQueries[1]._id.ids[0],'expired');
  assert.equal(cleanupQueries[1].expiresAt.before,cleanupQueries[0].expiresAt.before,'cleanup must recheck expiry to preserve renewed counters');
  const functionRules=JSON.parse(fs.readFileSync(path.join(root,'cloudbase-function-security-rules.json'),'utf8'));
  assert.equal(functionRules['*'].invoke,false);
  assert.equal(functionRules.quotaCleanup,undefined,'cleanup must not be callable by clients');

  const proxy=require('../api/amap');
  const saved={...process.env}, originalFetch=global.fetch;
  process.env.AMAP_JS_API_KEY='a'.repeat(32);process.env.AMAP_SECURITY_JS_CODE='b'.repeat(32);
  process.env.PINTU_ALLOWED_ORIGINS='https://pintu.example';
  let upstream;
  global.fetch=async(url,options)=>{upstream={url,options};return new Response('{"status":"1"}',{headers:{'content-type':'application/json'}});};
  async function request(overrides={}){
    const req={method:'GET',url:'/api/amap?path=v3/place/text&keywords=coffee',headers:{origin:'https://pintu.example'},...overrides};
    const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;},send(v){this.body=v;return this;}};
    await proxy(req,res);return res;
  }
  try{
    assert.equal((await request()).statusCode,200);
    const url=new URL(upstream.url);
    assert.equal(url.hostname,'restapi.amap.com');assert.equal(url.searchParams.get('jscode'),'b'.repeat(32));
    assert.equal(upstream.options.redirect,'error');
    assert.equal(upstream.options.headers.Referer,'https://pintu.example/');
    assert.equal((await request({headers:{origin:'https://evil.example'}})).statusCode,403);
    assert.equal((await request({headers:{}})).statusCode,403);
    assert.equal((await request({method:'POST'})).statusCode,405);
    assert.equal((await request({url:'/api/amap?path=https://evil.example'})).statusCode,404);
    await request({url:'/_AMapService/v4/map/styles?key=attacker&jscode=attacker'});
    assert.equal(new URL(upstream.url).hostname,'webapi.amap.com');
    assert.equal(new URL(upstream.url).searchParams.get('key'),'a'.repeat(32));
    await request({url:'/api/amap?keywords=coffee',query:{path:'v3/place/text'}});
    assert.equal(new URL(upstream.url).pathname,'/v3/place/text');
    global.fetch=async()=>new Response('jsonp_test_({"status":"1","tips":[],"sec_code":"diagnostic","sec_code_debug":"debug"})',{headers:{'content-type':'application/json;charset=UTF-8'}});
    const jsonp=await request({url:'/_AMapService/v3/assistant/inputtips?callback=jsonp_test_'});
    assert.equal(jsonp.statusCode,200);assert.match(jsonp.headers['Content-Type'],/^application\/javascript/);
    assert.equal(jsonp.headers['X-Content-Type-Options'],'nosniff');
    assert.equal(jsonp.body.toString(),'jsonp_test_({"status":"1","tips":[]});');
    assert.equal((await request({url:'/_AMapService/v3/assistant/inputtips?callback=alert(1)'})).statusCode,400);
    assert.equal((await request({url:'/_AMapService/v3/assistant/inputtips?callback=another'})).statusCode,502);
    global.fetch=async()=>new Response('jsonp_test_({});alert(1);jsonp_test_({})',{headers:{'content-type':'application/json'}});
    assert.equal((await request({url:'/_AMapService/v3/assistant/inputtips?callback=jsonp_test_'})).statusCode,502);
    global.fetch=async()=>new Response('b'.repeat(32),{headers:{'content-type':'application/json'}});
    assert.equal((await request()).statusCode,502,'upstream must not echo the security secret');
    global.fetch=async()=>new Response('<html>error</html>',{headers:{'content-type':'text/html'}});
    assert.equal((await request()).statusCode,502);
    global.fetch=async()=>{throw new Error('private upstream details');};
    assert.equal((await request()).body.info,'MAP_UNAVAILABLE');
    delete process.env.AMAP_SECURITY_JS_CODE;
    assert.equal((await request()).statusCode,503);
  }finally{global.fetch=originalFetch;for(const key of ['AMAP_JS_API_KEY','AMAP_SECURITY_JS_CODE','PINTU_ALLOWED_ORIGINS']){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}

  // Execute the release generator against isolated fixtures, never the checkout.
  const parent=path.resolve(root,'..'), temp=fs.mkdtempSync(path.join(parent,'pintu-release-test-'));
  try{
    fs.mkdirSync(path.join(temp,'miniprogram-shell'));
    for(const name of ['cloudbaserc.json','index.html','launch-support.js','privacy.html','terms.html','legal.css'])fs.copyFileSync(path.join(root,name),path.join(temp,name));
    fs.writeFileSync(path.join(temp,'midpoint.css'),'/* midpoint style fixture */');
    fs.writeFileSync(path.join(temp,'midpoint-ui.js'),'// midpoint interaction fixture');
    require('./prepare-release.cjs').prepare({CLOUDBASE_ENV_ID:'pintu-test-env',PINTU_MAP_PROXY_ORIGIN:'https://proxy.example',AMAP_JS_API_KEY:'c'.repeat(32)},temp);
    for(const name of ['midpoint.css','midpoint-ui.js'])assert.equal(fs.readFileSync(path.join(temp,'cloudbase-site',name),'utf8'),fs.readFileSync(path.join(temp,name),'utf8'));
    const generated=fs.readFileSync(path.join(temp,'app-config.js'),'utf8');
    assert.match(generated,/pintu-test-env/);assert.match(generated,/https:\/\/proxy.example\/_AMapService/);
    assert.doesNotMatch(generated,/securityJsCode|AMAP_SECURITY_JS_CODE/);
    assert.ok(fs.readFileSync(path.join(temp,'cloudbase-site/index.html'),'utf8').includes('key='+'c'.repeat(32)));
    assert.equal(require(path.join(temp,'miniprogram-shell/environment.js')).cloudbaseEnvId,'pintu-test-env');
    assert.throws(()=>require('./prepare-release.cjs').prepare({PINTU_MAP_PROXY_ORIGIN:'http://unsafe.example'},temp),/HTTPS/);
  }finally{
    const resolved=fs.realpathSync(temp);
    assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(parent).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('pintu-release-test-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
  // More than six room members must remain reachable in WeChat's action sheet.
  let pageCalls=0, transferred;
  const ownerSource=fs.readFileSync(path.join(root,'miniprogram-shell/utils/ownership.js'),'utf8');
  const miniBox={module:{exports:{}},require(){return{
    getRoom:async()=>({room:{members:Array.from({length:12},(_,i)=>({uid:'wx:'+i,name:'成员'+i}))},viewer:{uid:'owner',isOwner:true,membershipEpoch:'epoch'}}),
    transferOwnership:async(doc,uid,epoch)=>{transferred={doc,uid,epoch};return{room:{},viewer:{}};}
  };},wx:{showActionSheet:async options=>{assert.ok(options.itemList.length<=6);return{tapIndex:pageCalls++===0?5:1};},showModal:async()=>({confirm:true}),showToast(){}}};
  vm.runInNewContext(ownerSource,miniBox);
  await miniBox.module.exports({data:{busy:false},docId:'room',setData(){},applyRoom(){}});
  assert.equal(transferred.uid,'wx:6');assert.equal(transferred.epoch,'epoch');
  console.log('Launch readiness checks passed: 200 settlements, backup validation, quotas, map proxy, release configuration, ownership pagination.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});

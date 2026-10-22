'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');

async function staleGeocode() {
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const start=html.indexOf('async function calculateRealMidpoint()');
  const end=html.indexOf('async function renderMidpointResult',start);
  let version=1,resolveLocation,renders=0,alerts=0;
  const pending=new Promise(resolve=>{resolveLocation=resolve;});
  const button={disabled:false,textContent:''};
  const inputs=[{value:'测试地点甲',dataset:{}},{value:'测试地点乙',dataset:{lat:'31.2',lng:'121.4'}}];
  const context={
    window:{AMap:{}},console,alert(){alerts++;},showAppToast(){},
    pintuMidpointCurrentVersion:()=>version,
    pintuMidpointRequestIsCurrent:token=>token===version,
    getCoordinates:()=>pending,
    renderMidpointResult:async()=>{renders++;},
    document:{getElementById:()=>button,querySelectorAll:()=>inputs.map(input=>({querySelector:()=>input}))}
  };
  vm.createContext(context);vm.runInContext(html.slice(start,end),context);
  const calculation=context.calculateRealMidpoint();
  assert.equal(button.disabled,true);
  version++; // The user reopens the input page before the location resolves.
  resolveLocation({lat:31.1,lng:121.5});
  await calculation;
  assert.equal(renders,0,'old addresses must never render into a newer session');
  assert.equal(alerts,0,'an abandoned request must not alert on the new page');
  await context.calculateRealMidpoint();
  assert.equal(renders,1,'the current session still renders normally');
}

function filterExpandedDetails() {
  let expanded=true;
  const panel={classList:{contains:name=>name==='poi-expand-panel'},hidden:false,style:{display:'block'}};
  const card={dataset:{category:'mall'},hidden:false,nextElementSibling:panel,classList:{contains:()=>expanded}};
  const buttons=['all','food'].map(value=>({dataset:{poiFilter:value},setAttribute(){},addEventListener(name,callback){this.click=callback;}}));
  const ids={foodSwipeEntryCard:{addEventListener(){}},mpFilterEmpty:{},mpPoiSummary:{}};
  const context={SVG_PATHS:{},window:{foodSwipeDeck:[{}]},document:{
    querySelectorAll(selector){if(selector==='[data-poi-filter]')return buttons;if(selector==='#poiList > .poi-card')return [card];return [];},
    getElementById:id=>ids[id]
  }};
  vm.runInNewContext(fs.readFileSync(path.join(root,'midpoint-ui.js'),'utf8'),context);
  buttons[1].click();
  assert.equal(card.hidden,true);assert.equal(panel.style.display,'none','inline block must not leave filtered details visible');
  buttons[0].click();
  assert.equal(card.hidden,false);assert.equal(panel.style.display,'block','returning to the category preserves expanded state');
  expanded=false;buttons[0].click();
  assert.equal(panel.style.display,'none','collapsed details stay collapsed');
}

function locationHarness(options={}) {
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const start=html.indexOf('function reverseGeocodePosition(');
  const end=html.indexOf('function getCoordinates(',start);
  assert.ok(start>=0&&end>start,'location helpers remain available');
  let currentCallback,calls=0,timerId=0;
  const timers=new Map(),listeners=new Map(),toasts=[];
  const label={textContent:'定位'};
  const button={disabled:false,attrs:{},querySelector:()=>label,
    setAttribute(name,value){this.attrs[name]=String(value);},removeAttribute(name){delete this.attrs[name];}};
  const input={value:'原出发地',dataset:{lat:'30.1',lng:'120.2',locationGeneration:'0'},isConnected:true,
    closest:()=>({querySelector:()=>button}),
    addEventListener(name,callback){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(callback);},
    removeEventListener(name,callback){listeners.get(name)?.delete(callback);}};
  const AMap={
    Geolocation:function(){if(options.constructorError)throw Error('SDK constructor failed');this.getCurrentPosition=callback=>{calls++;currentCallback=callback;};},
    plugin(name,callback){if(options.pluginError)throw Error('plugin unavailable');callback();},
    Geocoder:function(){if(options.geocoderError)throw Error('geocoder unavailable');this.getAddress=(point,callback)=>{if(!options.reversePending)callback('complete',{regeocode:{formattedAddress:'定位地址'}});};}
  };
  const context={window:{AMap:options.noSDK?undefined:AMap,isSecureContext:true},AMap:options.noSDK?undefined:AMap,
    navigator:{geolocation:{}},console,Number,Promise,
    showAppToast:message=>toasts.push(message),
    setTimeout(callback,delay){const id=++timerId;timers.set(id,{callback,delay});return id;},
    clearTimeout:id=>timers.delete(id)};
  vm.createContext(context);vm.runInContext(html.slice(start,end),context);
  return {context,input,button,label,toasts,listeners,timers,get calls(){return calls;},
    locate:()=>context.geolocateMe(input),
    respond:(status,result)=>currentCallback(status,result),
    success:()=>currentCallback('complete',{position:{getLat:()=>31.2,getLng:()=>121.5},formattedAddress:'定位兜底地址'}),
    edit(value){input.dataset.locationGeneration=String(Number(input.dataset.locationGeneration)+1);input.value=value;delete input.dataset.lat;delete input.dataset.lng;for(const callback of [...(listeners.get('input')||[])])callback();},
    expire(delay){for(const [id,timer] of [...timers])if(timer.delay===delay){timers.delete(id);timer.callback();}}};
}

async function locationRegressions() {
  const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
  function idle(h){assert.equal(h.button.disabled,false);assert.notEqual(h.input.dataset.locating,'true');assert.notEqual(h.button.attrs['aria-busy'],'true');assert.equal(h.label.textContent,'定位');assert.equal(h.listeners.get('input')?.size||0,0,'input cancellation listener is removed');}
  const ok=locationHarness();ok.locate();
  assert.equal(ok.button.disabled,true);assert.equal(ok.input.dataset.locating,'true');assert.equal(ok.button.attrs['aria-busy'],'true');assert.equal(ok.label.textContent,'定位中');
  assert.equal(ok.input.value,'原出发地','pending location preserves the selected address');assert.equal(ok.input.dataset.lat,'30.1');
  ok.locate();assert.equal(ok.calls,1,'double clicks must not request the device twice');
  ok.success();await settle();assert.equal(ok.input.value,'定位地址');assert.equal(Number(ok.input.dataset.lat),31.2);assert.equal(Number(ok.input.dataset.lng),121.5);idle(ok);assert.equal(ok.timers.size,0,'completed location clears both timeout guards');

  const denied=locationHarness();denied.locate();denied.respond('error',{message:'User denied Geolocation'});await settle();
  assert.equal(denied.input.value,'原出发地');assert.equal(denied.input.dataset.lat,'30.1');assert.equal(denied.input.dataset.lng,'120.2');assert.match(denied.toasts.join(' '),/权限|允许|拒绝/);idle(denied);
  const timed=locationHarness();timed.locate();timed.expire(12000);await settle();
  assert.equal(timed.input.value,'原出发地');assert.match(timed.toasts.join(' '),/超时/);idle(timed);timed.success();await settle();assert.equal(timed.input.value,'原出发地','late timeout callbacks stay ignored');
  for(const options of [{constructorError:true},{noSDK:true}]){const h=locationHarness(options);assert.doesNotThrow(()=>h.locate());await settle();assert.equal(h.input.value,'原出发地');assert.ok(h.toasts.length);idle(h);}
  const invalid=locationHarness();invalid.locate();invalid.respond('complete',{position:{lat:NaN,lng:121}});await settle();assert.equal(invalid.input.value,'原出发地');assert.ok(invalid.toasts.length);idle(invalid);
  for(const position of [{lat:null,lng:121},{lat:31,lng:null},{lat:'',lng:121},{lat:31,lng:'  '}]){
    const h=locationHarness();h.locate();h.respond('complete',{position});await settle();
    assert.equal(h.input.value,'原出发地','empty coordinates must not become zero');assert.equal(h.input.dataset.lat,'30.1');assert.equal(h.input.dataset.lng,'120.2');assert.ok(h.toasts.length);idle(h);
  }
  const approximate=locationHarness();approximate.locate();approximate.respond('complete',{position:{lat:31.2,lng:121.5},location_type:'ip'});await settle();
  assert.equal(approximate.input.value,'定位地址');assert.match(approximate.toasts.join(' '),/大致位置/,'IP-derived locations must be described as approximate');idle(approximate);
  const stale=locationHarness();stale.locate();stale.edit('用户新输入');idle(stale);stale.success();await settle();assert.equal(stale.input.value,'用户新输入');assert.equal(stale.input.dataset.lat,undefined);assert.equal(stale.toasts.length,0);
  const staleReverse=locationHarness({reversePending:true});staleReverse.locate();staleReverse.success();await settle();
  assert.equal(staleReverse.input.value,'原出发地','pending reverse lookup also preserves the original address');assert.equal(staleReverse.timers.size,1,'device watchdog is replaced by the reverse-lookup watchdog');
  staleReverse.edit('反查期间的新地址');idle(staleReverse);staleReverse.expire(5000);await settle();assert.equal(staleReverse.input.value,'反查期间的新地址');assert.equal(staleReverse.input.dataset.lat,undefined);assert.equal(staleReverse.toasts.length,0);
  for(const options of [{pluginError:true},{geocoderError:true},{reversePending:true}]){
    const h=locationHarness(options);h.locate();h.success();await settle();if(options.reversePending){h.expire(5000);await settle();}
    assert.equal(h.input.value,'定位兜底地址','reverse-geocoding errors preserve the successful position');assert.equal(Number(h.input.dataset.lat),31.2);idle(h);
  }
}

(async()=>{
  await staleGeocode();filterExpandedDetails();await locationRegressions();
  console.log('Midpoint UI regressions passed: stale geocoding, expanded-detail filtering, and location success/failure/cancellation.');
})().catch(error=>{console.error(error);process.exitCode=1;});

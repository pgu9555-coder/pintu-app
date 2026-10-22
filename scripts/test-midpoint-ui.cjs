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

(async()=>{
  await staleGeocode();filterExpandedDetails();
  console.log('Midpoint UI regressions passed: stale geocoding and expanded-detail filtering.');
})().catch(error=>{console.error(error);process.exitCode=1;});

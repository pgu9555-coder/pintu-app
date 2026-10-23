const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const file = path.join(root, 'miniprogram-shell/pages/midpoint/index.js')
const math = require(path.join(root, 'miniprogram-shell/utils/midpoint'))
function deferred(){let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
function event(data){return {currentTarget:{dataset:data}}}
function fixture(overrides={}){
  let definition
  const calls={local:[],scoped:[],toast:[],map:[]}
  const storage={localScopeToken:()=> 'guest',getLocal:()=>null,setLocal:(key,value)=>{calls.local.push({key,value});return true},getScoped:()=>null,setScoped:(key,value)=>{calls.scoped.push({key,value});return true},removeScoped(){},getName:()=>'',saveName(){},isAccountScoped:()=>false}
  const amap={configuredKey:()=>true,nearby:async()=>[],detail:async poi=>({...poi,address:'真实地址'}),categories:async()=>[],categoryPage:async()=>({pois:[],page:2,total:0})}
  Object.assign(amap,overrides.amap||{})
  const wx={showToast:data=>calls.toast.push(data),createMapContext:()=>({includePoints:values=>calls.map.push(values)}),pageScrollTo(){},onNetworkStatusChange(){},offNetworkStatusChange(){},navigateBack(){},switchTab(){}}
  const modules={'../../utils/ownership':async()=>{},'../../services/roomGateway':{},'../../utils/storage':storage,'../../utils/midpoint':math,'../../utils/layout':{headerTopPx:()=>72},'../../utils/amap':amap,'../../utils/invite':{}}
  const context={Page:value=>definition=value,require:key=>modules[key],getApp:()=>({hasAccountConsent:()=>false}),wx,console,setTimeout,clearTimeout,setInterval,clearInterval,Set,Map,Date}
  vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file})
  const page=Object.assign({},definition,{data:JSON.parse(JSON.stringify(definition.data)),setData(patch,callback){Object.assign(this.data,patch);if(callback)callback()}})
  return {page,calls,storage,amap,gateway:modules['../../services/roomGateway']}
}
const pois=[{id:'mall',name:'商业广场',lat:22.5,lng:114.1,isMall:true,isDrink:false,photos:[]},{id:'food',name:'餐厅',lat:22.51,lng:114.11,isMall:false,isDrink:false,typeStr:'餐饮服务'},{id:'drink',name:'咖啡',lat:22.52,lng:114.12,isMall:false,isDrink:true}]
async function run(){
  {
    const {page,calls}=fixture()
    await page.onLoad({})
    assert.equal(page.localStorageReady,true)
    assert.equal(page.scopeReady,false)
    assert.equal(page.data.localPoints.length,2,'same two blank departure slots as web')
    assert.match(page.data.localStorageMessage,/本机/)
    page.data.localPoints=[{id:'a',lat:22,lng:114},{id:'b',lat:24,lng:116}]
    page.searchLocalCandidates=()=>{}
    page.calculateLocalMidpoint()
    assert.equal(page.data.resultMode,true)
    assert.equal(page.data.center.latitude,23)
    assert.equal(page.data.markers.length,3)
    assert.equal(page.data.polyline.length,2)
    assert.ok(page.data.markers[0].iconPath.endsWith('departure-A.png'))
    page.mapAction(event({action:'fit'}));assert.equal(calls.map.length,1)
    page.mapAction(event({action:'in'}));assert.equal(page.data.mapScale,13)
    page.adjustPlaces();assert.equal(page.data.resultMode,false)
    page.saveLocalState(page.data.localPoints,[])
    assert.equal(calls.local.length,1);assert.equal(calls.scoped.length,0)
  }
  {
    const {page}=fixture({amap:{nearby:async()=>pois}})
    page.localScope='guest'
    page.localSearchVersion=1;page.candidateDetails=Object.create(null);page.localStorageReady=true
    page.data.center={latitude:22.5,longitude:114.1}
    await page.searchLocalCandidates(page.data.center,1)
    assert.equal(page.data.mapLoading,false)
    assert.equal(page.data.resultRows.length,3)
    assert.equal(page.data.localCandidates.find(row=>row.id==='food').isDrink,false)
    page.setFilter(event({filter:'drink'}));assert.deepEqual(Array.from(page.data.resultRows,row=>row.id),['drink'])
    page.setFilter(event({filter:'food'}));assert.deepEqual(Array.from(page.data.resultRows,row=>row.id),['food'])
    page.setFilter(event({filter:'mall'}));assert.deepEqual(Array.from(page.data.resultRows,row=>row.id),['mall'])
    assert.ok(page.data.resultRows[0].cover.includes('/assets/categories/mall.png'))
  }
  {
    const pending=deferred(),{page}=fixture({amap:{nearby:()=>pending.promise}})
    page.localScope='guest'
    page.localSearchVersion=1;page.candidateDetails=Object.create(null)
    const run=page.searchLocalCandidates({latitude:22,longitude:114},1)
    page.resetLocalCalculation([{lat:23,lng:114},{lat:24,lng:115}])
    pending.resolve(pois);await run
    assert.equal(page.data.localCandidates.length,0,'stale nearby response cannot restore old results')
    assert.equal(page.data.resultMode,false)
  }
  {
    const {page,amap}=fixture({amap:{detail:async()=>{throw Error('网络失败')}}})
    page.localScope='guest'
    page.present({localCandidates:pois})
    await page.togglePoi(event({id:'mall'}))
    assert.match(page.data.resultRows[0].details.error,/网络失败/)
    amap.detail=async()=>({name:'商业广场',address:'真实地址'})
    amap.categories=async()=>[{key:'food',label:'美食',pois:[{id:'one',name:'店一',lat:22.501,lng:114.1}],total:220,page:1,maxPages:4,capped:true}]
    await page.retryPoi(event({id:'mall'}))
    assert.equal(page.data.resultRows[0].details.loaded,true)
    page.toggleCategory(event({id:'mall',key:'food'}))
    assert.equal(page.data.resultRows[0].details.categories[0].expanded,true)
    amap.categoryPage=async()=>({page:2,pois:[{id:'one',name:'店一',lat:22.501,lng:114.1},{id:'two',name:'店二',lat:22.502,lng:114.1}],total:220,capped:true})
    await page.moreCategory(event({id:'mall',key:'food'}))
    const category=page.data.resultRows[0].details.categories[0]
    assert.equal(category.pois.length,2);assert.equal(category.page,2);assert.equal(category.capped,true)
    assert.ok(category.pois[1].dist>0)
    page.startSwipe();assert.equal(page.data.screen,'swipe');assert.ok(page.data.swipeCurrent.cover)
    await page.takeSwipeAction('like');assert.equal(page.data.swipeLikes.length,1)
    await page.takeSwipeAction('pass');assert.equal(page.data.swipeLikes.length,1)
    page.showSwipeDetails(event({id:'mall'}));assert.equal(page.data.screen,'main');assert.equal(page.data.expandedPoiId,'mall')
  }
  {
    const {page}=fixture();page.viewer={uid:'wx:one',isOwner:false,membershipEpoch:'epoch-one'};page.candidateDetails={}
    const room={docId:'shared',members:[{uid:'wx:one'}],meetup:{people:[{uid:'wx:one',name:'甲',lat:22,lng:114},{uid:'wx:two',name:'乙',lat:24,lng:116}],decision:{candidates:pois,votes:[]}}}
    page.renderRoom(room,page.viewer);assert.equal(page.data.resultMode,true);assert.equal(page.data.room.docId,'shared')
    page.adjustPlaces();page.renderRoom({...room},page.viewer);assert.equal(page.data.resultMode,false,'poll cannot close place editor')
    page.showRoomResults();assert.equal(page.data.resultMode,true)
    assert.equal(page.viewer.membershipEpoch,'epoch-one')
  }
  {
    const pending=deferred(),{page,storage,calls}=fixture({amap:{nearby:()=>pending.promise}})
    let scope='guest';storage.localScopeToken=()=>scope
    await page.onLoad({})
    page.localSearchVersion=1
    const query=page.searchLocalCandidates({latitude:22,longitude:114},1)
    scope='account-B';storage.getLocal=()=>({points:[{lat:30,lng:120},{lat:31,lng:121}],candidates:[]})
    assert.equal(page.saveLocalState(page.data.localPoints,[]),false,'guest memory cannot be saved into newly selected account')
    page.onShow()
    assert.equal(page.localScope,'account-B')
    assert.equal(page.data.localPoints[0].lat,30)
    pending.resolve(pois);await query
    assert.equal(page.data.localCandidates.length,0)
    assert.equal(calls.local.length,0,'late guest search must not persist into account B')
    assert.equal(page.data.room,null)
  }
  {
    let timeout,requestData
    const module={exports:{}}
    const context={module,exports:module.exports,wx:{cloud:{callFunction:input=>{requestData=input;return new Promise(()=>{})}}},setTimeout:fn=>{timeout=fn;return 1},clearTimeout(){},Promise,Error,Number,String,Array,Object,Boolean}
    vm.runInNewContext(fs.readFileSync(path.join(root,'miniprogram-shell/utils/amap.js'),'utf8'),context)
    const pending=module.exports.detail({poiId:'safe-poi',name:'地点',lat:22,lng:114})
    const rejection=assert.rejects(pending,error=>error.code==='MAP_TIMEOUT')
    assert.equal(requestData.name,'mapGateway');assert.equal(requestData.data.action,'detail')
    timeout();await rejection
    let scopes=0
    context.wx.cloud.callFunction=async input=>{scopes++;return {result:{ok:true,data:[]}}}
    await module.exports.categories({lat:22,lng:114,isMall:true,isDrink:false})
    assert.equal(scopes,1)
  }
  {
    for (const change of ['scope','docId','epoch']) {
      const pending=deferred(),{page,gateway,calls,storage}=fixture()
      page.localScope='guest';page.docId='room-A';page.viewer={uid:'wx:A',membershipEpoch:'epoch-A'}
      page.present({room:{meetup:{decision:{roundId:'round-A',revision:1,candidates:pois,votes:[]}}}})
      let fetched=0;page.fetchRoom=async()=>{fetched++};gateway.setDecisionVote=()=>pending.promise
      const mutation=page.runDecisionMutation('setDecisionVote',{candidateId:'mall',value:'want'},'失败')
      if(change==='scope'){storage.localScopeToken=()=> 'B';page.localScope='B'}
      if(change==='docId')page.docId='room-B'
      if(change==='epoch')page.viewer.membershipEpoch='epoch-B'
      page.present({busy:true})
      pending.resolve({})
      assert.equal(await mutation,false,'old '+change+' decision must not report success')
      assert.equal(fetched,0,'old mutation must not refetch new room')
      if(change!=='epoch')assert.equal(page.data.busy,true,'old finalizer must not change new room busy state')
      assert.equal(calls.toast.length,0)
    }
  }
  {
    const pending=deferred(),{page,gateway}=fixture()
    page.localScope='guest';page.docId='room-A';page.viewer={uid:'A',membershipEpoch:'epoch-A'}
    page.present({room:{meetup:{decision:{candidates:pois,votes:[]}}},swipeCurrent:pois[0],swipeDeck:pois,swipeLikes:[],swipeIndex:0})
    gateway.setDecisionVote=()=>pending.promise;page.fetchRoom=async()=>{}
    const swipe=page.takeSwipeAction('like')
    page.docId='room-B';page.viewer={uid:'B',membershipEpoch:'epoch-B'}
    page.present({swipeLikes:[{id:'new-room-like'}],swipeIndex:2,swipeVoteBusy:true})
    pending.resolve({});await swipe
    assert.equal(page.data.swipeLikes[0].id,'new-room-like')
    assert.equal(page.data.swipeIndex,2)
    assert.equal(page.data.swipeVoteBusy,true)
  }
  {
    const pending=deferred(),{page,gateway}=fixture()
    page.localScope='guest';page.docId='room-A';page.viewer={uid:'A',membershipEpoch:'epoch-A'}
    page.present({room:{meetup:{decision:{candidates:pois,votes:[]}}}})
    gateway.setDecisionVote=async()=>({});page.fetchRoom=()=>pending.promise
    const mutation=page.runDecisionMutation('setDecisionVote',{candidateId:'mall',value:'want'},'失败')
    await Promise.resolve();page.docId='room-B';pending.resolve()
    assert.equal(await mutation,false,'also validate context after refetch')
  }
  {
    const wxml=fs.readFileSync(path.join(root,'miniprogram-shell/pages/midpoint/index.wxml'),'utf8'),stack=[]
    for(const match of wxml.matchAll(/<\/?([a-z][\w-]*)\b[^>]*>/g)){
      if(match[0].startsWith('</'))assert.equal(stack.pop(),match[1]);else if(!match[0].endsWith('/>'))stack.push(match[1])
    }
    assert.equal(stack.length,0)
    const {page}=fixture();for(const match of wxml.matchAll(/(?:bind|catch)(?:tap|touchstart|touchmove|touchend|error|input|focus|confirm)="([A-Za-z]\w*)"/g))assert.equal(typeof page[match[1]],'function',`bound handler ${match[1]} exists`)
    for(const letter of 'ABCDEF')assert.ok(fs.existsSync(path.join(root,`miniprogram-shell/assets/map/departure-${letter}.png`)))
  }
  console.log('Native midpoint parity checks passed: guest drafts, map state/controls, food filters, stale searches, details/retry/pagination, swipe and shared room continuity.')
}
run().catch(error=>{console.error(error);process.exitCode=1})

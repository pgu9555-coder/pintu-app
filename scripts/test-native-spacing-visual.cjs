'use strict'
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { render } = require('./test-native-mobile-layout.cjs')
const out = path.resolve(process.env.VISUAL_OUTPUT || '../../outputs/native-spacing-audit')
const base = {headerMetrics:{statusBarPx:24,headerHeightPx:44,capsuleInsetRightPx:97},screen:'main',resultMode:false,name:'小林',accountAvatar:'',busy:false,inviteType:'',onboarding:false,moreOpen:false}
const room = {...base, room:{code:'5LA22PFK'},isOwner:true,people:[{uid:'a',name:'小林',isSelf:true,address:'上海市黄浦区人民广场'}],mineEditorOpen:false,mineHasSavedLocation:true,center:null}
const longAddress = 'The Grove, 189 The Grove Drive, Los Angeles, California 90036, United States — meet at the main entrance by the fountain'
const fixtures = [
 ['midpoint-collapsed','midpoint',room],
 ['midpoint-expanded','midpoint',{...room,mineEditorOpen:true,mineAddress:'上海人民广场',amapConfigured:true}],
 ['midpoint-long-address','midpoint',{...room,people:[{...room.people[0],address:longAddress}],mineEditorOpen:true,mineAddress:longAddress,mineLocation:null,amapConfigured:true}],
 ['home-guest','home',{...base,accountSignedIn:false,code:'',profilePanelOpen:false,wechatLoginVisible:false}],
 ['midpoint-empty-address','midpoint',{...room,people:[{...room.people[0],address:''}],mineHasSavedLocation:false}],
 ['midpoint-entry','midpoint',{...base,room:null,code:''}],
 ['home','home',{...base,accountSignedIn:true,code:'',profilePanelOpen:false,wechatLoginVisible:false}],
 ['profile','profile',{canChooseAvatar:true,nickname:'小林',avatar:'',busy:false,onboarding:false,moreOpen:false}],
 ['ledger','ledger',{...base,step:1,room:null,ledger:{members:[],expenses:[]},syncText:'本机保存'}],
 ['trips','trips',{...base,accountSignedIn:true,accountNickname:'小林',localTrips:[],rooms:[],loading:false,loginRequired:false}],
 ['spinner','spinner',{...base,names:['小林','小陈'],decision:'这次谁来买单',canvasSize:280,result:'',spinning:false,wheelReady:false,motionReduced:false}],
 ['agreement','agreement',{...base,title:'隐私说明',privacy:true,sections:[{title:'信息的保存',text:'头像和昵称由你主动选择。'.repeat(4)}]}],
 ['data-tools','data-tools',{...base,scopeLabel:'当前微信账号',localCount:12,cachedCount:20}]
]
async function main(){
 fs.mkdirSync(out,{recursive:true})
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})})
 try {
 const page=await browser.newPage({viewport:{width:375,height:812},deviceScaleFactor:1})
 const report=[]
 for(const [id,name,data] of fixtures){
  await render(page,name,data,1)
  await page.screenshot({path:path.join(out,id+'.png'),fullPage:true})
  const geometry=await page.evaluate(()=>{
   const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}
   const buttons=Array.from(document.querySelectorAll('button')).filter(e=>e.textContent.trim()).map(e=>{
    const range=document.createRange();range.selectNodeContents(e);const t=range.getBoundingClientRect(),b=e.getBoundingClientRect()
    return {class:e.className,label:e.textContent.trim(),...rect(e),textCenterOffset:Math.round((t.y+t.height/2-b.y-b.height/2)*10)/10}
   })
   return {buttons,cards:Array.from(document.querySelectorAll('.card')).map(rect)}
  })
  if(id.startsWith('midpoint-')&&id!=='midpoint-entry'){
   const [a,b]=geometry.cards; assert.ok(Math.abs(b.y-a.y-a.height-12)<1,'room to departure card gap stays 12px')
   for(const b of geometry.buttons.filter(b=>b.class.includes('room-action'))){assert.ok(b.height>=44&&b.height<=48,'normal room action stays 44–48px');assert.ok(Math.abs(b.textCenterOffset)<=2,'room action glyphs centered: '+JSON.stringify(b))}
   if(id==='midpoint-collapsed') assert.ok(a.height<=230,'room card contains no unexplained vertical reservoir')
  }
  if(id==='home-guest') assert.equal(await page.locator('.join-identity-status').innerText(),'未登录 · 点击此登录')
  if(id==='midpoint-long-address') await checkAddress(page, longAddress)
  if(id==='midpoint-empty-address') {
   assert.equal(await page.locator('.point-member').getByText('等待填写出发点',{exact:true}).count(),1)
   assert.equal(await page.locator('.point-member').getByText('当前地点',{exact:true}).count(),0,'empty address must not claim a current location')
  }
  if(id==='ledger') {
   const code=await page.locator('.room-entry-row input').boundingBox()
   assert.ok(code.width>=150,'ledger code must remain usable: '+code.width)
   const add=await page.locator('.add-member-row input').boundingBox()
   assert.ok(add.width>=150,'ledger name must remain usable: '+add.width)
  }
  report.push({id,...geometry})
  if(id==='midpoint-long-address') {
   await page.setViewportSize({width:320,height:812})
   await render(page,name,data,1.4)
   await checkAddress(page,longAddress)
   await page.screenshot({path:path.join(out,'midpoint-long-address-320-large.png'),fullPage:true})
   await page.setViewportSize({width:375,height:812})
  }
  if(id==='ledger') {
   await page.setViewportSize({width:320,height:812})
   await render(page,name,data,1.4)
   const code=await page.locator('.room-entry-row input').boundingBox()
   assert.ok(code.width>=150,'320px ledger code stays usable: '+code.width)
   await page.screenshot({path:path.join(out,'ledger-320-large.png'),fullPage:true})
   await page.setViewportSize({width:375,height:812})
  }
 }
 fs.writeFileSync(path.join(out,'geometry.json'),JSON.stringify(report,null,2))
 console.log('Rendered '+fixtures.length+' screens; button text centering, room card height and 12px card gaps passed. Browser rendering only: '+out)
 }finally{await browser.close()}
}
async function checkAddress(page, address) {
 assert.equal(await page.locator('.point-saved-address').innerText(),address)
 assert.equal(await page.locator('.point-location-card').count(),1,'one address card per member')
 assert.equal(await page.locator('.mine-editor .mine-address-preview, .mine-editor .point-location-card').count(),0,'editor must not duplicate the address card')
 assert.equal(await page.locator('.point-location-label').innerText(),'当前地点')
 const m=await page.locator('.point-saved-address').evaluate(e=>{const b=e.getBoundingClientRect(),card=e.closest('.point-location-card'),c=card.getBoundingClientRect(),member=e.closest('.point-member'),p=member.getBoundingClientRect(),h=member.querySelector('.point-member-head').getBoundingClientRect(),s=getComputedStyle(e),cs=getComputedStyle(card);return {width:b.width,cardWidth:c.width,parent:p.width,x:c.x,px:p.x,y:c.y,headBottom:h.bottom,font:parseFloat(s.fontSize),overflow:s.overflow,whiteSpace:s.whiteSpace,scroll:e.scrollHeight,height:e.clientHeight,color:s.color,background:cs.backgroundColor,radius:parseFloat(cs.borderRadius)}})
 assert.ok(m.cardWidth>=m.parent-2&&Math.abs(m.x-m.px)<2,'location card uses full member width')
 assert.ok(m.width>=m.cardWidth-32,'address uses card width with only compact inner padding')
 assert.ok(m.radius>=8&&m.background!=='rgba(0, 0, 0, 0)','location card has rounded colored background')
 assert.ok(m.y>=m.headBottom,'saved address starts below identity row')
 assert.ok(m.font>=16&&m.whiteSpace==='normal'&&m.overflow==='visible'&&m.scroll<=m.height+1,'saved address wraps fully at readable size: '+JSON.stringify(m))
 const rgb=m.color.match(/\d+/g).slice(0,3).map(Number);assert.ok(Math.max(...rgb)<100,'saved address uses dark foreground')
}
main().catch(e=>{console.error(e);process.exitCode=1})

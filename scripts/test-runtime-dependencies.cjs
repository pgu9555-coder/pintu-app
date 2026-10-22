'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {createRequire}=require('node:module');

(async()=>{
 for(const name of ['roomGateway','mapGateway','quotaCleanup']) {
  const requireRuntime=createRequire(path.resolve(__dirname,'../cloudfunctions',name,'package.json'));
  const cloudbase=requireRuntime('@cloudbase/node-sdk');
  const db=cloudbase.init({env:'pintu-sdk-compatibility'}).database();
  const {Db}=requireRuntime('@cloudbase/database');
  const calls=[];
  Db.reqClass=class {
   async send(action,data) {
    calls.push({action,data});
    return {transactionId:'test-transaction',data:{list:[JSON.stringify({_id:'counter',count:2})],updated:1,deleted:1,id:'counter'}};
   }
  };
  const expiresAt=new Date('2026-10-22T00:00:00Z');
  const rows=await db.collection('request_limits').where({expiresAt:db.command.lt(expiresAt)}).limit(100).get();
  assert.equal(rows.data[0].count,2);
  assert.match(JSON.stringify(calls.at(-1).data),/\$lt/);
  await db.collection('rooms').doc('test-room').update({ownerUid:'test-owner',membershipEpoch:db.command.inc(1)});
  assert.match(JSON.stringify(calls.at(-1).data),/\$inc/);
  await db.collection('request_limits').where({_id:db.command.in(['counter']),expiresAt:db.command.lt(expiresAt)}).remove();
  assert.equal(calls.at(-1).action,'database.removeDocument');
  const result=await db.runTransaction(async tx=>{
   const counter=await tx.collection('request_limits').doc('counter').get();
   assert.equal(counter.data.count,2);
   await tx.collection('request_limits').doc('counter').set({count:3,expiresAt});
   return 'committed';
  });
  assert.equal(result,'committed');
  assert.ok(calls.some(c=>c.action==='database.startTransaction'));
  assert.equal(calls.at(-1).action,'database.commitTransaction');
  assert.equal(typeof cloudbase.getCloudbaseContext,'function');
  if(name!=='quotaCleanup') {
   const wx=requireRuntime('wx-server-sdk');
   wx.init({env:wx.DYNAMIC_CURRENT_ENV});
   assert.equal(typeof wx.getWXContext,'function');
   assert.equal(typeof wx.openapi.security.msgSecCheck,'function');
  }
 }
 console.log('Installed runtime SDK checks passed: queries, dates, updates, transactions, identity and content-security APIs.');
})().catch(error=>{console.error(error);process.exitCode=1;});

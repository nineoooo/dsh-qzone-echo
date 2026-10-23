import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import vm from 'node:vm'
const store=await import('./lib/store.mjs')
const job=await import('./lib/image-job.mjs')
const urls=Array.from({length:13},(_,i)=>'https://qpic.cn/'+i+'.jpg')
function fixture(rows){
 process.env.QZONE_ECHO_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'qzone-image-job-'))
 store.saveCredential('uin=o0123456; p_skey=synthetic','123456')
 store.writeFeed(rows.map(tid=>({owner:'123456',tid,content:'保留全文',picTotal:13,images:urls.slice(0,9)})))
}
fixture(['a','b','partial','gone'])
let calls=0
const request=async(_jar,_owner,tid)=>{
 calls++
 if(tid==='b')job.configureImageJob('pause') // Pause while the current post is in flight.
 if(tid==='partial')return{ok:true,urls:urls.slice(0,10)}
 if(tid==='gone')return{ok:false,code:-10029,error:'说说不存在'}
 return{ok:true,urls}
}
assert.equal(job.configureImageJob('start').total,4)
let r=await job.runImageJobTick({request})
assert.equal(calls,1);assert.equal(r.processed,1);assert.equal(r.remaining,3)
r=await job.runImageJobTick({request})
assert.equal(calls,2);assert.equal(r.processed,2);assert.equal(r.enabled,false);assert.equal(r.status,'paused')
await job.runImageJobTick({request});assert.equal(calls,2)
job.configureImageJob('start')
r=await job.runImageJobTick({request})
assert.equal(r.processed,3);assert.equal(r.skipped,1)
r=await job.runImageJobTick({request})
assert.equal(r.processed,4);assert.equal(r.repaired,2);assert.equal(r.addedImages,9)
assert.equal(r.status,'completed_with_gaps');assert.equal(r.remainingMissing,2)
assert.equal(store.loadAll().find(m=>m.tid==='partial').images.length,10)
assert.equal(store.loadAll().find(m=>m.tid==='gone').content,'保留全文')
assert.equal(job.configureImageJob('start').total,2) // A new run can revisit outstanding gaps.
fixture(['limited','next'])
job.configureImageJob('start');let limitedCalls=0
r=await job.runImageJobTick({request:async()=>{limitedCalls++;return{ok:false,throttled:true,error:'使用人数过多'}}})
assert.equal(r.status,'cooldown');assert.equal(r.processed,0)
await job.runImageJobTick({request:async()=>{limitedCalls++;throw Error('must not run')}})
assert.equal(limitedCalls,1)
job.configureImageJob('pause');r=job.configureImageJob('start')
assert.equal(r.status,'cooldown') // Start/resume must preserve the cooldown.
fixture(['login'])
job.configureImageJob('start')
r=await job.runImageJobTick({request:async()=>({ok:false,needCookie:true,error:'请重新登录'})})
assert.equal(r.status,'needs_login');assert.equal(r.enabled,false)
fixture(['done'])
job.configureImageJob('start')
r=await job.runImageJobTick({request:async()=>({ok:true,urls})})
assert.equal(r.status,'completed');assert.equal(r.remainingMissing,0)
// Starting scans an 8,000-post local library; each tick still requests only one post.
fixture(Array.from({length:8000},(_,i)=>'bulk'+i))
const started=performance.now();r=job.configureImageJob('start');const scanMs=Math.round(performance.now()-started)
assert.equal(r.total,8000)
let largeCalls=0
r=await job.runImageJobTick({request:async()=>{largeCalls++;return{ok:true,urls}}})
assert.equal(largeCalls,1);assert.equal(r.processed,1);assert.equal(r.remaining,7999)
const page=fs.readFileSync(new URL('./lib/page.html',import.meta.url),'utf8')
new vm.Script(page.match(/<script>([\s\S]*?)<\/script>/)[1])
assert.ok(page.includes('一键补齐全部'));assert.ok(page.includes('id="btnPausePictures"'))
console.log('PASS: autonomous queue; one request per tick; pause in flight; resume; cooldown; skip bad posts; honest completion; login pause; 8000-post queue scan '+scanMs+'ms; page syntax')

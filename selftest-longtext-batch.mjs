import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
process.env.QZONE_ECHO_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'qzone-batch-test-'))
const store=await import('./lib/store.mjs')
const repair=await import('./lib/repair.mjs')
const content=await import('./lib/content.mjs')
store.saveCredential('uin=o0123456; p_skey=synthetic-test-key','123456')
// 候选集现在按 looksTruncated 收窄（2026-10-23 改）：只有「看着被截」的才排队。
//   a: 正好 500 字（卡在腾讯硬上限）           → 候选
//   b: 正好 500 字，详情却回更短的东西          → 候选，但不许缩短
//   long2: 400 字 + 省略号收尾                  → 候选（省略号判据，带 200 字门槛）
//   short: 短帖不带省略号                       → 不是候选，一次都不许查
store.writeFeed([
 {tid:'a',owner:'123456',content:'甲'.repeat(500),verifiedAt:'2026-10-22'},
 {tid:'b',owner:'123456',content:'乙'.repeat(500)},
 {tid:'long2',owner:'123456',content:'丙'.repeat(400)+'……'},
 {tid:'short',owner:'123456',content:'短的开头'},
 {tid:'a',owner:'654321',content:'其他账号'},
 {tid:'gone',owner:'123456',content:'查不到原文的帖子'},
])
assert.equal(repair.repairStatus().total,3) // 候选集只认那三条，短帖不进队
assert.equal(repair.repairStatus().remaining,3)
let clock=Date.now(), calls=0
repair.configureRepair({enabled:true})
const full='甲'.repeat(500)+'结尾'.repeat(300)
const long2full='丙'.repeat(900)
const ok=async(_jar,_owner,tid)=>{
 calls++
 return {ok:true,post:{code:0,content:tid==='a'?full:tid==='b'?'更短的返回':tid==='long2'?long2full:'wrong'}}
}
let r=await repair.repairBatch({max:1,intervalMs:0,request:ok,now:()=>clock})
assert.equal(r.expanded,1);assert.equal(r.remaining,2)
assert.equal(store.loadAll().find(m=>m.owner==='123456'&&m.tid==='a').content,full)
assert.equal(store.loadAll().find(m=>m.owner==='654321').content,'其他账号')
const backup=JSON.parse(fs.readFileSync(r.backup,'utf8').split('\n')[0])
assert.equal(backup.content,'甲'.repeat(500))
assert.ok(!fs.readFileSync(store.paths().feed,'utf8').includes('thoughtOverride'))
const throttled=async()=>{calls++;return {ok:false,code:-10000,message:'使用人数过多，请稍后再试',throttled:true}}
const before=calls
r=await repair.repairBatch({max:5,intervalMs:0,request:throttled,now:()=>clock})
assert.equal(calls,before+1);assert.equal(r.remaining,2)
assert.ok(Date.parse(r.nextRetryAt)>clock)
await repair.repairBatch({max:5,intervalMs:0,request:ok,now:()=>clock})
assert.equal(calls,before+1)
repair.configureRepair({enabled:false})
assert.equal((await repair.repairBatch({request:ok})).skipped,true)
repair.configureRepair({enabled:true})
assert.ok(repair.repairStatus().nextRetryAt) // Resume must not bypass the upstream cooldown.
clock+=31*60*1000
r=await repair.repairBatch({max:5,intervalMs:0,request:ok,now:()=>clock})
assert.equal(r.remaining,0);assert.equal(r.enabled,false)
assert.equal(r.expanded,2)
assert.equal(store.loadAll().find(m=>m.tid==='b').content,'乙'.repeat(500)) // 详情更短 → 原文一字不动
assert.equal(store.loadAll().find(m=>m.tid==='long2').content,long2full)  // 省略号收尾的确实补上了
assert.equal(store.loadAll().find(m=>m.tid==='short').content,'短的开头') // 短帖没被碰
assert.equal(store.loadAll().find(m=>m.tid==='gone').content,'查不到原文的帖子')
assert.equal(calls,before+3) // 补过的 a 不再问第二次，短的 short 一次都没问
// 补过之后不该再被当成候选重新排队（否则会无限循环查同一批）
assert.equal(repair.repairStatus().remaining,0)
assert.equal(content.looksTruncated(store.loadAll().find(m=>m.tid==='a')),false)
console.log('PASS: truncated-only queue, short previews skipped, checked posts, resume, backup, no shortening, owner isolation, missing-post preservation, throttle cooldown, pause')

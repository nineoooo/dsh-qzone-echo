import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import assert from 'node:assert/strict'
process.env.QZONE_ECHO_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'qzone-pictures-test-'))
const store=await import('./lib/store.mjs')
const {fetchPostPictures,preserveCompletePictures}=await import('./lib/pictures.mjs')
const {completeMissingPictures,missingPictureStats}=await import('./lib/image-repair.mjs')
const urls=Array.from({length:50},(_,i)=>'https://qpic.cn/image-'+i+'.jpg')
store.saveCredential('uin=o0123456; p_skey=synthetic','123456')
// ⚠️ 2026-10-28：这条原来用 verifiedAt:'kept' 验证「不认识的字段原样保留」，
//    但 verifiedAt 现在是 persistable() 要剥掉的死字段（验活功能已删），
//    换成中性的 customMarker —— 意图不变（不认识的字段不动），也不跟隐私清洗打架。
const original={tid:'one',owner:'123456',content:'完整长文不可改',ts:1700000000,images:urls.slice(0,9),picTotal:13,localImages:['local-0',null,'local-2'],customMarker:'kept'}
store.writeFeed([original,{...original,owner:'654321',content:'其他账号'}])
store.writeThoughts([original])
let calls=0
global.fetch=async url=>{
 calls++;assert.ok(String(url).includes('emotion_cgi_get_pics_v6'))
 return new Response('_preloadCallback('+JSON.stringify({result:{code:0},imageUrls:[...urls.slice(0,13),urls[0]]})+')')
}
assert.equal((await fetchPostPictures({},'123456','one')).urls.length,13)
let r=await completeMissingPictures({tid:'one',intervalMs:0})
assert.equal(r.repaired,1);assert.equal(r.addedImages,4)
let saved=store.loadAll().find(m=>m.owner==='123456')
assert.equal(saved.images.length,13);assert.equal(saved.content,original.content);assert.equal(saved.customMarker,'kept')
assert.equal(saved.localImages[0],'local-0');assert.equal(saved.localImages[1],null);assert.equal(saved.localImages[2],'local-2')
assert.equal(store.loadAll().find(m=>m.owner==='654321').images.length,9)
assert.equal(store.loadThoughts()[0].images.length,13)
assert.ok(fs.readdirSync(process.env.QZONE_ECHO_HOME).some(n=>n.startsWith('feed.before-image-repair-')))
const before=calls;await completeMissingPictures({tid:'one',intervalMs:0});assert.equal(calls,before)
store.mergeMoments([{...original}],{owner:'123456'})
assert.equal(store.loadAll().find(m=>m.owner==='123456').images.length,13)
// An actual photo edit with a smaller declared total remains possible.
assert.equal(preserveCompletePictures(saved,{images:[urls[0]],picTotal:1}).images.length,1)
store.writeFeed([{...original,tid:'fifty',picTotal:50}])
r=await completeMissingPictures({tid:'fifty',intervalMs:0,request:async()=>({ok:true,urls})})
assert.equal(r.items[0].images.length,50)
// Partial results save new images without claiming completion.
store.writeFeed([{...original,tid:'partial',picTotal:13}])
r=await completeMissingPictures({intervalMs:0,request:async()=>({ok:true,urls:urls.slice(0,10)})})
assert.equal(r.ok,false);assert.equal(store.loadAll()[0].images.length,10)
assert.equal(missingPictureStats().missing,3)
// Reject unrelated image lists, even when the counts happen to match.
r=await completeMissingPictures({intervalMs:0,request:async()=>({ok:true,urls:urls.slice(13,26)})})
assert.equal(r.repaired,0);assert.equal(store.loadAll()[0].content,original.content)
let denied=0
r=await completeMissingPictures({intervalMs:0,request:async()=>{denied++;return{ok:false,error:'使用人数过多',throttled:true}}})
assert.equal(r.ok,false);assert.equal(denied,1)
await completeMissingPictures({intervalMs:0,request:async()=>{denied++;throw Error('must not request during cooldown')}})
assert.equal(denied,1)
global.fetch=async()=>new Response('_preloadCallback({"result":{"code":-10000,"msg":"使用人数过多"}})')
assert.equal((await fetchPostPictures({},'123456','one')).throttled,true)
const page=fs.readFileSync(new URL('./lib/page.html',import.meta.url),'utf8')
new vm.Script(page.match(/<script>([\s\S]*?)<\/script>/)[1])
assert.ok(page.includes('data-act="complete-pictures"'))
assert.ok(!page.includes('剩下的要在手机 QQ 里看'))
console.log('PASS: nested result parser; 9->13; 50 photos; original body intact; owner isolation; local image alignment; backup; derived views; sync preservation; real edits; partial/mismatched response rejection; cooldown; web syntax')

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
process.env.QZONE_ECHO_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'qzone-partial-pictures-'))
const store=await import('./lib/store.mjs')
const {completeMissingPictures}=await import('./lib/image-repair.mjs')
const {runImageJobTick,configureImageJob}=await import('./lib/image-job.mjs')
const urls=Array.from({length:51},(_,i)=>'https://qpic.cn/'+i+'.jpg')
store.saveCredential('uin=o0123456; p_skey=synthetic','123456')
store.writeFeed([{owner:'123456',tid:'partial',picTotal:51,images:urls.slice(0,9),content:'完整正文'}])
configureImageJob('start')
let r=await runImageJobTick({request:async()=>({ok:true,urls:urls.slice(0,50)})})
assert.equal(r.status,'completed_with_gaps');assert.equal(r.repaired,0);assert.equal(r.addedImages,41)
let m=store.loadAll()[0]
assert.equal(m.images.length,50);assert.equal(m.picTotal,51);assert.equal(m.imageListComplete,false)
assert.equal(m.imageListPartial,true);assert.equal(m.content,'完整正文')
store.mergeMoments([{owner:'123456',tid:'partial',picTotal:51,images:urls.slice(0,9),content:'完整正文'}])
m=store.loadAll()[0];assert.equal(m.images.length,50);assert.equal(m.imageListPartial,true)
const retry=await completeMissingPictures({tid:'partial',intervalMs:0,request:async()=>({ok:true,urls:urls.slice(0,50)})})
assert.equal(retry.addedImages,0);assert.equal(store.loadAll()[0].picTotal,51)
const full=await completeMissingPictures({tid:'partial',intervalMs:0,request:async()=>({ok:true,urls})})
assert.equal(full.repaired,1);assert.equal(full.addedImages,1);assert.equal(store.loadAll()[0].imageListComplete,true)
assert.equal(store.loadAll()[0].imageListPartial,false)
console.log('PASS: 9->50/51 saved; background counts partial additions; missing flag retained; resync cannot shrink partial progress; no double counting; final photo completes the record')

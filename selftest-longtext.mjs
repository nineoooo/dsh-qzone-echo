import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
process.env.QZONE_ECHO_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'qzone-longtext-test-'))
const {postContent,parsePostJsonp}=await import('./lib/content.mjs')
const {normalize,fetchAll}=await import('./lib/qzone.mjs')
const {verifyOne,verifyBatch}=await import('./lib/verify.mjs')
const store=await import('./lib/store.mjs')
const full='第一段。\n第二段含有“引号”、"双引号"、\\路径与结尾。'
assert.equal(postContent({content:full,conlist:[{type:2,con:'第一段。'}]}),full)
assert.equal(postContent({content:'第一段。…',conlist:[{type:2,con:'第一段。\n'},{type:2,con:full.split('\n')[1]}]}),full)
assert.equal(postContent({conlist:[{type:2,con:'第一段。\n'},{type:2,con:full.split('\n')[1]}],commentlist:[{con:'不能混入评论'}]}),full)
assert.equal(postContent({commentlist:[{con:'不能当正文'}]}),'')
assert.equal(parsePostJsonp('_preloadCallback('+JSON.stringify({content:full})+');').content,full)
assert.equal(parsePostJsonp('_preloadCallback({"content":"\\x3c文本\\n下一行"})').content,'<文本\n下一行')
assert.equal(normalize({content:'开头…',conlist:[{type:2,con:'开头和结尾'}]}).content,'开头和结尾')
let requests=[]
global.fetch=async url=>{
 requests.push(String(url))
 const detail=String(url).includes('msgdetail')
 const data=detail ? {code:0,content:full,conlist:[{type:2,con:'第一段。'}],pic:[],created_time:1} : {code:0,total:1,msglist:requests.filter(x=>x.includes('msglist')).length===1?[{tid:'one',content:'第一段。…',has_more_con:1,created_time:1}]:[]}
 return new Response('_preloadCallback('+JSON.stringify(data)+');')
}
const v=await verifyOne({},'123456','one')
assert.equal(v.content,full)
assert.equal(v.contentIncomplete,false)
assert.ok(requests[0].includes('not_trunc_con=1'))
const local=[{tid:'one',content:'第一段。',owner:'123456'}]
await verifyBatch({},'123456',local,{intervalMs:0})
assert.equal(local[0].content,full)
requests=[]
const r=await fetchAll({},'123456',{max:2,sleep:0})
assert.equal(r.items[0].content,full)
assert.equal(r.items[0].contentSource,'detail')
store.mergeMoments(r.items,{owner:'123456'})
store.mergeMoments([{tid:'one',content:'第一段。…',contentIncomplete:true,contentSource:'list'}],{owner:'123456'})
assert.equal(store.loadAll()[0].content,full)
store.mergeMoments([{tid:'one',content:'作者修改后的短文',contentSource:'detail',contentIncomplete:false}],{owner:'123456'})
assert.equal(store.loadAll()[0].content,'作者修改后的短文')
// Cached full bodies need no second network request for the same preview.
requests=[]
const cached=await fetchAll({},'123456',{max:2,sleep:0,fullKnown:new Map([['one',{tid:'one',content:full,contentSource:'detail',contentIncomplete:false}]])})
assert.equal(cached.items[0].content,full)
assert.equal(requests.filter(x=>x.includes('msgdetail')).length,0)
// An authentication failure keeps existing content and never marks deletion.
global.fetch=async()=>new Response('_preloadCallback({"code":-10000,"message":"请登录"})')
const denied=await verifyOne({},'123456','one')
assert.equal(denied.alive,null)
console.log('PASS: full body, multiple blocks, JSON escapes, comments isolated, detail expansion, storage protection, shorter edits, cache, auth failure')

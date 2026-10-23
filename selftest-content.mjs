import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
process.env.QZONE_ECHO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-content-test-'))
const { postContent, parsePostJsonp } = await import('./lib/content.mjs')
const { normalize, fetchAll } = await import('./lib/qzone.mjs')
const store = await import('./lib/store.mjs')

// ---- 正文提取：多段 / 引号 / 反斜杠 / 末尾标点
const full = '第一段。\n第二段含有“引号”、"双引号"、\\路径与结尾。'
assert.equal(postContent({ content: full, conlist: [{ type: 2, con: '第一段。' }] }), full)
assert.equal(postContent({ content: '第一段。…', conlist: [{ type: 2, con: '第一段。\n' }, { type: 2, con: full.split('\n')[1] }] }), full)
assert.equal(postContent({ conlist: [{ type: 2, con: '第一段。\n' }, { type: 2, con: full.split('\n')[1] }], commentlist: [{ con: '不能混入评论' }] }), full)
assert.equal(postContent({ commentlist: [{ con: '不能当正文' }] }), '')

// ---- JSONP 解析：反转义 \x3c / \n
assert.equal(parsePostJsonp('_preloadCallback(' + JSON.stringify({ content: full }) + ');').content, full)
assert.equal(parsePostJsonp('_preloadCallback({"content":"\\x3c文本\\n下一行"})').content, '<文本\n下一行')

// ---- 列表预览 → 详情全文的补齐
assert.equal(normalize({ content: '开头…', conlist: [{ type: 2, con: '开头和结尾' }] }).content, '开头和结尾')

// ---- 列表页拿到的是截断，详情页补全文
const requests = []
global.fetch = async (url) => {
  requests.push(String(url))
  const detail = String(url).includes('msgdetail')
  const data = detail
    ? { code: 0, content: full, conlist: [{ type: 2, con: '第一段。' }], pic: [], created_time: 1 }
    : {
      code: 0,
      total: 1,
      msglist: requests.filter((x) => x.includes('msglist')).length === 1
        ? [{ tid: 'one', content: '第一段。…', has_more_con: 1, created_time: 1 }]
        : [],
    }
  return new Response('_preloadCallback(' + JSON.stringify(data) + ');')
}

const r = await fetchAll({}, '123456', { max: 2, sleep: 0 })
assert.equal(r.items[0].content, full)
assert.equal(r.items[0].contentSource, 'detail')

// ---- 存库：全文不许被后来的截断预览覆盖
store.mergeMoments(r.items, { owner: '123456' })
store.mergeMoments([{ tid: 'one', content: '第一段。…', contentIncomplete: true, contentSource: 'list' }], { owner: '123456' })
assert.equal(store.loadAll()[0].content, full)

// ---- 作者真改了正文（短文）时，要相信新的（不能死守旧的全文）
store.mergeMoments([{ tid: 'one', content: '作者修改后的短文', contentSource: 'detail', contentIncomplete: false }], { owner: '123456' })
assert.equal(store.loadAll()[0].content, '作者修改后的短文')

// ---- 已有全文的，不该再问一次详情接口
requests.length = 0
const cached = await fetchAll({}, '123456', {
  max: 2,
  sleep: 0,
  fullKnown: new Map([['one', { tid: 'one', content: full, contentSource: 'detail', contentIncomplete: false }]]),
})
assert.equal(cached.items[0].content, full)
assert.equal(requests.filter((x) => x.includes('msgdetail')).length, 0, '已有全文不该重复请求详情')

console.log('PASS: 正文多段/引号/反斜杠、JSONP 反转义、列表→详情补全、存库不被截断覆盖、作者改写信任新版、已有全文不重复请求')

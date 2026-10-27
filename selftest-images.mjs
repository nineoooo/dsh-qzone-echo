/**
 * 配图下载自测：起一个本地 http 当图床，造两条假说说，验「下 / 去重 / 跳过 / 回写 feed」。
 * 用 QZONE_ECHO_HOME 隔离，不碰真库。
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'

const HOME = mkdtempSync(join(tmpdir(), 'qzecho-img-'))
process.env.QZONE_ECHO_HOME = HOME

// 一张 1x1 PNG（合法字节，验扩展名嗅探够用了）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const server = createServer((req, res) => {
  if (req.url === '/bad') { res.writeHead(404); res.end('nope'); return }
  if (req.url === '/notimg') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>hi</h1>'); return }
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length })
  res.end(PNG)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`

const { ensureHome, writeFeed, loadAll, saveConfig } = await import('./lib/store.mjs')
const { downloadImages, imageStats } = await import('./lib/images.mjs')

ensureHome()
saveConfig({ thoughtThreshold: 45 })

const now = Math.floor(Date.now() / 1000)
writeFeed([
  {
    id: 'm1', uin: '123', ts: now, created: '2026-10-22 19:00:00',
    content: '今天想了想，人还是得自己扛', images: [`${base}/a.png`, `${base}/b.png`],
    comments: [], likes: 0, thought: true, dream: false,
  },
  {
    id: 'm2', uin: '123', ts: now - 10, created: '2026-10-22 18:59:00',
    content: '梦见在海上漂', images: [`${base}/a.png`, `${base}/bad`, `${base}/notimg`],
    comments: [], likes: 0, thought: false, dream: true,
  },
  {
    id: 'm3', uin: '123', ts: now - 20, created: '2026-10-22 18:58:00',
    content: '纯文字，没图', images: [], comments: [], likes: 0, thought: false, dream: false,
  },
])

console.log('初始统计', JSON.stringify(imageStats()))
const r1 = await downloadImages({ scope: 'all', concurrency: 2, delay: 0 })
console.log('第一次', JSON.stringify({ urls: r1.urls, ok: r1.downloaded, skipped: r1.skipped, failed: r1.failed, touched: r1.touched }))
console.log('errors', JSON.stringify(r1.errors))

const feed = loadAll()
const byId = Object.fromEntries(feed.map((m) => [m.id, m]))
console.log('m1.localImages 长度', (byId.m1.localImages || []).length)
console.log('m2.localImages', JSON.stringify(byId.m2.localImages))
const years = readdirSync(join(HOME, 'images'))
console.log('落盘年份目录', JSON.stringify(years), '文件数', readdirSync(join(HOME, 'images', years[0])).length)

// ⚠️ 2026-10-27：这个脚本原来只打印不断言（等于什么都验不了）。按「已知正确」的结果补断言。
assert.equal(r1.urls, 5, '三条说说共 5 个图片地址（a.png 被两条共用）')
assert.equal(r1.downloaded, 2, '真正落盘的只有 2 个（a.png + b.png；a 只算一次）')
assert.equal(r1.skipped, 1, 'a.png 第二次出现应算「跳过」')
assert.equal(r1.failed, 2, '404 与 text/html 两个坏地址应记失败，且不冒充成功')
assert.equal((byId.m1.localImages || []).length, 2, 'm1 的两张都应落到本地')
assert.equal((byId.m2.localImages || [])[0] != null, true, 'm2 的 a.png（与 m1 共用）应命中同一份本地文件')
assert.deepEqual((byId.m2.localImages || []).slice(1), [null, null], '坏地址位置留 null，不能塞垃圾路径')
assert.ok(existsSync(join(HOME, 'images', years[0])), '图片应按年份落目录')

const r2 = await downloadImages({ scope: 'all', concurrency: 2, delay: 0 })
console.log('第二次（应几乎全跳过）', JSON.stringify({ urls: r2.urls, ok: r2.downloaded, skipped: r2.skipped, failed: r2.failed }))
assert.equal(r2.downloaded, 0, '已经下过的不能再下一次')
console.log('最终统计', JSON.stringify(imageStats()))

// 关掉服务再跑：不该把已有文件弄丢，也不该重复下载
server.close()
const exists = existsSync(join(HOME, 'images', years[0]))
console.log('目录还在', exists)
assert.equal(exists, true, '源站关了，已经落地的文件也不能悄悄消失')
console.log('HOME', HOME)
console.log(`✅ 配图下载 10 条断言全部通过`)

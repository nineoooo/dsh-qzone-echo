/**
 * 存储层自测（store.mjs）—— 补上以前没测的部分：
 *   1) 导出隐私：raw / uin / lbs / secret 这类原始接口字段绝不落盘/导出
 *   2) 备份轮转：feed.before-*.jsonl 只留最新 keep 份，别的文件不碰
 *   3) 按年月筛：filterByRange 用东八区口径，和 postPeriod 一致
 *   4) 东八区时间：cnTime / fmtTime 不随宿主时区漂（跨年边界最容易错）
 *
 * ⚠️ 2026-10-28：这些以前一条测试都没有，改坏了没人知道。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'qzecho-store-'))
process.env.QZONE_ECHO_HOME = HOME

const store = await import('./lib/store.mjs')
const { ensureHome, mergeMoments, loadAll, writeFeed, exportJson, exportMarkdown, filterByRange, rotateBackups, saveConfig } = store
const { cnTime, postPeriod } = await import('./lib/writing-stats.mjs')

ensureHome()
saveConfig({ thoughtThreshold: 45, exportDir: '' })

// 北京时间 2026-01-01 00:30（UTC 还是 2025-12-31 16:30）——用它验证东八区不漂
const TS_NEWYEAR = Math.floor(new Date('2026-01-01T00:30:00+08:00').getTime() / 1000)

const mk = (tid, content, extra = {}) => ({
  tid, content, ts: TS_NEWYEAR, time: new Date(TS_NEWYEAR * 1000).toISOString(),
  images: [], comments: [], forwarded: null, source: '', ...extra,
})

// ---- ① 原始接口字段必须被剥掉
mergeMoments([
  mk('A1', '这是一条正常说说，用来验证导出隐私。', {
    // 模拟「列表接口没洗干净」脏数据的各种隐私字段
    uin: '1000000001',
    lbs: '北京市朝阳区某路某号',
    secret: 'S3cr3tT0ken',
    wbid: 'wb-123',
    alive: 1,
    verifiedAt: '2026-10-01T00:00:00Z',
    raw: { huge: 'raw json' },
    // deAt 之前的原文：`@{uin:...,nick:...}` 内嵌码里带着别人的 QQ 号
    rawContent: '@{uin:1000000001,nick:张三,who:1,auto:1}这是一条正常说说',
    conlist: [{ type: 2, con: '原文' }],
    has_more_con: 1,
    name: '张三',
  }),
], { owner: '1000000001' })

// writeFeed 落盘也要剥
writeFeed(loadAll())
const onDisk = loadAll()[0]
for (const f of ['uin', 'lbs', 'secret', 'wbid', 'alive', 'verifiedAt', 'raw', 'conlist', 'has_more_con', 'name', 'rawContent']) {
  assert.equal(onDisk[f], undefined, `落盘不能有隐私/死字段：${f}`)
}
console.log('① 落盘隐私字段已剥净')

// exportJson 也不能带
const jr = exportJson(loadAll())
const parsed = JSON.parse(readFileSync(jr.file, 'utf8'))
assert.equal(parsed.length, 1)
for (const f of ['uin', 'lbs', 'secret', 'wbid', 'alive', 'verifiedAt', 'raw']) {
  assert.equal(parsed[0][f], undefined, `exportJson 不能带 ${f}`)
}
console.log('② exportJson 隐私字段已剥净')

// ---- ③ 东八区：跨年那条必须算 2026
assert.equal(cnTime(TS_NEWYEAR).year, 2026, '东八区 2026-01-01 00:30 必须是 2026')
assert.equal(cnTime(TS_NEWYEAR).month, 1)
assert.equal(cnTime(TS_NEWYEAR).date, 1)
assert.equal(postPeriod({ ts: TS_NEWYEAR }).year, '2026')
assert.equal(postPeriod({ ts: TS_NEWYEAR }).month, '2026-01')
console.log('③ 东八区跨年边界正确（2026-01-01 00:30 → 2026）')

// ---- ④ filterByRange
const all = loadAll()
assert.equal(filterByRange(all, {}).length, 1, '不传范围应原样返回')
assert.equal(filterByRange(all, { year: 2026 }).length, 1, '2026 应命中')
assert.equal(filterByRange(all, { year: 2025 }).length, 0, '2025 不该命中（UTC 口径会误判成 2025）')
assert.equal(filterByRange(all, { month: '2026-01' }).length, 1, '2026-01 应命中')
assert.equal(filterByRange(all, { month: '2026-02' }).length, 0)
console.log('④ filterByRange 按东八区年月筛正确')

// ---- ⑤ 导出文件名带年月，范围对得上
const mr = exportMarkdown(filterByRange(all, { year: 2026 }), { onlyThoughts: false, year: 2026 })
assert.ok(mr.file.endsWith('.md'), '应导出 md')
assert.ok(mr.count === 1, '范围导出条数应为 1')
assert.ok(/-2026-/.test(mr.file), '文件名应带年份标记')
const mrMonth = exportMarkdown(all, { year: 2026, month: '2026-01' })
assert.ok(/-2026-01-/.test(mrMonth.file), '文件名应带年月标记')
console.log('⑤ 导出文件名与范围一致')

// ---- ⑥ 备份轮转：同类只留 keep 份，别的文件不碰
const makeBackup = (tag, ts) => {
  const f = join(HOME, `feed.before-${tag}-${ts}.jsonl`)
  writeFileSync(f, '{"x":1}\n')
  return f
}
const longtext = [makeBackup('longtext-repair', 1700000000001), makeBackup('longtext-repair', 1700000000002), makeBackup('longtext-repair', 1700000000003), makeBackup('longtext-repair', 1700000000004)]
const imageRep = [makeBackup('image-repair', 1700000000001), makeBackup('image-repair', 1700000000002)]
// 这个不该被轮转（后缀不是 13 位时间戳）
const keepMe = join(HOME, 'feed.before-manual.jsonl')
writeFileSync(keepMe, 'x')
const unrelated = join(HOME, 'notes.txt')
writeFileSync(unrelated, 'x')

const removed = rotateBackups(HOME, 2)
assert.equal(removed, 2, '两个前缀共超 2 份 → 应删 2 份（longtext 4→2）')
for (const f of longtext) {
  const name = f.replace(/^.*[\\/]/, '')
  const idx = Number(name.match(/-(\d{13})\.jsonl$/)?.[1])
  const kept = existsSync(f)
  if (idx <= 1700000000002) assert.equal(kept, false, `旧备份 ${name} 应被删`)
  else assert.equal(kept, true, `新备份 ${name} 应保留`)
}
assert.equal(existsSync(imageRep[0]), true, 'image-repair 只 2 份，应全留')
assert.equal(existsSync(imageRep[1]), true)
assert.equal(existsSync(keepMe), true, '不符合命名规则的文件绝不能删')
assert.equal(existsSync(unrelated), true, '无关文件绝不能删')
console.log('⑥ 备份轮转只删自己造的旧备份')

// ---- ⑦ persistable 不动业务字段
mergeMoments([mk('A2', '转发测试', {
  forwarded: { name: '原贴作者', content: '原贴内容' },
  share: { name: '某视频', url: 'https://x/y' },
})], { owner: '1000000001' })
const fwd = loadAll().find((m) => String(m.tid) === 'A2')
assert.equal(fwd.forwarded.name, '原贴作者', 'forwarded.name 是业务字段，不能被当隐私删')
assert.equal(fwd.share.name, '某视频', 'share.name 是业务字段，不能被当隐私删')
console.log('⑦ 嵌套业务字段未被误删')

// ---- ⑧ 评论/回复里那份带 @ 内嵌码的 raw 也不许进导出文件
mergeMoments([mk('A3', '带评论的说说', {
  comments: [
    { uin: '111', name: '甲', content: '好的！', raw: '@{uin:222,nick:乙,who:1,auto:1}好的！', time: '2026-01-01 10:00', replies: [] },
    { uin: '333', name: '', content: '回复内容', raw: '回复内容', time: '2026-01-01 10:05', replies: [
      { uin: '444', name: '丁', content: '再回复', raw: '@{uin:333,nick:,who:1,auto:1}再回复', time: '2026-01-01 10:06', replies: [] },
    ] },
  ],
})], { owner: '1000000001' })

const jr2 = exportJson(loadAll())
const parsed2 = JSON.parse(readFileSync(jr2.file, 'utf8'))
const withCmt = parsed2.find((m) => String(m.tid) === 'A3')
assert.ok(withCmt, '带评论那条应在导出里')
for (const c of withCmt.comments) {
  assert.equal(c.raw, undefined, '评论的 raw（含别人 QQ 号）不能进导出')
  for (const r of c.replies || []) assert.equal(r.raw, undefined, '回复的 raw 不能进导出')
}
// 但 uin 要留着：同名的两个人只靠它区分
assert.equal(withCmt.comments[0].uin, '111', '评论 uin 仍保留（区分同名）')
assert.equal(withCmt.comments[0].content, '好的！', '评论正文不能被改')
console.log('⑧ 导出剥掉评论 raw，保留 uin 与正文')

console.log('✅ 存储层 8 组断言全部通过')

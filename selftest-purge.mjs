/**
 * 多号隔离 + 按号删除自测：
 *   1) 两个号各同步一批 → 库里有 owner、id 带前缀、互不覆盖
 *   2) 同 tid 不同号 → 不互撞（这是加 owner 的原因）
 *   3) purgeOwner 默认只预演，apply 才真删，删完 thoughts/dreams 跟着重算
 *   4) 被删的那号独占的配图文件也清掉，两个号共用的图保留
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'qzecho-multi-'))
process.env.QZONE_ECHO_HOME = HOME

const { ensureHome, mergeMoments, loadAll, loadThoughts, loadDreams, purgeOwner, owners, saveConfig } = await import('./lib/store.mjs')

ensureHome()
saveConfig({ thoughtThreshold: 45 })

const t = (n) => Math.floor(Date.now() / 1000) - n
const mk = (tid, content, extra = {}) => ({
  tid, content, ts: t(10), time: new Date().toISOString(), images: [], comments: [], forwarded: null, source: '', ...extra,
})

// ① 两个号，故意让 tid 撞车（模拟不同号出现同一个 tid）
mergeMoments([
  mk('T1', '我觉得自己一直在逃避，承认这一点反而轻松了。'),
  mk('T2', '今天天气不错，出门走了走，看到路边花开。'),
], { owner: '111' })
mergeMoments([
  mk('T1', '梦见在很深的海里往下沉，一点也不害怕。'),
  mk('T2', '做梦梦到考试，卷子一个字没写。'),
  mk('T3', '转发送会员，速来'),
], { owner: '222' })

const all = loadAll()
console.log('总数', all.length, '（应为 5，T1 在两个号各一条、不互撞）')
console.log('owners', JSON.stringify(owners()))
const ids = all.map((m) => m.id)
console.log('id 前缀', JSON.stringify(ids.slice(0, 3)))
console.log('T1 撞车检查:', all.filter((m) => String(m.tid) === 'T1').length, '条（应为 2）')

console.log('思考', loadThoughts().length, '梦记', loadDreams().length)

// ② 预演不该动数据
writeFileSync(join(HOME, 'marker.txt'), 'x')
const dry = purgeOwner('222')
console.log('预演', JSON.stringify({ matched: dry.matched, remaining: dry.remaining, apply: dry.apply }))
console.log('预演后总数仍为', loadAll().length, '（应为 5）')

// ③ 真删 —— 顺便造两个配图文件（一个 222 独占，一个 111/222 共用）
const imgDir = join(HOME, 'images', '2026')
mkdirSync(imgDir, { recursive: true })
const only222 = join(imgDir, 'only222.jpg')
const shared = join(imgDir, 'shared.jpg')
writeFileSync(only222, 'a')
writeFileSync(shared, 'b')
const feed = loadAll()
for (const m of feed) {
  if (m.owner === '222' && m.tid === 'T1') m.localImages = [only222, shared]
  if (m.owner === '111' && m.tid === 'T2') m.localImages = [shared]
}
const { writeFeed } = await import('./lib/store.mjs')
writeFeed(feed)

const real = purgeOwner('222', { apply: true })
console.log('真删', JSON.stringify({ matched: real.matched, remaining: real.remaining, removedImages: real.removedImages }))
console.log('剩', loadAll().length, '（应为 2，全是 111）')
console.log('owners 剩', JSON.stringify(owners()))
console.log('思考', loadThoughts().length, '梦记', loadDreams().length, '（梦记应为 0，222 的梦都删了）')
console.log('共用图还在', existsSync(shared), '独占图已删', !existsSync(only222))

// ④ 删不存在的号
const none = purgeOwner('999', { apply: true })
console.log('删不存在的号', JSON.stringify({ matched: none.matched, ok: none.ok, note: none.note }))

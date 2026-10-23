// 自测：分类 + 入库 + 阈值重算 + 导出（不碰网络、不碰真家目录）
process.env.QZONE_ECHO_HOME = process.env.TEMP + '/qzecho-selftest'
const { rmSync } = await import('node:fs')
try { rmSync(process.env.QZONE_ECHO_HOME, { recursive: true, force: true }) } catch {}

const { classify, scoreAll, isThought, isDream } = await import('./lib/classify.mjs')
const store = await import('./lib/store.mjs')
const { normalize } = await import('./lib/qzone.mjs')
const sync = await import('./lib/sync.mjs')

const samples = [
  { tid: 'a1', created_time: 1600000000, content: '今天终于想明白了，其实我一直害怕的不是失败，是别人觉得我不行。这一点承认下来之后反倒轻松了很多。' },
  { tid: 'a2', created_time: 1600000100, content: '转发抽奖！关注+转发有机会获得京东卡一张，戳链接参与' },
  { tid: 'a3', created_time: 1600000200, content: '', pic: [{ url1: 'http://x/1.jpg' }, { url1: 'http://x/2.jpg' }] },
  { tid: 'a4', created_time: 1600000300, content: '晚安' },
  { tid: 'a5', created_time: 1600000400, content: '岁月你别催，该来的我不推', rt_con: { name: '某人', content: '岁月你别催，该来的我不推，走远的我不追，我不过是想弄清楚自己到底想要什么，别的都是别人的答案' } },
  { tid: 'a6', created_time: 1600000500, content: '最近总觉得时间过得好快，好像才刚开学就已经到期末了。以前盼着长大，现在又希望慢一点。' },
  // --- 梦记样本 ---
  { tid: 'd1', created_time: 1600000600, content: '梦见自己在一片海上走，脚底下是透明的，鱼从脚边游过去。' },
  { tid: 'd2', created_time: 1600000700, content: '又做梦了，梦里回到了高中教室，黑板上的字一直在变。' },
  { tid: 'd3', created_time: 1600000800, content: '做梦' },
  { tid: 'd4', created_time: 1600000900, content: '梦想还是要有的，万一实现了呢' },   // 不算梦记
  { tid: 'd5', created_time: 1600001000, content: '为了梦想努力奋斗，今天又加班到十点' }, // 不算梦记
  { tid: 'd6', created_time: 1600001100, content: '昨晚睡到半夜突然醒了，想起梦里有人一直在喊我名字。' }, // 松散梦
]

const scored = scoreAll(samples.map(normalize))
for (const s of scored) {
  console.log(`${s.tid}  score=${String(s.score).padStart(3)}  kind=${s.kind.padEnd(8)} thought=${isThought(s) ? 'Y' : 'n'}  dream=${isDream(s) ? 'Y' : 'n'}  ${s.reasons.join(' | ').slice(0, 80)}`)
}

store.ensureHome()
const merged = store.mergeMoments(scored)
console.log('\n入库：', JSON.stringify({ added: merged.added, total: merged.total }))
const all = store.loadAll()
console.log('feed 里 thought 标记：', all.map((m) => `${m.tid}:${m.thought ? 'Y' : 'n'}`).join(' '))

let rec = store.recomputeThoughts(45)
console.log('阈值 45 →', JSON.stringify(rec), 'thoughts.jsonl 条数 =', store.loadThoughts().length)

// 阈值调到 80：只剩 a1
rec = store.recomputeThoughts(80)
console.log('阈值 80 →', JSON.stringify(rec), 'thoughts.jsonl 条数 =', store.loadThoughts().length)

// 调回 45
rec = store.recomputeThoughts(45)
console.log('阈值 45 →', JSON.stringify(rec), 'thoughts.jsonl 条数 =', store.loadThoughts().length)

const md = store.exportMarkdown(store.loadThoughts(), { onlyThoughts: true })
console.log('\nmd ->', JSON.stringify(md))
console.log('json ->', JSON.stringify(store.exportJson(all)))

// 梦记那一栏：单独一份
console.log('\n梦记条数 =', store.loadDreams().length)
const mdDreams = store.exportMarkdown(store.loadDreams(), { onlyDreams: true })
console.log('梦 md ->', JSON.stringify(mdDreams))

console.log('\n=== stats ===')
console.log(JSON.stringify(sync.stats(), null, 2))

const again = store.mergeMoments(scored)
console.log('\n二次合并（应 added=0）:', JSON.stringify({ added: again.added, updated: again.updated, total: again.total }))

console.log('\n=== applyThreshold(60) ===')
console.log(JSON.stringify(sync.applyThreshold(60)))

// 导出的 Markdown 真的写出来了吗
const { readFileSync } = await import('node:fs')
const txt = readFileSync(md.file, 'utf8')
console.log('\n--- Markdown 前 24 行 ---')
console.log(txt.split('\n').slice(0, 24).join('\n'))

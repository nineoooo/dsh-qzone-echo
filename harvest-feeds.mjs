/**
 * 慢速采「历史消息列表」（feeds2_html_pav_all），把本地库没有的条目收集成
 * 「疑似已删除」候选，落到 $QZONE_ECHO_HOME/harvest.jsonl，**不直接写 feed.jsonl**。
 *
 * 为什么要慢：这个接口密度一高就回 HTTP 501 + waf.tencent.com 拦截页，
 * 实测冷却期 > 6 分钟。所以默认每页隔 3.5 秒、每 15 页歇 1 分钟。
 *
 * 用法（PATH 里没有 node，必须用宿主自带的 node）：
 *   ELECTRON_RUN_AS_NODE=1 "E:/DEEPSEEK/DeepSeek Harness.exe" harvest-feeds.mjs
 *   ... harvest-feeds.mjs --max-offset 12000 --count 100
 *
 * 断点：$QZONE_ECHO_HOME/harvest.json 的 nextOffset，天然续跑。
 */
import { readFileSync, writeFileSync, appendFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseCookieText, warmUp, cookieHeader, UA } from './lib/qzone.mjs'
import { homeDir, ensureHome, loadAll } from './lib/store.mjs'
import { fetchHistoryPage, parseHistoryHtml } from './lib/history.mjs'

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def
}

const COUNT = Math.min(100, Number(argOf('count', 100)) || 100)
const PAGE_GAP = Number(argOf('gap', 3500)) || 3500
const REST_EVERY = Number(argOf('rest-every', 15)) || 15
const REST_MS = Number(argOf('rest-ms', 60000)) || 60000
const WAF_WAIT = Number(argOf('waf-wait', 300000)) || 300000
const WAF_MAX = Number(argOf('waf-max', 3)) || 3
const MAX_OFFSET = Number(argOf('max-offset', 20000)) || 20000
const MAX_PAGES = Number(argOf('max-pages', 400)) || 400

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

const home = () => ensureHome().home
const stateFile = () => join(home(), 'harvest.json')
const outFile = () => join(home(), 'harvest.jsonl')

function loadState() {
  try { return JSON.parse(readFileSync(stateFile(), 'utf8')) } catch { return {} }
}
function saveState(s) {
  try {
    const f = stateFile(); const tmp = `${f}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    renameSync(tmp, f)
  } catch { /* 记不上不影响抓取 */ }
}

// ---------------------------------------------------------------- 主流程
const credPath = join(home(), 'credential.json')
if (!existsSync(credPath)) {
  console.error('没有 credential.json，先去设置页贴一次 Cookie')
  process.exit(2)
}
const cred = JSON.parse(readFileSync(credPath, 'utf8'))
const jar = parseCookieText(cred.cookie || cred.cookieText || '')
const uin = String(cred.uin || '')
if (!uin) { console.error('credential.json 里没有 uin'); process.exit(2) }

console.log(`号 ${uin}，Cookie ${Object.keys(jar).length} 个字段；先热身…`)
const warmed = await warmUp(jar, uin)
Object.assign(jar, warmed)

// 拿本地库当对照：只有「本地没有的真 tid」才是候选
const local = loadAll()
const localTids = new Set(local.filter((m) => !m.recovered && m.tid).map((m) => String(m.tid)))
console.log(`本地库 ${local.length} 条，其中可用真 tid ${localTids.size} 个`)

const st = loadState()
let offset = Number(st.nextOffset) || 0
let pages = Number(st.pages) || 0
let collected = Number(st.collected) || 0
let fresh = Number(st.fresh) || 0
let wafHits = 0
let restCount = 0
let stopReason = ''

console.log(`从 offset=${offset} 开始，每页 ${COUNT} 条，页间隔 ${PAGE_GAP}ms`)
const t0 = Date.now()

while (pages < MAX_PAGES && offset < MAX_OFFSET) {
  const r = await fetchHistoryPage(jar, uin, offset, COUNT)

  if (!r.ok) {
    const isWaf = /WAF|501/i.test(String(r.error || ''))
    const isLogin = r.needLogin || /登录/.test(String(r.error || ''))
    if (isLogin) { stopReason = `登录态无效：${r.error}`; break }
    if (isWaf) {
      wafHits += 1
      if (wafHits > WAF_MAX) { stopReason = `连续 ${WAF_MAX} 次被 WAF 拦，先收工（断点已存）`; break }
      console.log(`  ⚠️ WAF（第 ${wafHits} 次），等 ${Math.round(WAF_WAIT / 1000)} 秒…`)
      await sleep(WAF_WAIT)
      continue
    }
    console.log(`  出错停在 offset=${offset}：${r.error}（断点已存，下次接着来）`)
    stopReason = String(r.error || '出错')
    break
  }

  wafHits = 0
  const items = parseHistoryHtml(r.html, { owner: uin })
  const unique = new Map()
  for (const it of items) {
    if (!it.originalTid) continue
    if (!unique.has(it.originalTid)) unique.set(it.originalTid, it)
  }
  const freshOnes = [...unique.values()].filter((it) => !localTids.has(String(it.originalTid)))

  pages += 1
  collected += unique.size
  fresh += freshOnes.length

  if (freshOnes.length) {
    const lines = freshOnes.map((it) => JSON.stringify({
      tid: it.originalTid,
      uin: it.originalOwner,
      snippet: it.snippet,
      images: it.images,
      interactor: it.interactor,
      eventTs: it.eventTs,
      timeRaw: it.timeRaw,
    })).join('\n') + '\n'
    appendFileSync(outFile(), lines, 'utf8')
  }

  console.log(`  第 ${pages} 页 offset=${offset}：条目 ${items.length} / 唯一 ${unique.size} / 本地没有 ${freshOnes.length}（累计 ${fresh}）`)

  offset += COUNT
  saveState({ uin, nextOffset: offset, pages, collected, fresh, lastAt: new Date().toISOString() })

  // 空页 = 服务端到底了
  if (items.length === 0) { stopReason = '到底了（空页）'; break }

  if (REST_EVERY > 0 && ++restCount >= REST_EVERY) {
    restCount = 0
    console.log(`  …歇 ${Math.round(REST_MS / 1000)} 秒`)
    await sleep(REST_MS)
  } else {
    await sleep(PAGE_GAP)
  }
}

saveState({
  uin, nextOffset: offset, pages, collected, fresh, wafHits,
  lastAt: new Date().toISOString(),
  ...(stopReason ? { doneAt: new Date().toISOString(), stopReason } : {}),
})

console.log('\n================ 本轮结果 ================')
console.log(`翻了 ${pages} 页，拿到唯一 tid ${collected} 个，本地没有的 ${fresh} 个`)
console.log(`停在 offset=${offset}${stopReason ? `（${stopReason}）` : ''}`)
console.log(`用时 ${Math.round((Date.now() - t0) / 1000)} 秒`)
console.log(`候选写进：${outFile()}`)
console.log('⚠️ 这些只是「候选」，不等于已删除；要拿 tid 去 msgdetail 逐条验活才算数。')

/**
 * lib/sync.mjs —— 一次同步的完整流程：读凭证 → 热身 → 翻页 → 分类 → 入库 → （可选）导出
 * ============================================================================
 * 全部逻辑都在这里，host 半端只负责「注册工具 + 挂 HTTP 路由 + 定时器」。
 * ============================================================================
 */
import { classify, scoreAll, isThought, isDream, isReview } from './classify.mjs'
import { parseCookieText, extractUin, fetchAll, warmUp, HOSTS } from './qzone.mjs'
import {
  getConfig, saveConfig, getCredential, saveCredential, mergeMoments, writeThoughts, writeDreams,
  recomputeThoughts, loadAll, loadThoughts, loadDreams, exportMarkdown, logLine, ensureHome, owners,
  readJson, writeJson, writeFeed,
} from './store.mjs'
import { join } from 'node:path'

/** 撞 WAF 时的换入口次序：主域名硬封就换 h5 / mobile（同一代理，只会限流不会 501） */
const HOST_FALLBACK = [HOSTS.main, HOSTS.h5, HOSTS.mobile]

/** 用已保存的 Cookie 拿到一个可用的会话（含热身后的 cookie、uin、gtk） */
export async function openSession({ cookieText = '', warm = true, timeout = 25000 } = {}) {
  let text = cookieText
  if (!text) {
    const cred = getCredential()
    if (!cred) {
      return { ok: false, needCookie: true, error: '还没有 Cookie。去设置页「QQ说说收集」里粘贴一次，或用 qzone_echo_login 工具。' }
    }
    text = cred.cookie || ''
  }
  const jar = parseCookieText(text)
  const uin = extractUin(jar)
  if (!uin) {
    return { ok: false, needCookie: true, error: 'Cookie 里找不到 uin（形如 uin=o0123456789）—— 复制的时候漏了？' }
  }
  const hasKey = Boolean(jar.p_skey || jar.skey || jar.sk)
  if (!hasKey) {
    return {
      ok: false,
      needCookie: true,
      error: 'Cookie 里没有 p_skey / skey —— 空间接口算不出 g_tk，必须带上它。请在浏览器登录 QQ 空间后，'
        + '从 user.qzone.qq.com 的请求头里完整复制整段 Cookie。',
    }
  }
  const warmed = warm ? await warmUp(jar, uin, { timeout }) : jar
  return { ok: true, jar: warmed, uin, cookieText: text }
}

/**
 * 同步一次。
 * @param {object} opts
 * @param {string} [opts.cookieText] 一次性用这个 Cookie（不落盘）
 * @param {number} [opts.max]        这次最多收多少条
 * @param {boolean}[opts.export]     结束后导出 Markdown
 * @returns {Promise<object>}
 */
/** '2021-06' / '2021-6' / '202106' → { from, to }（本地时区，秒级时间戳；含头不含尾） */
export function monthRange(month) {
  const s = String(month || '').trim()
  const m = /^(\d{4})[-_/]?(\d{1,2})$/.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  if (!(y >= 2003 && y <= 2100) || mo < 1 || mo > 12) return null
  const from = new Date(y, mo - 1, 1, 0, 0, 0, 0)
  const to = new Date(y, mo, 1, 0, 0, 0, 0)
  return {
    month: `${y}-${String(mo).padStart(2, '0')}`,
    from: Math.floor(from.getTime() / 1000),
    to: Math.floor(to.getTime() / 1000),
  }
}

/** 库里已有说说的 tid 集合（增量模式的「收过没」判据） */
function knownTids(uin) {
  const set = new Set()
  for (const m of loadAll()) {
    if (m.owner && String(m.owner) !== String(uin)) continue
    if (m.tid) set.add(m.tid)
  }
  return set
}

/**
 * 同步一次。
 * @param {object} opts
 * @param {string} [opts.cookieText] 一次性用这个 Cookie（不落盘）
 * @param {number} [opts.max]        这次最多收多少条
 * @param {boolean}[opts.export]     结束后导出 Markdown
 * @param {string} [opts.month]      只收某一个月（'2021-06'）—— 接口不支持按月，客户端切
 * @param {boolean}[opts.incremental] 增量：只要比库里最新的还新的（或没见过的）
 * @param {boolean}[opts.auto]       定时器触发（只记日志，不改导出行为）
 * @returns {Promise<object>}
 */
export async function syncOnce(opts = {}) {
  ensureHome()
  const cfg = getConfig()
  const sess = await openSession({ cookieText: opts.cookieText })
  if (!sess.ok) return sess

  const max = Number(opts.max) || cfg.maxPerSync || 1000
  const pageSize = Number(opts.pageSize) || cfg.pageSize || 40
  const pages = []

  // ---- 时间窗：按月 或 增量 ----
  let since = 0
  let until = 0
  let known = null
  let stopWhenKnown = false
  let month = null
  if (opts.month) {
    const r = monthRange(opts.month)
    if (!r) return { ok: false, error: `月份看不懂：「${opts.month}」，写成 2021-06 这样` }
    month = r.month
    since = r.from
    until = r.to
  } else if (opts.incremental) {
    const mine = loadAll().filter((m) => !m.owner || String(m.owner) === String(sess.uin))
    const newest = mine.reduce((a, m) => Math.max(a, Number(m.ts) || 0), 0)
    // 往回多看一天：空间时间戳是「发表时间」，同一条可能被服务器改过；留点缓冲不吃亏
    since = newest ? newest - 24 * 3600 : 0
    known = knownTids(sess.uin)
    stopWhenKnown = true
  }

  const r = await fetchAll(sess.jar, sess.uin, {
    pageSize,
    max,
    fullKnown: new Map(loadAll().filter(m => !m.owner || String(m.owner) === String(sess.uin)).map(m => [m.tid, m])),
    since,
    until,
    known,
    stopWhenKnown,
    // startPos：从第几条开始翻。已经到 2024 年的库想再往前挖（2023/2022…），
    // 从 0 开始等于把已有的几千条重翻一遍，既慢又白白多撞腾讯限流。
    startPos: Number(opts.startPos) || 0,
    // 换入口：主域名被 WAF 硬封（501）时，h5 / mobile 是同一个代理但不会被 WAF 拦（只会限流），
    // 慢速磨历史时这条软着陆路径实测可用。
    host: opts.host || undefined,
    hosts: Array.isArray(opts.hosts) ? opts.hosts : HOST_FALLBACK,
    // 页间隔：慢速磨的时候调大（默认 600ms 是「快跑」用的），免得又把限流踩出来
    sleep: opts.sleep != null ? Number(opts.sleep) : undefined,
    // 空页重试：深翻时接口会间歇性回空页（code=0 但 msglist 空），不认它
    emptyRetries: opts.emptyRetries != null ? Number(opts.emptyRetries) : 3,
    onPage: (info) => pages.push(info),
  })
  if (!r.ok) return { ok: false, error: r.error || r.message, needCookie: r.needLogin, uin: sess.uin, pagesFetched: pages.length }

  const scored = scoreAll(r.items)
  const th = Number(cfg.thoughtThreshold) || 45
  for (const m of scored) delete m.raw

  const merged = mergeMoments(scored, { owner: sess.uin })
  // thoughts / dreams 用「全库重算」保证跟最新阈值一致（换了分数线也不会跟旧结论打架）
  const rec = recomputeThoughts(th)
  const thoughts = loadThoughts()
  const dreams = loadDreams()

  let exported = null
  let exportedDreams = null
  if (opts.export ?? cfg.autoExport) {
    // 一栏一份：思考一份、梦记一份，各写各的
    try { exported = exportMarkdown(thoughts, { onlyThoughts: true }) } catch { /* 导出失败不影响同步 */ }
    try { if (dreams.length) exportedDreams = exportMarkdown(dreams, { onlyDreams: true }) } catch { /* 同上 */ }
  }

  // 配图（可选，默认关）：同步完顺手把还没落地的图拉下来
  let images = null
  if (cfg.autoDownloadImages) {
    try {
      const { downloadImages } = await import('./images.mjs')
      images = await downloadImages({ scope: 'all' })
    } catch (e) { images = { ok: false, error: e?.message || String(e) } }
  }

  const scopeTag = month ? `（${month}）` : (opts.incremental ? '（增量）' : '')
  const fromPos = Number(opts.startPos) || 0
  const posTag = fromPos ? `从第 ${fromPos} 条起` : ''
  // ⚠️ partial：翻到一半被 500 / 超时 / 限流打断，但手里的几百条照样入库 —— 绝不能整趟丢
  const partTag = r.partial ? `【中途停：${r.stopped}】` : ''
  const line = `同步 ${sess.uin}${scopeTag}${posTag}${partTag}：抓 ${r.items.length} 条（${r.pages} 页），跳过 ${r.skipped || 0}，`
    + `新增 ${merged.added}，更新 ${merged.updated}，库 ${merged.total}，思考 ${thoughts.length}，梦 ${dreams.length}`
    + (r.items.some(m => m.contentIncomplete) ? `，长文待补 ${r.items.filter(m => m.contentIncomplete).length} 条（下次同步重试）` : '')
  logLine(line)
  if (opts.auto) logAutoRun({ ok: true, added: merged.added, fetched: r.items.length, total: merged.total, message: line })

  return {
    ok: true,
    uin: sess.uin,
    month: month || null,
    incremental: Boolean(opts.incremental),
    contentPending: r.items.filter(m => m.contentIncomplete).length,
    fetched: r.items.length,
    pages: r.pages,
    skipped: r.skipped || 0,
    // 中途停（500/超时/限流）时，上层要能说清「没到底，接着再来」
    partial: Boolean(r.partial),
    stopped: r.stopped || null,
    // nextPos：下一次从这个位置接着翻（只在中途停时有意义，接着踩不会重翻已有的）
    nextPos: r.partial ? (r.nextPos ?? null) : null,
    startPos: fromPos,
    // host：这一趟实际用的是哪个入口（主域名被 WAF 时会自动落到 h5/mobile）
    host: r.host || null,
    waf: Boolean(r.waf),
    throttled: Boolean(r.throttled),
    added: merged.added,
    updated: merged.updated,
    total: merged.total,
    thoughts: thoughts.length,
    dreams: dreams.length,
    threshold: th,
    exported: exported?.file || null,
    exportedDreams: exportedDreams?.file || null,
    images: images ? { downloaded: images.downloaded, skipped: images.skipped, failed: images.failed } : null,
    message: line,
  }
}

// ---------------------------------------------------------------- 自动增量

const AUTO_FILE = () => join(ensureHome().home, 'auto.json')

/** 自动同步的记账（给设置页看「上次什么时候跑的、收了几条」） */
export function autoState() {
  const cfg = getConfig()
  const s = readJson(AUTO_FILE(), null) || {}
  return {
    enabled: Boolean(cfg.autoSync),          // 开关的真身在 config.json，auto.json 只记账
    everyHours: Number(cfg.syncEveryHours) || 6,
    lastRunAt: s.lastRunAt || null,
    lastAdded: Number(s.lastAdded) || 0,
    lastFetched: Number(s.lastFetched) || 0,
    runs: Array.isArray(s.runs) ? s.runs : [],
  }
}

function writeAutoState(patch) {
  const next = { ...autoState(), ...(patch || {}) }
  try { writeJson(AUTO_FILE(), next) } catch { /* 记不上不影响同步 */ }
  return next
}

function logAutoRun(rec) {
  const st = autoState()
  const runs = [{ at: new Date().toISOString(), ...rec }, ...(st.runs || [])].slice(0, 20)
  writeAutoState({ lastRunAt: new Date().toISOString(), lastAdded: rec.added || 0, lastFetched: rec.fetched || 0, runs })
}

/**
 * 自动增量同步的"该不该跑"判断 —— 由 host 每分钟跳一次的定时器调用。
 * ⚠️ 定时器回调必须自己兜住异常：插件出错只该"这一轮没跑成"，绝不能杀宿主
 *    （2026-10-22 bili-scroll 那边就是这么把 DSH 带崩过一次）。
 */
export function shouldAutoRun(now = new Date()) {
  const cfg = getConfig()
  if (!cfg.autoSync) return { run: false, why: '自动同步关着' }
  const everyH = Math.max(1, Number(cfg.syncEveryHours) || 6)
  const st = autoState()
  const last = st.lastRunAt ? Date.parse(st.lastRunAt) : 0
  if (last && now.getTime() - last < everyH * 3600 * 1000) {
    const next = new Date(last + everyH * 3600 * 1000)
    return { run: false, why: `还没到点（下次 ${next.toLocaleString('zh-CN')}）`, nextAt: next.toISOString() }
  }
  return { run: true, why: last ? '到点了' : '还没跑过' }
}

/** 自动跑一轮（只增量，不乱动导出） */
export async function autoSyncOnce() {
  const gate = shouldAutoRun()
  if (!gate.run) return { ok: true, skipped: true, why: gate.why }
  try {
    const r = await syncOnce({ incremental: true, auto: true })
    if (!r.ok) {
      logLine(`自动同步失败：${r.error || r.message || '未知'}`)
      logAutoRun({ ok: false, added: 0, fetched: 0, total: 0, message: r.error || r.message || '' })
      return r
    }
    return r
  } catch (e) {
    const msg = e?.message || String(e)
    logLine(`自动同步崩了：${msg}`)
    logAutoRun({ ok: false, added: 0, fetched: 0, total: 0, message: msg })
    return { ok: false, error: msg }
  }
}

/** 只存 Cookie（顺手校验一下能不能用） */
export async function saveCookie(cookieText, { verify = true } = {}) {
  const jar = parseCookieText(cookieText)
  const uin = extractUin(jar)
  if (!uin) return { ok: false, error: '这段 Cookie 里没有 uin=o0xxxx，看起来不是空间用的那份。' }
  if (!(jar.p_skey || jar.skey || jar.sk)) {
    return { ok: false, error: '缺少 p_skey / skey，接口算不出 g_tk —— 请从 user.qzone.qq.com 的请求头整段复制。' }
  }
  saveCredential(cookieText, uin)
  if (!verify) return { ok: true, uin, verified: false }
  const sess = await openSession({ cookieText })
  if (!sess.ok) return { ok: false, uin, error: sess.error, saved: true }
  const probe = await syncProbe(sess)
  return { ok: probe.ok, uin, saved: true, verified: probe.ok, probe }
}

async function syncProbe(sess) {
  const { fetchPage } = await import('./qzone.mjs')
  const p = await fetchPage(sess.jar, sess.uin, 0, 5)
  if (!p.ok) return { ok: false, error: p.message }
  return { ok: true, total: p.total, sample: (p.items || []).slice(0, 1).map((x) => String(x?.content || '').slice(0, 40)) }
}

/** 状态一览（给工具和设置页用） */
export function stats() {
  const th = Number(getConfig().thoughtThreshold) || 45
  const all = loadAll()
  const dreams = all.filter((m) => isDream(m))
  const thoughts = all.filter((m) => isThought(m, th))
  const reviews = all.filter((m) => isReview(m))
  const years = {}
  const dreamYears = {}
  for (const m of all) {
    const y = m.ts ? new Date(m.ts * 1000).getFullYear() : 0
    years[y] = (years[y] || 0) + 1
  }
  for (const m of dreams) {
    const y = m.ts ? new Date(m.ts * 1000).getFullYear() : 0
    dreamYears[y] = (dreamYears[y] || 0) + 1
  }
  return {
    total: all.length,
    thoughts: thoughts.length,
    dreams: dreams.length,
    reviews: reviews.length,
    threshold: th,
    owners: owners(),
    first: all.length ? new Date(Math.min(...all.map((m) => m.ts || Infinity)) * 1000).toISOString().slice(0, 10) : null,
    last: all.length ? new Date(Math.max(...all.map((m) => m.ts || 0)) * 1000).toISOString().slice(0, 10) : null,
    years,
    dreamYears,
  }
}

/** 阈值改了之后立刻重算（设置页 / 工具都会用它） */
export function applyThreshold(th) {
  const next = saveConfig({ thoughtThreshold: Number(th) || 45 })
  const r = recomputeThoughts(next.thoughtThreshold)
  logLine(`阈值改为 ${r.threshold}：思考 ${r.thoughts}，梦 ${r.dreams}，介绍 ${r.reviews}/${r.total}`)
  return { ok: true, ...r }
}

export { classify, isThought, isDream, isReview }

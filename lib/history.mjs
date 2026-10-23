/**
 * lib/history.mjs —— 「历史消息列表」通道：捞回**已经删掉的**说说
 * ============================================================================
 * 为什么需要它：
 *   lib/qzone.mjs 打的是 `emotion_cgi_msglist_v6` —— 那是「**当前还活着**的说说」列表。
 *   说说一删，它就从那个列表里消失，永远抓不回来。
 *
 *   但 QQ 空间另有一份「历史消息列表」（谁在我某条说说下面评论/点赞过）。这份记录
 *   记的是**互动事件**，不跟着说说一起删。所以只要当年有人评论过，说说删了，
 *   那条摘要还躺在里面。这就是外面那些工具说的「删除的也能获取」的真正原理。
 *
 * 通道：
 *   GET https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds2_html_pav_all
 *       ?uin=<QQ>&offset=<偏移>&count=<每页>&useutf8=1&outputhtmlfeed=1
 *       &scope=1&format=jsonp&g_tk=<gtk>
 *   → JSONP 内含转义 HTML；UTF-8 优先，旧响应回退 GBK。
 *
 * ⚠️ 三个坑（都踩过了，别回头再踩）：
 *   1. 先检查实际编码，再解开 HTML 字符串的转义；不要执行 JSONP。
 *   2. 正文是 `<p class="txt-box-title ellipsis-one">` —— `ellipsis-one` 就是「省略号截断」，
 *      所以捞回来的是**摘要不是全文**，入库要标 truncated: true，别当成原文
 *   3. feed_data 可带原帖 tid 和作者，必须按作者过滤；互动时间不代表发布时间。
 *
 * 请求策略（比外面那些温和）：
 *   - 顺序翻页，不做二分探总数（原版为了算页数要二分几十次，很招 WAF）
 *   - 每页之间默认 900ms，翻到空页/没新东西就停
 *   - 断点续传：offset 落盘，中断了下次接着来
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UA, cookieHeader, gtkOf } from './qzone.mjs'
import { ensureHome, logLine, loadAll } from './store.mjs'

const HISTORY_URL = 'https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds2_html_pav_all'

// ---------------------------------------------------------------- HTML 小工具

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”', hellip: '…' }

/** 配图要（qpic / gtimg / photo.store），但表情和头像不要 */
const IMG_OK = /qpic\.cn|gtimg\.cn|photo\.store\.qq\.com|photo2?\.qzone\.qq\.com/i
const IMG_NO = /\/em\/|qzonestyle\.gtimg\.cn|\/face\/|emoji/i

/** 去标签 + 解实体（不引三方库，够用就行） */
export function stripHtml(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X'
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10)
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
      }
      return ENT[code.toLowerCase()] ?? m
    })
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 历史消息里的时间是中文串，格式不固定，这里能认的：
 *   `2021年6月3日 14:23` / `6月3日 14:23` / `2021-06-03 14:23` / `昨天 14:23` / `刚刚`
 * 认不出来就返回 0（调用方会用序号兜底，不至于撞 id）。
 */
export function parseCnTime(raw, now = new Date()) {
  const t = String(raw ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return 0
  const mk = (y, mo, d, h = 0, mi = 0) => {
    const dt = new Date(y, mo - 1, d, h, mi, 0, 0)
    return Number.isFinite(dt.getTime()) ? Math.floor(dt.getTime() / 1000) : 0
  }
  let m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2}):(\d{2}))?/.exec(t)
  if (m) return mk(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0))
  m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(t)
  if (m) return mk(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0))
  m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2}):(\d{2}))?/.exec(t)
  if (m) return mk(now.getFullYear(), +m[1], +m[2], +(m[3] || 0), +(m[4] || 0))
  m = /(\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/.exec(t)
  if (m) return mk(now.getFullYear(), +m[1], +m[2], +(m[3] || 0), +(m[4] || 0))
  const day = /(刚刚|今天|昨天|前天)/.exec(t)
  if (day) {
    const back = { 刚刚: 0, 今天: 0, 昨天: 1, 前天: 2 }[day[1]]
    const hm = /(\d{1,2}):(\d{2})/.exec(t)
    const d = new Date(now.getTime() - back * 86400000)
    return mk(d.getFullYear(), d.getMonth() + 1, d.getDate(), +(hm?.[1] || 0), +(hm?.[2] || 0))
  }
  return 0
}

/**
 * 解析一页历史消息 HTML。
 * 每条 li.f-single 里有：
 *   <a class="f-name q_namecard" link="…">昵称</a>   互动者的名字
 *   <div class="info-detail">时间</div>
 *   <p class="txt-box-title ellipsis-one">说说摘要</p>
 *   <a class="img-item"><img src="…"></a>           配图（可能多张）
 */
export function decodeHistoryMarkup(html) {
  // Decode string escapes without evaluating the JSONP as JavaScript.
  return String(html || '').replace(/\\x([0-9a-f]{2})|\\u([0-9a-f]{4})|\\([\\'"/nrt])/gi,
    (_, x, u, c) => x || u ? String.fromCharCode(parseInt(x || u, 16)) : ({ n: '\n', r: '\r', t: '\t' }[c] ?? c))
}

export function parseHistoryHtml(html, { now = new Date(), owner } = {}) {
  const text = decodeHistoryMarkup(html)
  // 按 <li class="…f-single…"> 切块；第一块是前导垃圾
  const chunks = text.split(/<li[^>]*class="[^"]*\bf-single\b[^"]*"[^>]*>/i).slice(1)
  const items = []
  for (const chunk of chunks) {
    const body = chunk.split(/<\/li>/i)[0] || chunk
    const metadata = (/<i\b[^>]*\bname="feed_data"[^>]*>/i.exec(body) || [])[0] || ''
    const attr = key => (new RegExp('\\bdata-' + key + '="([^"]*)"', 'i').exec(metadata) || [])[1] || ''
    const originalTid = attr('tid')
    const originalOwner = attr('uin')
    // Only a verified post owned by the signed-in user may enter their archive.
    if (owner != null && (originalOwner !== String(owner) || attr('subappid') !== '311' || !/^[0-9a-f]{20,32}$/i.test(originalTid))) continue
    const timeRaw = stripHtml((/<div[^>]*class="[^"]*info-detail[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(body) || [])[1] || '')
    const snippetHtml = (/<p[^>]*class="[^"]*txt-box-title[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(body) || [])[1] || ''
    const snippet = stripHtml(snippetHtml.replace(/<a\b[^>]*class="[^"]*\bnickname\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '').replace(/<span\b[^>]*class="[^"]*\bstate\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi, ''))
    const who = stripHtml((/<a[^>]*class="[^"]*\bf-name\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(body) || [])[1] || '')
    const imgs = []
    for (const m of body.matchAll(/<img[^>]+(?:src|data-src)="([^"]+)"/gi)) {
      const u = m[1].replace(/&amp;/g, '&')
      // 要配图，但**不要**表情（qzonestyle 的 /em/e100.gif）和头像（qlogo.cn / face）
      if (!IMG_OK.test(u) || IMG_NO.test(u)) continue
      imgs.push(u)
    }
    const hasVideo = /<video|<a[^>]*class="[^"]*video/i.test(body)
    if (!snippet && !imgs.length) continue
    items.push({
      timeRaw,
      // The displayed date is the interaction date, not the post publication date.
      ts: originalTid ? 0 : parseCnTime(timeRaw, now),
      eventTs: Number(attr('abstime')) || parseCnTime(timeRaw, now),
      originalTid,
      originalOwner,
      snippet,
      images: [...new Set(imgs)],
      hasVideo,
      interactor: who,
    })
  }
  return items
}

// ---------------------------------------------------------------- 网络

/** 发一页请求。返回 { ok, html, error, needLogin } */
export async function fetchHistoryPage(jar, uin, offset = 0, count = 20, { timeout = 30000 } = {}) {
  const gtk = gtkOf(jar)
  const q = new URLSearchParams({
    uin: String(uin),
    begin_time: '0',
    end_time: '0',
    getappnotification: '1',
    getnotifi: '1',
    has_get_key: '0',
    offset: String(offset),
    set: '0',
    count: String(count),
    useutf8: '1',
    outputhtmlfeed: '1',
    scope: '1',
    format: 'jsonp',
    g_tk: gtk,
  })

  let res
  try {
    res = await fetch(`${HISTORY_URL}?${q}`, {
      headers: {
        'user-agent': UA,
        accept: '*/*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        cookie: cookieHeader(jar),
        referer: `https://user.qzone.qq.com/${uin}/main`,
      },
      signal: AbortSignal.timeout(timeout),
    })
  } catch (e) {
    return { ok: false, error: `网络请求失败：${e?.message || e}` }
  }

  const buf = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)))
  if (!buf.length) return { ok: false, error: `空响应（HTTP ${res.status}）` }

  // useutf8=1 responses can be UTF-8; use GBK only when strict UTF-8 fails.
  let html = ''
  try { html = new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { html = new TextDecoder('gbk').decode(buf) }

  if (res.status === 501 || res.status === 429 || html.includes('waf.tencent.com')) {
    return { ok: false, error: '被腾讯 WAF 拦了（停一会儿再试，或换一份新 Cookie）' }
  }
  if (!res.ok) return { ok: false, error: `历史接口 HTTP ${res.status}` }
  // 接口失败是这种：_Callback({ "code":-3000, "message":"need login" })
  const j = /"code"\s*:\s*(-?\d+)/.exec(html)
  if (j && Number(j[1]) !== 0) {
    const msg = (/"message"\s*:\s*"([^"]*)"/.exec(html) || [])[1] || `code=${j[1]}`
    const needLogin = /login|登录/i.test(msg)
    return {
      ok: false,
      needLogin,
      error: needLogin ? '登录态无效：历史消息列表要的是空间登录态，Cookie 过期了或漏了 p_skey' : msg,
    }
  }
  if (!/f-single/i.test(html) && buffAndEmpty(html)) return { ok: true, html, empty: true }
  return { ok: true, html }
}

/** 返回体既没有 f-single 也没有错误码 —— 多半就是「到底了」 */
const buffAndEmpty = (html) => !/"code"\s*:/.test(html)

// ---------------------------------------------------------------- 翻页 + 入库

const stateFile = () => join(ensureHome().home, 'history.json')

export function historyState() {
  try { return JSON.parse(readFileSync(stateFile(), 'utf8')) } catch { return null }
}

function saveHistoryState(s) {
  try {
    const f = stateFile()
    const tmp = `${f}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    renameSync(tmp, f)
  } catch { /* 记不上不影响抓取 */ }
}

/** 摘要把「时间+正文」揉成一个稳定键（接口不给 tid） */
const histTid = (ts, snippet, offset) => 'h' + createHash('sha1')
  .update(`${ts}|${snippet}`).digest('hex').slice(0, 16) + (ts ? '' : `_${offset}`)

/**
 * 抓历史消息列表（已删除说说的摘要来源）。
 *
 * @param {object} jar  Cookie jar
 * @param {string} uin  QQ 号
 * @param {object} [opts]
 * @param {number} [opts.maxPages]   最多翻多少页（默认 100 页 ≈ 2000 条）
 * @param {number} [opts.count]      每页条数（默认 20）
 * @param {number} [opts.intervalMs] 页间隔（默认 900ms，别调太低）
 * @param {boolean}[opts.resume]     从上次断点继续（默认 true）
 * @param {(p:object)=>void} [opts.onPage]
 * @returns {Promise<{ok:boolean, items:any[], pages:number, stopped:string, error?:string}>}
 */
export async function fetchHistory(jar, uin, {
  maxPages = 100, count = 20, intervalMs = 900, resume = true, onPage = null,
} = {}) {
  const st0 = resume ? historyState() : null
  const startPage = st0 && String(st0.uin) === String(uin) && !st0.doneAt ? Number(st0.nextOffset) || 0 : 0
  const out = []
  const seen = new Set()
  let offset = startPage
  let pages = 0
  let stopped = '到底了'

  while (pages < maxPages) {
    const r = await fetchHistoryPage(jar, uin, offset, count)
    if (!r.ok) {
      return { ok: false, error: r.error, needLogin: r.needLogin, items: out, pages, stopped: '出错' }
    }
    const markup = decodeHistoryMarkup(r.html)
    const rawCount = markup.split(/<li[^>]*class="[^"]*\bf-single\b[^"]*"[^>]*>/i).length - 1
    const parsed = parseHistoryHtml(r.html, { owner: uin })
    if (!rawCount) {
      if (!/hasMoreFeeds\s*:\s*false/.test(markup)) return { ok: false, error: '历史返回结构无法识别，已保留断点，不能判定到底', items: out, pages, stopped: '解析待核对' }
      stopped = '到底了（这一页没有条目）'; break
    }

    let fresh = 0
    for (const it of parsed) {
      const tid = it.originalTid ? 'h_' + it.originalTid : histTid(it.ts, it.snippet, offset)
      if (seen.has(tid)) continue
      seen.add(tid)
      out.push({ ...it, tid })
      fresh += 1
    }
    pages += 1
    if (typeof onPage === 'function') onPage({ offset, got: parsed.length, fresh, pages })
    saveHistoryState({ uin: String(uin), nextOffset: offset + count, updatedAt: new Date().toISOString(), doneAt: null })
    if (/hasMoreFeeds\s*:\s*false/.test(markup)) { stopped = '到底了（服务端标记）'; break }
    offset += count
    if (intervalMs) await new Promise((res) => setTimeout(res, intervalMs))
  }

  if (pages >= maxPages) stopped = `到了页数上限 ${maxPages}`
  const done = stopped.startsWith('到底了')
  saveHistoryState({
    uin: String(uin),
    nextOffset: done ? 0 : offset + count,
    updatedAt: new Date().toISOString(),
    doneAt: done ? new Date().toISOString() : null,
  })
  logLine(`历史消息：翻 ${pages} 页、${out.length} 条（${stopped}）`)
  return { ok: true, items: out, pages, stopped }
}

// ---------------------------------------------------------------- 判定「是不是删了」

// 比对用的归一：去空白 + 去掉结尾的省略号（历史消息是截断的，尾巴那个「…」不算内容）
const norm = (s) => String(s || '')
  .replace(/\s+/g, '')
  .replace(/(…|\.\.\.)+$/, '')
  .slice(0, 60)

/**
 * 拿历史消息条目对照本地库：
 *   · 库里能找到「时间相近 + 正文前段一致」的正常说说 → 没删，跳过
 *   · 找不到 → 大概率是**已删除**（或仅自己可见）的，标 recovered
 *
 * ⚠️ 比对必须是「前缀」而不是「相等」：历史消息给的是 `ellipsis-one` 截断摘要，
 *    它永远只是原文的前一段，拿完整正文去 === 会比出一条都对不上、全部误判成已删。
 *
 * @param {any[]} items       fetchHistory 的结果
 * @param {any[]} existing    loadAll() 的结果（同一个号）
 */
export function markRecovered(items, existing) {
  // 只拿「正常同步来的」当对照，别拿上一轮标了 recovered 的跟自己比
  const pool = existing.filter((m) => !m.recovered)
  const out = []
  for (const it of items) {
    if (it.originalTid && pool.some(m => String(m.tid) === String(it.originalTid))) {
      out.push({ ...it, possiblyDeleted: false }); continue
    }
    const key = norm(it.snippet)
    const hit = key.length >= 4 && pool.some((m) => {
      const full = norm(m.content)
      if (!full) return false
      if (!full.startsWith(key) && !key.startsWith(full)) return false
      // 时间对不上就不算同一条（±3 分钟，历史消息的时间精度只到分钟）
      if (!it.ts || !m.ts) return true
      return Math.abs(Number(m.ts) - it.ts) <= 180
    })
    out.push({ ...it, possiblyDeleted: !hit })
  }
  return out
}

/** 历史消息条目 → 库里的形状（走 mergeMoments 之前先转好） */
export function toMoment(it, uin) {
  return {
    // fetchHistory 会给 tid；走别的路径来的（比如测试/手工导入）没有，这里兜一个
    tid: it.tid || histTid(it.ts, it.snippet, 0),
    content: it.snippet || '',
    ts: Number(it.ts) || 0,
    time: it.ts ? new Date(it.ts * 1000).toISOString() : '',
    images: it.images || [],
    comments: [],
    forwarded: null,
    source: '',
    share: null,
    music: false,
    recovered: true,          // ⭐ 标记：这条是从历史消息列表补回来的
    truncated: true,          // ⭐ 正文是摘要（ellipsis-one 截断过），不是原文
    possiblyDeleted: Boolean(it.possiblyDeleted),
    interactor: it.interactor || '',
    originalTid: it.originalTid || '',
    eventTs: it.eventTs || 0,
    owner: String(uin),
  }
}

export const __internals = { histTid, HISTORY_URL }

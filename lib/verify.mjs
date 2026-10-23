import { parsePostJsonp, postContent, hasMoreContent } from './content.mjs'
/**
 * lib/verify.mjs —— 「逐条验活」：拿 tid 直接问腾讯「这条还在不在」
 * ============================================================================
 * 为什么需要它（2026-10-22 实测出来的结论）：
 *
 *   · 历史消息列表（lib/history.mjs）只覆盖**最近几天**，翻到第 3 页就被 WAF 501，
 *     多年前的历史根本摸不到；而且它给的是截断摘要，判「删没删」还得靠猜。
 *   · 但只要手上有 **tid**，就能直接打 `emotion_cgi_msgdetail_v6` 问单条：
 *       活着 → code 0，还顺手返回**全文**、图片、精确秒级时间
 *       已删 → code -10029，「该条内容已被删除」
 *     这是**点对点**判定，不依赖互动记录，所以：
 *       ✅ 没评论没点赞的说说删了也能查出来
 *       ✅ 跟正文改没改过完全无关（tid 不变就不影响）
 *       ✅ 本地库有 8000 条也只查这 8000 次，不用去翻 5 万条互动
 *
 *   · 频控实测：间隔 400ms 连打 15 条没被拦，平均 1167ms/条。
 *     8233 条 ≈ 2.7 小时 —— 所以必须支持断点，一次跑一段。
 *
 * 关键取舍：
 *   · **只信 code 0 和 -10029**。其它 code（风控、参数错、权限）一律当「没查成」，
 *     不标 gone —— 宁可漏判也不要把还活着的说说误判成删掉（那是不可逆的错误）。
 *   · 验到已删的，**正文用本地的全文**（本地有原文！比历史消息的摘要强得多），
 *     只补一个 gone 标记，绝不拿接口返回的空内容去覆盖。
 * ============================================================================
 */
import { UA, cookieHeader, gtkOf, deAt } from './qzone.mjs'

const DETAIL_URL = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6'

/** JSONP 里那层 \x3C / \x22 转义（跟 history.mjs 同一个坑） */
const unesc = (s) => String(s ?? '')
  .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\\//g, '/')
  .replace(/\\t/g, '\t')
  .replace(/\\n/g, '\n')

/** 已删的 code —— 腾讯这里用的是 -10029 */
export const CODE_GONE = -10029

/**
 * 查一条说说还在不在。
 *
 * @returns {Promise<{
 *   ok: boolean,          // 这次请求本身成功了吗（网络/接口层面）
 *   alive: boolean|null,  // true=还在；false=已删；null=没查成（别动它）
 *   code: number|null,
 *   message: string,
 *   content?: string,     // 还活着时顺手拿到的全文
 *   images?: string[],
 *   createdTime?: number,
 *   needLogin?: boolean,
 *   error?: string,
 * }>}
 */
export async function verifyOne(jar, uin, tid, { timeout = 25000 } = {}) {
  const t = String(tid || '').trim()
  if (!t) return { ok: false, alive: null, code: null, message: '没有 tid', error: '没有 tid' }

  const q = new URLSearchParams({
    uin: String(uin),
    tid: t,
    format: 'jsonp',
    g_tk: gtkOf(jar),
    callback: '_preloadCallback',
    code_version: '1',
    not_trunc_con: '1',
  })

  let res
  try {
    res = await fetch(`${DETAIL_URL}?${q}`, {
      headers: {
        'user-agent': UA,
        accept: '*/*',
        'accept-language': 'zh-CN,zh;q=0.9',
        cookie: cookieHeader(jar),
        referer: `https://user.qzone.qq.com/${uin}/main`,
      },
      signal: AbortSignal.timeout(timeout),
    })
  } catch (e) {
    return { ok: false, alive: null, code: null, message: '网络请求失败', error: String(e?.message || e) }
  }

  const buf = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)))
  if (!buf.length) return { ok: false, alive: null, code: null, message: `空响应（HTTP ${res.status}）`, error: 'empty' }
  const text = buf.toString('utf8')
  const post = parsePostJsonp(text)

  if (text.includes('waf.tencent.com')) {
    return { ok: false, alive: null, code: null, message: '被腾讯 WAF 拦了', error: 'waf', waf: true }
  }

  const code = post && Number.isFinite(Number(post.code)) && post.code != null ? Number(post.code) : null
  const message = String(post?.message || '')

  if (code === null) {
    return { ok: false, alive: null, code: null, message: message || '返回体认不出来', error: 'unparsable' }
  }
  if (code === CODE_GONE || /已被删除|已删除/.test(message)) {
    return { ok: true, alive: false, code, message: message || '已被删除' }
  }
  if (code !== 0) {
    // 限流：腾讯回 -10000「使用人数过多，请稍后再试」。这不是「查不成」，是「现在别问了」，
    // 要区分出来让上层退避，否则会一直空转、一条也查不出来（2026-10-23 实测踩过）。
    const throttled = code === -10000 || /使用人数过多|系统繁忙|稍后再试|too many|frequen/i.test(message)
    if (throttled) {
      return { ok: false, alive: null, code, message: message || '腾讯限流了', error: 'throttled', throttled: true }
    }
    // 风控 / 需要登录 / 参数问题 —— 一律「没查成」，绝不标 gone
    return {
      ok: false, alive: null, code, message: message || `code=${code}`,
      needLogin: /login|登录/.test(message), error: 'code',
    }
  }

  // code 0：还活着，顺手把全文和图片捞出来（用来补本地缺的正文）
  const content = extractContent(text)
  const images = extractImages(text)
  const ct = /"created_time"\s*:\s*(\d+)/.exec(text)
  return {
    ok: true,
    alive: true,
    code,
    message: message || '还在',
    content: deAt(content),
    contentSource: 'detail',
    contentIncomplete: hasMoreContent(post),
    images,
    createdTime: ct ? Number(ct[1]) : 0,
  }
}

/** Parse the post body as JSON; never pick the first matching nested con. */
function extractContent(text) { return postContent(parsePostJsonp(text)) }

/** 配图（pic 数组里的 url1/url2/url3，取一张就够） */
function extractImages(text) {
  const post = parsePostJsonp(text)
  const pics = Array.isArray(post?.pic) ? post.pic : []
  return [...new Set(pics.map(p => p.url1 || p.url2 || p.url3 || p.pic_id)
    .filter(u => typeof u === 'string' && /^https?:\/\//.test(u) && /qpic\.cn|gtimg\.cn|photo\.store\.qq\.com/i.test(u)))]
}

/**
 * 批量验活：把本地库里的说说逐条问一遍。
 *
 * 断点方式：**不用状态文件**，靠每条说身上的 `verifiedAt`。
 * 查过的打上时间戳，下次自动跳过 —— 天然幂等，中途断了也不会重复查。
 *
 * @param {object} jar
 * @param {string} uin
 * @param {object} [opts]
 * @param {number} [opts.max]        这一轮最多查多少条（默认 300，别一次全跑完）
 * @param {number} [opts.intervalMs] 每条间隔（默认 400ms，实测安全）
 * @param {boolean}[opts.redo]       true=连查过的也重查（默认 false，跳过查过的）
 * @param {string} [opts.since]      只查这个时间点之后的（ISO 日期，可省）
 * @param {boolean}[opts.waf]        true=已被 WAF 拦过，跳过历史消息那条通道
 * @param {(p:object)=>void} [opts.onItem]
 * @returns {Promise<{ok:boolean, checked:number, alive:number, gone:number, unknown:number,
 *   remaining:number, error?:string, needLogin?:boolean, samples?:any[]}>}
 */
export async function verifyBatch(jar, uin, moments, {
  max = 300, intervalMs = 400, redo = false, since = '', onItem = null,
} = {}) {
  const list = (moments || [])
    .filter((m) => m && m.tid && !String(m.tid).startsWith('h'))   // 摘要没有真 tid，查不了
    .filter((m) => (redo ? true : !m.verifiedAt))
    .filter((m) => (since ? (Number(m.ts) || 0) >= new Date(since).getTime() / 1000 : true))
    .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))      // 新的先查：最近删的最可能是你想找的

  const out = new Set()
  const touched = []
  let checked = 0
  let alive = 0
  let gone = 0
  let unknown = 0
  let wafHits = 0
  let throttleHits = 0

  for (const m of list) {
    if (checked >= max) break
    const r = await verifyOne(jar, uin, m.tid)
    if (r.waf) {
      wafHits += 1
      // WAF 一连就退，别硬顶（顶下去会把整条链路封更久）
      if (wafHits >= 2) {
        return { ok: false, error: '被腾讯 WAF 拦了，先停一会儿再继续（已查的都已落库）', checked, alive, gone, unknown, remaining: list.length - checked, touched }
      }
    } else if (r.throttled) {
      // ⚠️ 2026-10-23 实测：限流时腾讯回 code -10000「使用人数过多」。
      //    这时候**立刻停**，不要继续空转 300 次（那样一条也查不出来，还会把限流拖更久）。
      throttleHits += 1
      return {
        ok: false, throttled: true,
        error: `腾讯限流了（${r.message || 'code -10000'}），歇一会儿再接着查（已查的都已落库）`,
        checked, alive, gone, unknown, remaining: list.length - checked, touched,
      }
    } else if (r.alive === true) {
      alive += 1
      m.verifiedAt = new Date().toISOString()
      m.alive = true
      delete m.gone
      delete m.goneAt
      // A successful, expanded detail response can repair nonempty previews too.
      // ⚠️ 只在「接口正文比本地长」或「本地本来就不全」时才覆盖 ——
      //    单靠内容非空就盖，遇到接口偶尔抽风回半截，会把本地已补好的全文冲短（不可逆）。
      if (r.content && !r.contentIncomplete
          && (m.contentIncomplete === true || r.content.length > String(m.content || '').length)) {
        m.content = r.content
        m.rawContent = r.content
        m.contentSource = 'detail'
        m.contentIncomplete = false
      }
      if (!m.publicTime && r.createdTime) { /* 没用到，留个钩子 */ }
      touched.push({ tid: m.tid, alive: true })
    } else if (r.alive === false) {
      gone += 1
      m.verifiedAt = new Date().toISOString()
      m.alive = false
      m.gone = true
      m.goneAt = new Date().toISOString()
      touched.push({ tid: m.tid, alive: false, ts: m.ts, content: String(m.content || '').slice(0, 60) })
    } else {
      // 没查成（风控/网络/参数）—— 不写 verifiedAt，下次会重查；也不动 gone
      unknown += 1
    }
    checked += 1
    if (typeof onItem === 'function') onItem({ n: checked, tid: m.tid, alive: r.alive, code: r.code, message: r.message })
    if (intervalMs) await new Promise((res) => setTimeout(res, intervalMs))
  }

  const doneIds = new Set(touched.map((x) => x.tid))
  const remaining = list.filter((m) => !doneIds.has(m.tid)).length
  return { ok: true, checked, alive, gone, unknown, remaining, touched, samples: touched.filter((x) => x.alive === false).slice(0, 10) }
}

export const __internals = { DETAIL_URL, extractContent, extractImages, unesc }

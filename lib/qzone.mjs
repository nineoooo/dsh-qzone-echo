import { parsePostJsonp, postContent, hasMoreContent, preserveFullContent, renderedLength, TRUNC_LIMIT } from './content.mjs'
/**
 * lib/qzone.mjs —— QQ 空间「说说」接口客户端（纯 node，无第三方依赖）
 * ============================================================================
 * 接口来自公开项目 ZHChen2000/qzone-history 的实现（已核对源码，2026-10-22）：
 *   GET https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6
 *       ?uin=<QQ>&ftype=0&sort=0&pos=<偏移>&num=<每页>&replynum=100&g_tk=<gtk>
 *       &callback=_preloadCallback&code_version=1&format=jsonp&need_private_comment=1
 *   → jsonp：_preloadCallback({...})  里面 { code, message, total, msglist[] }
 *   msglist 每一项：content / created_time(秒) / tid / pic[].url1 / commentlist[]
 *
 * g_tk 算法（与腾讯 web 一致）：h=5381; for c: h += (h<<5) + c; h & 0x7fffffff
 * g_tk 用 **p_skey** 算（qzone-history 就是这么算的）；没有 p_skey 时退到 skey。
 *
 * Cookie 里的 uin 形如 `o0123456789`：去掉开头的 o 和连续的 0 才是真 QQ 号。
 * ============================================================================
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

export { UA }

/**
 * 同一个 CGI 有好几个入口域名。2026-10-22 实测：
 * - `user.qzone.qq.com` 被 WAF 拦时直接 501 + waf.tencent.com 页面（硬封）
 * - `h5` / `mobile.qzone.qq.com` 走同一个代理，**不返回 WAF 页**，只会被限流（code=-10000 使用人数过多）
 * 所以「主域名被 WAF 就换 h5」是一条真实可用的软着陆路径 —— 限流会退，WAF 不会马上退。
 * 这些入口共用同一份 Cookie 和 g_tk，不用改任何鉴权逻辑。
 */
export const HOSTS = {
  main: 'user.qzone.qq.com',
  h5: 'h5.qzone.qq.com',
  mobile: 'mobile.qzone.qq.com',
}
export const DEFAULT_HOST = HOSTS.main

/** 把浏览器里复制的一整段 Cookie 解析成 { name: value } */
export function parseCookieText(text) {
  const out = {}
  const raw = String(text || '').trim()
  if (!raw) return out
  // 两种写法都吃：`a=1; b=2` 或 每行一个 / 带 Cookie: 前缀
  const body = raw.replace(/^\s*cookie\s*:\s*/i, '')
  for (const part of body.split(/[;\n\r]+/)) {
    const s = part.trim()
    if (!s) continue
    const i = s.indexOf('=')
    if (i <= 0) continue
    const k = s.slice(0, i).trim()
    const v = s.slice(i + 1).trim().replace(/^"(.*)"$/, '$1')
    if (k) out[k] = v
  }
  return out
}

export const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')

/** o0123456789 → 123456789 */
export function extractUin(jar) {
  let u = String(jar.uin || '').trim()
  if (!u) {
    const alt = jar.ptui_loginuin || jar.p_uin || jar.qq_ext
    if (alt) u = String(alt)
  }
  u = u.replace(/^o0*/, '').replace(/^0+/, '')
  return /^\d{5,12}$/.test(u) ? u : ''
}

/** 腾讯 web 的 g_tk */
export function gtkFrom(skey) {
  let h = 5381
  const s = String(skey || '')
  for (let i = 0; i < s.length; i++) h += (h << 5) + s.charCodeAt(i)
  return String(h & 2147483647)
}

/** 用哪个 cookie 算 g_tk：p_skey 优先（qzone 系列 CGI 认它） */
export const gtkOf = (jar) => gtkFrom(jar.p_skey || jar.skey || jar.sk)

/**
 * 先「热个身」：正常带 cookie 访问一次空间首页 / 311，顺便收下服务端下发的新 cookie。
 * 冷 cookie 直接打 CGI 容易被腾讯 WAF 拦（waf.tencent.com）。
 */
export async function warmUp(jar, uin, { timeout = 20000 } = {}) {
  const merged = { ...jar }
  for (const url of [
    `https://user.qzone.qq.com/${uin}`,
    `https://user.qzone.qq.com/${uin}/311`,
  ]) {
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          cookie: cookieHeader(merged),
          referer: `https://user.qzone.qq.com/${uin}`,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      })
      for (const line of res.headers.getSetCookie?.() ?? []) {
        const kv = line.split(';')[0]
        const i = kv.indexOf('=')
        if (i > 0) merged[kv.slice(0, i).trim()] = kv.slice(i + 1).trim()
      }
      await res.arrayBuffer().catch(() => {})
    } catch { /* 热身失败不致命，继续打 CGI */ }
  }
  return merged
}

const decodeJsonp = parsePostJsonp

/**
 * 拉一页说说列表。
 * @returns {{ok:boolean,code?:number,message?:string,total?:number,items?:any[],raw?:string}}
 */
export async function fetchPage(jar, uin, pos, num = 20, { timeout = 25000, retry = 0, host = DEFAULT_HOST } = {}) {
  // ⚠️ 2026-10-22 实测：`num` **最大只认 40**。传 41 以上接口不报错，而是**只给 10 条**
  //    （看起来像「到底了」），会静默丢数据 —— 所以这里硬性夹到 40，谁传大了都不许越过。
  const per = Math.min(40, Math.max(1, Number(num) || 20))
  const gtk = gtkOf(jar)
  const url = `https://${host}/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6`
    + `?uin=${uin}&ftype=0&sort=0&pos=${pos}&num=${per}&replynum=100`
    + `&g_tk=${gtk}&callback=_preloadCallback&code_version=1&format=jsonp&need_private_comment=1&not_trunc_con=1`

  let res
  try {
    res = await fetch(url, {
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
    if (retry > 0) {
      await new Promise((r) => setTimeout(r, 1500))
      return fetchPage(jar, uin, pos, num, { timeout, retry: retry - 1, host })
    }
    return { ok: false, message: `网络请求失败：${e?.message || e}` }
  }

  const body = await res.text().catch(() => '')
  // ⚠️ 服务器偶尔对某一页直接回 500 + 空 body（翻几千条时必然撞上几次）。这不是登录问题，
  //    重试同一页就能过 —— 不重试的话整趟同步会在这里前功尽弃（2026-10-22 踩过：800 条停住）。
  if (!body) {
    if (retry > 0) {
      await new Promise((r) => setTimeout(r, 1500))
      return fetchPage(jar, uin, pos, num, { timeout, retry: retry - 1, host })
    }
    return { ok: false, message: `空响应（HTTP ${res.status}），重试几次都没过` }
  }
  // waf:true 让上层知道「是硬封，不是限流」，可以据此换 host 或干脆等
  if (body.includes('waf.tencent.com')) return { ok: false, waf: true, message: '被腾讯 WAF 拦了（换个时间再试，或重新复制一份新 Cookie）' }
  if (/need\s*login|请先登录|登录已过期/i.test(body)) {
    return { ok: false, message: '登录态无效：Cookie 过期或复制时漏了 p_skey / skey', needLogin: true }
  }

  const json = decodeJsonp(body)
  if (!json) {
    const hint = body.length < 400 ? body.slice(0, 200) : `前 200 字：${body.slice(0, 200)}`
    return { ok: false, message: `返回不是 JSONP，可能被拦或 Cookie 不对（${hint}）` }
  }
  if (json.code && json.code !== 0) {
    const msg = String(json.message || json.msg || `code=${json.code}`)
    // 「使用人数过多，请稍后再试」= 腾讯侧限流（2026-10-22 夜里连翻几千条后必然撞上）。
    // 这不是 Cookie 问题、也不是封号，等一阵再继续就行；说清楚，别让人以为登录挂了。
    if (/使用人数过多|系统繁忙|稍后再试|too many|frequen/i.test(msg)) {
      if (retry > 0) {
        // 限流比偶发 500 更需要耐心：等 15 秒再试同一页
        await new Promise((r) => setTimeout(r, 15000))
        return fetchPage(jar, uin, pos, num, { timeout, retry: retry - 1, host })
      }
      return { ok: false, code: json.code, throttled: true, message: `腾讯限流了（${msg}），歇一会儿再接着翻，已经抓到的不会丢` }
    }
    return { ok: false, code: json.code, message: /login|登录/i.test(msg) ? `登录态无效：${msg}` : msg, needLogin: /login|登录/i.test(msg) }
  }
  return {
    ok: true,
    code: 0,
    total: Number(json.total) || 0,
    items: Array.isArray(json.msglist) ? json.msglist : [],
    hasMore: json.hasmore === 1 || json.hasmore === '1',
  }
}

/**
 * QQ 的 @ 是这种内嵌码：`@{uin:1234567890,nick:某人,who:1,auto:1}好的！`
 * 留着机器码没法看，换成「@某人 」再存（原始码不再留，正文清洗是幂等的）。
 *
 * 2026-10-22 第二版：昵称里可能带逗号、括号、半角标点（`(^_^)`），
 * 所以 nick 一直吃到 `,who:` 为止，而不是 `[^,}]*` —— 否则整段换不掉，
 * 页面上就露出 `@{uin:9876543210,nick:(^_^),who:1}`（老大截图报的就是这个）。
 */
export const deAt = (s) => String(s || '')
  .replace(/@\{uin:\d+,nick:([^}]*?),(?:who|auto):[^}]*\}/g, (_, nick) => `@${nick} `)
  .replace(/@\{uin:\d+,nick:([^}]*)\}/g, (_, nick) => `@${nick} `)
  .replace(/\{uin:\d+,nick:([^}]*?),(?:who|auto):[^}]*\}/g, (_, nick) => `@${nick} `)
  .replace(/\u00a0/g, ' ')
  // 替换后会留下「@名字   ：」这种双空格（昵称本身带空格时更明显），压成一个
  .replace(/[ \t]{2,}/g, ' ')
  .replace(/\s+([：，。！？、；])/g, '$1')
  .trim()

/** 把接口原始一条整理成我们自己的形状 */
export function normalize(raw) {
  // ⚠️ 正文里的 @ 也是内嵌码（`@{uin:...,nick:...}`），以前只对评论做了转换、
  //    正文漏了 —— 结果网页上直接露出机器码（2026-10-22 老大截图报的）。
  //    正文必须也过 deAt；原样另存 rawContent，需要还原时还有。
  const rawContent = postContent(raw).replace(/\u00a0/g, ' ').trim()
  const content = deAt(rawContent)
  const ts = Number(raw?.created_time) || 0
  const pics = Array.isArray(raw?.pic)
    ? raw.pic.map((p) => p?.url1 || p?.url2 || p?.url3).filter(Boolean)
    : []
  // 评论：顶层是 commentlist，**「回复某条评论」藏在 list_3 里**（不是顶层）。
  // 以前只读顶层 —— 结果「我回复别人」全丢了，导出的评论数也对不上（2026-10-22 修）。
  const cleanCmt = (c, isReply) => ({
    uin: c?.uin != null ? String(c.uin) : '',
    name: String(c?.name ?? '').trim(),
    content: deAt(String(c?.content ?? '')),
    raw: String(c?.content ?? ''),
    time: String(c?.createTime2 ?? c?.create_time ?? '').trim(),
    replyTo: isReply && !isReply.mine ? isReply.name : '',
    replies: [],
  })
  const comments = Array.isArray(raw?.commentlist)
    ? raw.commentlist.map((c) => {
      const mine = cleanCmt(c, null)
      const kids = []
      // 部分版本把回复放在 list_3，个别情况在 commentlist 的 replyList
      for (const box of [c?.list_3, c?.replyList]) {
        if (!Array.isArray(box)) continue
        for (const r of box) kids.push(cleanCmt(r, mine))
      }
      mine.replies = kids.filter((r) => r.content || r.name)
      return mine
    }).filter((c) => c.content || c.name)
    : []
  // 转发/引用那一块（字段名不固定，能摸到就带上）
  const rtRaw = raw?.rt_con && typeof raw.rt_con === 'object' ? raw.rt_con : null
  // 名字可能在 rt_con.name，也可能在顶层的 rt_uinname / rt_name / rt_con.uinname 上
  // （2026-10-22 老大报「转发的没有名字」：原来只认 rt_con.name，别处都丢了）
  // ⚠️ 必须按「第一个非空字符串」取，不能用 ??. —— rt_con.name 常是空串 ""，
  //    ?? 只挡 null/undefined，空串会被当成有效值，于是 rt_uinname 里的真名被丢掉。
  const firstStr = (...vals) => {
    for (const v of vals) {
      const s = String(v ?? '').trim()
      if (s) return s
    }
    return ''
  }
  const rtName = firstStr(
    rtRaw?.name, rtRaw?.uinname, rtRaw?.nickname,
    raw?.rt_uinname, raw?.rt_name,
  )
  // 原帖自己的配图在 rt_con.pic 里，以前没合并 —— 转发后只能看到自己那几张
  const rtPics = Array.isArray(rtRaw?.pic)
    ? rtRaw.pic.map((p) => p?.url1 || p?.url2 || p?.url3).filter(Boolean)
    : []
  const forwarded = rtRaw ? {
    name: rtName,
    content: deAt(postContent(rtRaw).replace(/\u00a0/g, ' ').trim()),
    images: rtPics,
  } : null
  // 自己这次带图 + 原帖带图（去重、保持顺序）。
  // 不截断：接口给多少就存多少（原来是 slice(0,18)，会悄悄吃掉接口已经返回的图）。
  // 接口没给到的部分由 picTotal 如实说明，不能靠丢数据冒充「就这么多」。
  const allPics = [...new Set([...pics, ...rtPics])]

  // ---------------- 分享卡片（音乐 / 视频 / 网页 / 小程序 …） ----------------
  // 说说里的「分享了一首歌」不是普通文本：正文常常是空的，内容藏在 source_* / rt_source_*
  // 这几个字段里（appid + 名字 + 跳转链接）。以前 normalize 把它们丢了 —— 2026-10-22 补上。
  const pick = (...vals) => {
    for (const v of vals) {
      const s = String(v ?? '').trim()
      if (s) return s
    }
    return ''
  }
  const isRt = Boolean(rtRaw) // 转发那条：卡片信息在 rt_* 上
  const share = {
    appid: pick(isRt ? raw?.rt_source_appid : raw?.source_appid, raw?.source_appid),
    name: pick(isRt ? raw?.rt_source_name : raw?.source_name, raw?.source_name),
    url: pick(isRt ? raw?.rt_source_url : raw?.source_url, raw?.source_url, raw?.rt_source_url),
    tid: pick(raw?.rt_tid),
    uin: pick(raw?.rt_uin),
    uinname: pick(raw?.rt_uinname),
  }
  // QQ音乐的 appid 是 233；其余靠域名认（不乱猜 appid，猜错会把视频当歌）
  const MUSIC_APPIDS = new Set(['233'])
  const MUSIC_URL = /y\.qq\.com|music\.qq\.com|i\.y\.qq\.com|163\.com\/.*song|kugou|kuwo|5sing|music\.163/i
  const music = (share.appid && MUSIC_APPIDS.has(share.appid)) || MUSIC_URL.test(share.url) || MUSIC_URL.test(share.name)
  // 卡片正文：conlist 里 type=2 是普通文字段落，其余才是卡片自带的标题/描述
  const cardText = Array.isArray(raw?.conlist)
    ? raw.conlist
      .filter((c) => String(c?.type ?? '2') !== '2')
      .map((c) => String(c?.con ?? '').trim())
      .filter(Boolean)
      .slice(0, 3)
    : []

  // 只有真的带了 appid / 跳转链接才算「分享卡片」——
  // 光有正文的普通说说不能算（conlist 每条都有 con，别把普通说说误判成分享）
  const hasShare = Boolean(share.appid || share.url)

  // ⚠️ 2026-10-22 老大报「我转发这条图片明明很多为什么这里只能看见这几张」：
  //    实测接口的 `pic` 数组**最多只给 9 张**（连详情接口也一样），但 `pictotal` 会告诉你原帖到底几张。
  //    37/50/46 张那种，能拿到的永远只有前 9 张 —— 这是腾讯那边的上限，不是我们丢的。
  //    记下总数，界面上就能老实说明「原帖共 N 张，这里只有 9 张」。
  const picTotal = Number(raw?.pictotal) || pics.length

  return {
    tid: String(raw?.tid ?? ''),
    content,
    contentSource: 'list',
    // ⚠️ 度量用 renderedLength（表情码算 1 个字），不是 content.length ——
    //    腾讯的 500 上限是按显示字数算的，用原始长度会误判带表情的长帖。
    //    另外 has_more_con 只在真被截时才会=1，两条判据取或，宁可多查一次详情。
    contentIncomplete: hasMoreContent(raw) || renderedLength(content) >= TRUNC_LIMIT - 10,
    ts,
    time: ts ? new Date(ts * 1000).toISOString() : '',
    images: allPics,
    picTotal,
    comments,
    forwarded,
    source: String(raw?.source_name ?? '').trim(),
    share: hasShare ? { ...share, cardText, music } : null,
    music,
    raw,
  }
}

/**
 * 一页一页往后翻，直到没有更多。
 *
 * ⚠️ 2026-10-22 实测：接口**不认** `begintime` / `endtime`（传了也原样返回全部），
 *    所以「按月读取」只能在**客户端切** —— 靠 `since`/`until` 过滤 + 一旦翻过 `since`
 *    就收手。好处是不依赖服务端参数，坏处是每个月都要从 pos=0 翻过去。
 *    再用 `known`（库里已有的 tid）做增量：一整页全命中 = 后面的肯定也都收过了，直接停。
 *
 * @param {object} opts
 * @param {number} [opts.since]   只要 >= 这个时间戳（秒）的；翻到更早的立刻停
 * @param {number} [opts.until]   只要 <  这个时间戳（秒）的
 * @param {Set<string>} [opts.known] 已入库的 tid —— 用来判断「翻到底了没」
 * @param {boolean}[opts.stopWhenKnown] 一整页的 tid 都在 known 里就停（增量模式）
 */
export async function fetchAll(jar, uin, {
  pageSize = 20, max = 2000, onPage = null, sleep = 600, timeout = 25000,
  since = 0, until = 0, known = null, stopWhenKnown = false, startPos = 0, fullKnown = new Map(), detailLimit = 20,
  host = DEFAULT_HOST, hosts = null, emptyRetries = 3,
} = {}) {
  const out = []
  let detailRequests = 0, detailBlocked = false
  const seen = new Set()
  // ⚠️ startPos：从第几条开始翻。已经同步到 2024-04 的库再想往前挖（2023、2022……），
  //    从 0 开始等于把已经有的 6700 条重翻一遍 —— 既慢又白白多撞限流。
  let pos = Math.max(0, Number(startPos) || 0)
  let total = 0
  let pages = 0
  let skipped = 0
  let hitKnownPage = false
  // ⚠️ 2026-10-22 踩过：整页都是「已经见过的 tid」时原来会直接 break 收工。
  //    但 pos 翻页在**有说说被删/重复**时会把同一条吐回来，于是「一页全重复」是正常现象 ——
  //    照 break 就变成「8234 条只收到 6720 就报完成」，尾巴整段静悄悄丢掉。
  //    改成：连续几页全是重复才认为真到底。
  let dupPages = 0
  // 空页重试计数（见下面 `if (!page.items.length)` 那段：空页 ≠ 到底）
  let emptyTries = 0
  const started = Date.now()
  // 入口轮换：主域名被 WAF 硬封（501）时可以换 h5 / mobile（同一代理，只会限流不会 501）。
  // 只在「WAF 硬封」时换 —— 限流是把整条链路都限了，换域名没用，白折腾。
  const pool = Array.isArray(hosts) && hosts.length ? hosts.slice() : [host]
  let hi = Math.max(0, pool.indexOf(host))
  let curHost = pool[hi] || DEFAULT_HOST
  while (out.length < max) {
    let page = await fetchPage(jar, uin, pos, pageSize, { timeout, retry: 3, host: curHost })
    if (!page.ok && page.waf && pool.length > 1) {
      // 换个入口再摸一次同一页
      let switched = false
      for (let k = 1; k < pool.length; k++) {
        const cand = pool[(hi + k) % pool.length]
        if (cand === curHost) continue
        const alt = await fetchPage(jar, uin, pos, pageSize, { timeout, retry: 1, host: cand })
        if (alt.ok) { hi = (hi + k) % pool.length; curHost = cand; page = alt; switched = true; break }
      }
      if (!switched) {
        if (out.length) return { ok: true, partial: true, stopped: page.message, items: out, pages, total, skipped, nextPos: pos, waf: true, host: curHost }
        return { ok: false, message: page.message, waf: true, items: out, pages, total, skipped, host: curHost }
      }
    }
    if (!page.ok) {
      // 已经在手里的一律留着（几百条翻到这页才挂，全丢太亏）；换个说法告诉上层「是中断不是空库」
      if (out.length) {
        return { ok: true, partial: true, stopped: page.message, items: out, pages, total, skipped, nextPos: pos, throttled: page.throttled, waf: page.waf, host: curHost }
      }
      return { ok: false, message: page.message, needLogin: page.needLogin, throttled: page.throttled, waf: page.waf, items: out, pages, total, skipped, host: curHost }
    }
    total = page.total || total
    // ⚠️ 2026-10-22 实测：深翻时接口会**间歇性回空页**（code=0、msglist=[]），
    //    但同一个 pos 过 40 秒再问就正常给 40 条 —— 这不是「到底了」，是限流/抖动的假信号。
    //    所以：只要「接口自报总数 total 还没翻到」，空页一律不认，重试几次才肯罢休。
    if (!page.items.length) {
      const moreLeft = total > 0 && pos < total
      if (moreLeft && emptyTries < emptyRetries) {
        emptyTries += 1
        if (sleep) await new Promise((r) => setTimeout(r, Math.max(Number(sleep) || 600, 3000)))
        continue
      }
      break
    }
    emptyTries = 0
    let fresh = 0
    let knownHit = 0
    let passedSince = false
    for (const raw of page.items) {
      let m = normalize(raw)
      const key = m.tid || `${m.ts}|${m.content.slice(0, 40)}`
      if (seen.has(key)) continue
      seen.add(key)
      // 倒序翻：碰到比 since 还早的，这一页之后都可以不看了
      if (since && m.ts && m.ts < since) { passedSince = true }
      if (known && key && known.has(key)) knownHit += 1
      if (since && m.ts && m.ts < since) { skipped += 1; continue }
      if (until && m.ts && m.ts >= until) { skipped += 1; continue }
      m = preserveFullContent(fullKnown.get(m.tid), m)
      if (m.contentIncomplete && m.tid && !detailBlocked && detailRequests < detailLimit) {
        detailRequests += 1
        const detail = await fetchFullPost(jar, uin, m.tid, { timeout })
        if (detail.ok) {
          const full = deAt(postContent(detail.post))
          if (full && !hasMoreContent(detail.post)) {
            m.content = full
            m.rawContent = postContent(detail.post)
            m.contentSource = 'detail'
            m.contentIncomplete = false
          }
        } else detailBlocked = true // Stop on auth, WAF or transport errors; keep the preview.
        if (sleep) await new Promise(r => setTimeout(r, sleep))
      }
      out.push(m)
      fresh += 1
      if (out.length >= max) break
    }
    pages += 1
    if (typeof onPage === 'function') onPage({ pos, got: page.items.length, fresh, total: out.length, totalCount: total, skipped })
    // 增量模式：整页都是老熟人 ⇒ 再往前翻也全是旧的，收工
    if (stopWhenKnown && known && knownHit > 0 && knownHit === page.items.length) { hitKnownPage = true; break }
    if (passedSince) break
    if (fresh) dupPages = 0
    else dupPages += 1
    if (dupPages >= 3) break
    // ⚠️ 原来这里还有一条 `pos + items.length >= total` 就收工 —— 2026-10-22 实测这个 `total`
    //    在翻到深处时会自己变小（跑到第 168 页时它报了 6720），于是整趟同步在 6720 条
    //    「顺利完成」，8234 的尾巴静悄悄丢掉。**不信 total，只信「真的没条目了」**。
    // 兜底：单次最多翻 10 分钟。⚠️ 8200 条按 40 条/页要 206 页、每页隔 600ms ≈ 2 分钟，
    //    10 分钟够；但页间隔调大会逼近上限，所以到点要「算中断」而不是「算到底」。
    if (Date.now() - started > 10 * 60 * 1000) {
      return { ok: true, partial: true, stopped: '单次翻了 10 分钟，先停下（下次接着翻）', items: out, pages, total, skipped, nextPos: pos, host: curHost }
    }
    pos += page.items.length
    if (sleep) await new Promise((r) => setTimeout(r, sleep))
  }
  // nextPos：下次该从哪继续（part=中断时上层用它做断点；到底了就是 undefined）
  return { ok: true, items: out, pages, total, skipped, hitKnownPage, nextPos: pos, host: curHost }
}

/** Request the post itself, with long-text expansion enabled. */
export async function fetchFullPost(jar, uin, tid, { timeout = 25000 } = {}) {
  const params = new URLSearchParams({ uin: String(uin), tid: String(tid), format: 'jsonp', g_tk: gtkOf(jar), callback: '_preloadCallback', code_version: '1', not_trunc_con: '1' })
  try {
    const res = await fetch('https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6?' + params, {
      headers: { 'user-agent': UA, accept: '*/*', cookie: cookieHeader(jar), referer: 'https://user.qzone.qq.com/' + uin + '/main' }, signal: AbortSignal.timeout(timeout),
    })
    const text = await res.text()
    const post = parsePostJsonp(text)
    if (res.ok && post && post.code != null && Number(post.code) === 0) return { ok: true, post }
    const message = String(post?.message || ('详情接口暂不可用（HTTP ' + res.status + '）'))
    return { ok: false, code: post?.code != null ? Number(post.code) : null, message,
      throttled: res.status === 429 || /使用人数过多|稍后再试|繁忙|频繁|waf.tencent.com/.test(message + text.slice(0,300)),
      needCookie: /登录|login/i.test(message) }
  } catch { return { ok: false, message: '详情网络请求失败，稍后重试' } }
}

import { preserveCompletePictures } from './pictures.mjs'
import { preserveFullContent } from './content.mjs'
/**
 * lib/store.mjs —— 插件自己的「家」：配置、凭证、说说库、导出
 * ============================================================================
 * 家目录：`$DSH_HOME/qzone-echo/`（默认 `%USERPROFILE%\.dsh\qzone-echo\`）
 *   config.json      设置（Cookie 之外的偏好；Cookie 单独放，方便一把火烧掉）
 *   credential.json  { cookie, uin, savedAt }  ← 只在本机，不外发
 *   feed.jsonl       全部说说，一行一条（按 tid 去重、合并时后到的覆盖先到的）
 *   thoughts.jsonl   被判定为「个人思考/感想」的那一部分（也是导出时默认用的）
 *   out/             导出的 Markdown / JSON
 *   sync.log         每次同步的流水
 *
 * 为什么用 JSONL 而不是 SQLite：无依赖、能直接看、增量追加安全（断电最多坏最后一行）。
 * 读取时对坏行一律跳过 —— 隐私数据，宁可少一条也不要整库打不开。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { classify, isThought, isDream, CLASSIFY_VERSION } from './classify.mjs'
import { mdEmoji } from './emoji.mjs'

export const homeDir = () => process.env.QZONE_ECHO_HOME
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qzone-echo')

export const paths = () => {
  const home = homeDir()
  return {
    home,
    config: join(home, 'config.json'),
    credential: join(home, 'credential.json'),
    feed: join(home, 'feed.jsonl'),
    thoughts: join(home, 'thoughts.jsonl'),
    dreams: join(home, 'dreams.jsonl'),
    reviews: join(home, 'reviews.jsonl'),
    deleted: join(home, 'deleted.jsonl'),
    images: join(home, 'images'),
    out: join(home, 'out'),
    corrections: join(home, 'corrections.jsonl'),
    dismissed: join(home, 'dismissed.jsonl'),
    log: join(home, 'sync.log'),
  }
}

export const ensureHome = () => {
  const p = paths()
  for (const d of [p.home, p.out]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
  return p
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 原子写：先写 .tmp 再改名，避免写一半断电把文件搞坏 */
export function writeJson(file, obj) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  renameSync(tmp, file)
}

// ---------------------------------------------------------------- 配置

export const DEFAULT_CONFIG = {
  /** 每页拉多少条（实测 taotao 接口：num≤40 即按量给，>40 会静默退化成 10，所以 40 是天花板） */
  pageSize: 40,
  /** 一次同步最多收多少条（够把大号几千条一口气收完；翻页内部另有 10 分钟兜底） */
  maxPerSync: 12000,
  /** 归为「思考」的分数线（0~100），>= 这个分数才进 thoughts.jsonl */
  thoughtThreshold: 45,
  /** 同步时把新的思考自动导出成 Markdown */
  autoExport: false,
  /** 导出在哪 */
  exportDir: '',
  /** 配图存哪（空 = 插件家目录下的 images/） */
  imageDir: '',
  /** 同步完是否顺手把新配图也拉下来 */
  autoDownloadImages: false,
  /** 自动增量同步（定时器每跳一次判断该不该跑） */
  autoSync: false,
  /** 自动同步的间隔（小时，最小 1） */
  syncEveryHours: 6,
  /** 网页版的随机路径密钥（空 = 用默认的 /qzone）。只藏网址，数据靠口令挡 */
  webSecret: '',
}

export function getConfig() {
  const p = ensureHome()
  return { ...DEFAULT_CONFIG, ...(readJson(p.config, {}) || {}) }
}

export function saveConfig(patch) {
  const p = ensureHome()
  const next = { ...getConfig(), ...(patch || {}) }
  // 类型校准：布尔字段别被前端的字符串/undefined 弄成怪值（autoDownloadImages 这种开关尤其要稳）
  for (const [k, dv] of Object.entries(DEFAULT_CONFIG)) {
    const v = next[k]
    if (v === undefined || v === null) { next[k] = dv; continue }
    if (typeof dv === 'boolean') next[k] = v === true || v === 'true' || v === 1 || v === '1'
    else if (typeof dv === 'number') { const n = Number(v); next[k] = Number.isFinite(n) ? n : dv }
    else if (typeof dv === 'string') next[k] = typeof v === 'string' ? v : String(v)
  }
  writeJson(p.config, next)
  return next
}

// ---------------------------------------------------------------- 凭证

export function getCredential() {
  const c = readJson(paths().credential, null)
  if (!c || !c.cookie) return null
  return c
}

export function saveCredential(cookieText, uin) {
  const p = ensureHome()
  const next = { cookie: String(cookieText || '').trim(), uin: String(uin || ''), savedAt: new Date().toISOString() }
  writeJson(p.credential, next)
  try { /* 尽量收一下权限：Windows 上不一定生效，失败无所谓 */ }
  catch { /* noop */ }
  return next
}

export function clearCredential() {
  const p = paths()
  if (existsSync(p.credential)) writeJson(p.credential, { cookie: '', uin: '', savedAt: '' })
  return true
}

/** 只露尾巴，避免把整段 Cookie 打到日志/对话框里 */
export function maskCookie(text) {
  const s = String(text || '')
  if (!s) return ''
  const names = [...s.matchAll(/(?:^|[;\s])([A-Za-z0-9_\-]+)=([^;\s]+)/g)].map((m) => m[1])
  return `已保存（${names.length} 个字段：${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''}）`
}

// ---------------------------------------------------------------- 说说库

/**
 * 一条说说的唯一键。
 * ⚠️ 必须带 owner（QQ 号）：换了号再同步，两个号的 tid 可能撞上（tid 是空间侧的，
 *    不同号理论上独立但同一条转发/同一条被删后复用的场景会撞），撞了就会把别人的说说
 *    当"更新"覆盖掉 —— 2026-10-22 加测试号这条路时补的。
 */
const idOf = (m) => {
  const base = m.tid || createHash('sha1').update(`${m.ts}|${m.content}`).digest('hex').slice(0, 16)
  return m.owner ? `${m.owner}:${base}` : String(base)
}

export function readJsonl(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* 坏行跳过 */ }
  }
  return out
}

export const loadAll = () => {
  const list = readJsonl(paths().feed)
  const ov = loadOverrides()
  const dis = loadDismissed()
  return list.map((m) => {
    const id = m.id || idOf(m)
    // id 一律补齐：调用方（工具/网页）常要靠 id 回指某一条，缺了就只能拿 tid 猜
    let next = m.id === id ? m : { ...m, id }
    if (ov.has(id)) next = { ...next, thoughtOverride: ov.get(id) }
    // 兼容两种记录键：归一化的 `owner:tid` 和早期只写 tid 的
    const dk = dis.has(id) ? id : (m.tid && dis.has(String(m.tid)) ? String(m.tid) : '')
    if (dk) next = { ...next, dismissed: dis.get(dk) }
    return next
  })
}

/**
 * 老大手动对「已删除」栏里某一条的处理：`dismissed.jsonl` 一行一条 { id, dismissed, note, at }。
 *
 * 为什么需要它（2026-10-22 老大提的）：
 *   · 判定「删没删」永远会有假阳性 —— 本地库没同步过那个年份、正文被编辑过、删了重发，
 *     都会被判成「已删除」。规则再准也堵不住，必须留一个「这条其实是重复的/没删」的出口。
 *   · 而且这个判断**永远压过自动结论**，重算、重同步都不会被翻回去 —— 跟 corrections 一个待遇。
 */
export function loadDismissed() {
  const map = new Map()
  for (const rec of readJsonl(paths().dismissed)) {
    if (!rec || !rec.id) continue
    if (typeof rec.dismissed === 'boolean') map.set(String(rec.id), rec.dismissed)
  }
  return map
}

/**
 * 把某条从「已删除」栏里移出去（dismissed=true），或让它回来（dismissed=false / null 撤销）。
 * @param {string} id     tid 或 id（也接受不带 owner 前缀的 tid）
 * @param {boolean|null} dismissed  true=移出去；false/null=撤销，回到自动判
 */
export function setDismissed(id, dismissed, note = '') {
  const p = ensureHome()
  const key = String(id || '').trim()
  if (!key) return { ok: false, error: '要处理哪一条？没给 id/tid。' }
  if (dismissed === null || dismissed === undefined) {
    try {
      const rest = readJsonl(p.dismissed).filter((r) => String(r?.id || '') !== key)
      writeFileSync(p.dismissed, rest.map((r) => JSON.stringify(r)).join('\n') + (rest.length ? '\n' : ''), 'utf8')
    } catch (e) {
      return { ok: false, error: `写不进去：${e?.message ?? e}` }
    }
    const r0 = recomputeThoughts()
    return { ok: true, id: key, dismissed: null, undone: true, ...r0 }
  }
  const rec = { id: key, dismissed: Boolean(dismissed), note: String(note || ''), at: new Date().toISOString() }
  try { appendFileSync(p.dismissed, JSON.stringify(rec) + '\n', 'utf8') } catch (e) {
    return { ok: false, error: `写不进去：${e?.message ?? e}` }
  }
  const r = recomputeThoughts()
  return { ok: true, id: key, dismissed: rec.dismissed, ...r }
}

/** 一次性清空全部「移出已删除」记录 */
export function clearDismissed() {
  const p = ensureHome()
  let n = 0
  try {
    n = readJsonl(p.dismissed).length
    writeFileSync(p.dismissed, '', 'utf8')
  } catch (e) {
    return { ok: false, error: `写不进去：${e?.message ?? e}` }
  }
  recomputeThoughts()
  return { ok: true, cleared: n }
}

/**
 * 人工纠正：`corrections.jsonl` 里一行一条 { id, thought, note, at }。
 * 老大说「这条明明是分享绘本，不该算思考」时用它，永远压过自动打分。
 * （2026-10-22：规则再准也会有误判，留一个手动改口的路才是正解。）
 */
export function loadOverrides() {
  const map = new Map()
  for (const rec of readJsonl(paths().corrections)) {
    if (!rec || !rec.id) continue
    if (rec.thought === true || rec.thought === false) map.set(String(rec.id), rec.thought)
  }
  return map
}

export function setOverride(id, thought, note = '') {
  const p = ensureHome()
  const key = String(id || '').trim()
  if (!key) return { ok: false, error: '要标哪一条？没给 id/tid。' }
  // 撤销（thought 传 null）：把这条从 corrections 里抹掉，回到「按规则自动判」。
  // 2026-10-22 老大误点了三条 —— 光有「改」没有「撤」，点错就等于钉死了。
  if (thought === null || thought === undefined) {
    try {
      const rest = readJsonl(p.corrections).filter((r) => String(r?.id || '') !== key)
      writeFileSync(p.corrections, rest.map((r) => JSON.stringify(r)).join('\n') + (rest.length ? '\n' : ''), 'utf8')
    } catch (e) {
      return { ok: false, error: `写不进去：${e?.message ?? e}` }
    }
    const r0 = recomputeThoughts()
    return { ok: true, id: key, thought: null, undone: true, ...r0 }
  }
  const rec = { id: key, thought: Boolean(thought), note: String(note || ''), at: new Date().toISOString() }
  try { appendFileSync(p.corrections, JSON.stringify(rec) + '\n', 'utf8') } catch (e) {
    return { ok: false, error: `写不进去：${e?.message ?? e}` }
  }
  // 立刻按新口径重算两份派生文件，页面上的数字马上跟着动
  const r = recomputeThoughts()
  return { ok: true, id: key, thought: rec.thought, ...r }
}

/** 一次性清空所有人工纠正（回到「全按规则自动判」）—— 误点一堆时用 */
export function clearOverrides() {
  const p = ensureHome()
  let n = 0
  try {
    n = readJsonl(p.corrections).length
    writeFileSync(p.corrections, '', 'utf8')
  } catch (e) {
    return { ok: false, error: `写不进去：${e?.message ?? e}` }
  }
  recomputeThoughts()
  return { ok: true, cleared: n }
}

/**
 * thoughts.jsonl / dreams.jsonl 是「派生视图」：配图路径（localImages）、补录的评论
 * 这些后加的东西只写在 feed 里，派生文件里没有 —— 直接读会看到「图还是链接」。
 * 所以读派生视图时按 id 回 feed 补一次（feed 才是唯一真相源）。
 */
function hydrate(list) {
  if (!list.length) return list
  const byId = new Map(loadAll().map((m) => [idOf(m), m]))
  return list.map((m) => {
    const src = byId.get(m.id) || byId.get(idOf(m))
    if (!src) return m
    return {
      ...m,
      localImages: src.localImages || m.localImages || [],
      comments: (src.comments || []).length ? src.comments : m.comments,
      ...(src.owner ? { owner: src.owner } : {}),
    }
  })
}

export const loadThoughts = () => hydrate(readJsonl(paths().thoughts))
export const loadDreams = () => hydrate(readJsonl(paths().dreams))
/** 「介绍/推荐」派生视图：主体是讲别人的作品，不算个人思考，但也一条不丢 */
export const loadReviews = () => hydrate(readJsonl(paths().reviews))
/**
 * 「已经删掉的」派生视图（第四栏）：从历史消息列表补回来的那些。
 * 正文是 ellipsis-one 截断过的**摘要**，不是原文 —— 读的一侧别当成全文引用。
 */
export const loadDeleted = () => hydrate(readJsonl(paths().deleted))

/** 库里出现过哪些号（老数据没有 owner，记为 'unknown'） */
export function owners() {
  const map = new Map()
  for (const m of loadAll()) {
    const k = m.owner || 'unknown'
    map.set(k, (map.get(k) || 0) + 1)
  }
  return [...map.entries()].map(([uin, count]) => ({ uin, count })).sort((a, b) => b.count - a.count)
}

/**
 * 删掉某一个号的全部说说（连带 thoughts / dreams 两份派生文件一起重算）。
 * 默认 dryRun，真要删得显式传 apply: true —— 这种不可逆的活，不给自己留后悔的余地。
 * @param {string} uin  要删的号（'unknown' 可删老的无主数据）
 */
export function purgeOwner(uin, { apply = false } = {}) {
  const p = ensureHome()
  const want = String(uin || '').trim()
  if (!want) return { ok: false, error: '要删哪个号？没给 uin。' }
  const all = loadAll()
  const hit = all.filter((m) => String(m.owner || 'unknown') === want)
  const keep = all.filter((m) => String(m.owner || 'unknown') !== want)
  const summary = {
    ok: true, apply, uin: want,
    matched: hit.length, remaining: keep.length, total: all.length,
    ids: hit.slice(0, 5).map((m) => m.id),
  }
  if (!apply) return { ...summary, note: '只是预演，没动数据。真要删传 apply: true。' }
  if (!hit.length) return { ...summary, note: '这个号本来就没数据，什么都没变。' }

  writeFeed(keep)
  recomputeThoughts()
  // 被删的说说的配图也一起清（只删「不属于任何保留说说」的那些文件）
  let removedImages = 0
  try {
    const alive = new Set()
    for (const m of keep) for (const f of (m.localImages || [])) if (f) alive.add(f)
    let touchedFiles = 0
    for (const m of hit) {
      for (const f of (m.localImages || [])) {
        if (f && !alive.has(f)) {
          try { if (existsSync(f)) { unlinkSync(f); removedImages += 1; touchedFiles += 1 } } catch { /* 删不掉就算了 */ }
        }
      }
    }
    if (touchedFiles) logLine(`清掉 ${touchedFiles} 个配图文件（号 ${want}）`)
  } catch { /* 图清不掉不影响主数据 */ }
  logLine(`删掉号 ${want} 的 ${hit.length} 条说说，剩 ${keep.length} 条`)
  return { ...summary, removedImages, note: `删掉了 ${hit.length} 条，库里还剩 ${keep.length} 条。` }
}

/**
 * 合并新抓到的说说进库。按 (owner, tid) 去重；同一个键用「更新的抓取结果」覆盖。
 * @param {any[]} items
 * @param {{owner?:string}} [opts] owner = 这批说说属于哪个 QQ 号（测试号/多号场景靠它区分）
 * @returns {{added:number, updated:number, total:number, list:any[]}}
 */
export function mergeMoments(items, { owner = '' } = {}) {
  const p = ensureHome()
  const th = Number(getConfig().thoughtThreshold) || 45
  const existing = loadAll()
  const byId = new Map(existing.map((m) => [idOf(m), m]))
  let added = 0
  let updated = 0
  for (const raw of items) {
    const withOwner = owner ? { ...raw, owner: String(owner) } : raw
    let m = { ...withOwner, id: idOf(withOwner) }
    const prior = byId.get(m.id)
    if (prior) m = preserveCompletePictures(prior, preserveFullContent(prior, m))
    delete m.raw  // 原始 JSON 太长，不入库
    // ⭐ 入库时就把结论钉下来，别再让读的一侧各自猜；同时记下规则版本，
    //    规则一升级（CLASSIFY_VERSION 变了）读的一侧就会自动重算，不会被旧分数僵住。
    const cls = classify(m)
    m.score = cls.score
    m.kind = cls.kind
    m.clsVer = CLASSIFY_VERSION
    m.thought = isThought(m, th)   // ⭐
    m.dream = isDream(m)           // ⭐ 梦记单独标记（两栏分开）
    const old = byId.get(m.id)
    if (!old) { added += 1; byId.set(m.id, m) }
    else if (old.contentIncomplete !== m.contentIncomplete || old.contentSource !== m.contentSource || old.content !== m.content || (old.images || []).length !== (m.images || []).length
      || JSON.stringify(old.comments || []) !== JSON.stringify(m.comments || [])
      // 解析规则变了（比如新加了 share 解析）也要重新入库，否则老数据永远缺字段
      || JSON.stringify(old.share || null) !== JSON.stringify(m.share || null)
      // 转发解析同理：2026-10-22 补了 rt_uinname（转发作者名），
      // 不加这条老数据会一直留着空的 name，重新同步也刷不掉
      || JSON.stringify(old.forwarded || null) !== JSON.stringify(m.forwarded || null)
      // 2026-10-22 加了 picTotal（原帖图片总数，接口只给前 9 张）：老数据也要补上
      || (old.picTotal || 0) !== (m.picTotal || 0)
      || old.clsVer !== m.clsVer) {
      updated += 1
      // ⚠️ 二次同步别把已经落地的配图路径冲掉（localImages 是本地产物，服务端没有）
      byId.set(m.id, { ...old, ...m, localImages: old.localImages || m.localImages || [] })
    }
  }
  const all = [...byId.values()]
  // 一次性重写成"按时间倒序"，比无限追加干净；量级几千条也就一张小文件
  const tmp = `${p.feed}.tmp`
  writeFileSync(tmp, all.map((m) => JSON.stringify(m)).join('\n') + (all.length ? '\n' : ''), 'utf8')
  renameSync(tmp, p.feed)
  return { added, updated, total: all.length, list: all }
}

/** 全量重写 feed.jsonl（配图落地后要回写 localImages） */
export function writeFeed(list) {
  const p = ensureHome()
  const tmp = `${p.feed}.tmp`
  writeFileSync(tmp, list.map((m) => JSON.stringify(m)).join('\n') + (list.length ? '\n' : ''), 'utf8')
  renameSync(tmp, p.feed)
  return list.length
}

/** 把被判为「思考」的写进 thoughts.jsonl（全量重写，保持与 feed 一致） */
export function writeThoughts(list) {
  const p = ensureHome()
  const tmp = `${p.thoughts}.tmp`
  writeFileSync(tmp, list.map((m) => JSON.stringify(m)).join('\n') + (list.length ? '\n' : ''), 'utf8')
  renameSync(tmp, p.thoughts)
  return list.length
}

/** 把梦记写进 dreams.jsonl（同样是全量重写） */
export function writeDreams(list) {
  const p = ensureHome()
  const tmp = `${p.dreams}.tmp`
  writeFileSync(tmp, list.map((m) => JSON.stringify(m)).join('\n') + (list.length ? '\n' : ''), 'utf8')
  renameSync(tmp, p.dreams)
  return list.length
}

/** 「介绍/推荐」那一栏（全量重写） */
export function writeReviews(list) {
  const p = ensureHome()
  const tmp = `${p.reviews}.tmp`
  writeFileSync(tmp, list.map((m) => JSON.stringify(m)).join('\n') + (list.length ? '\n' : ''), 'utf8')
  renameSync(tmp, p.reviews)
  return list.length
}

/** 「已经删掉的」那一栏（第四栏，全量重写） */
export function writeDeleted(list) {
  const p = ensureHome()
  const tmp = `${p.deleted}.tmp`
  writeFileSync(tmp, list.map((m) => JSON.stringify(m)).join('\n') + (list.length ? '\n' : ''), 'utf8')
  renameSync(tmp, p.deleted)
  return list.length
}

/**
 * 「已经删掉的」这一栏到底收哪些条目 —— 单一判定口，UI/导出/配图都从这里走。
 *   ① recovered：从历史消息列表补回来的（正文是截断摘要）
 *   ② gone     ：逐条验活查出来真没了的（正文是本地全文，比摘要强得多）
 * 老大手动移出去的（dismissed）不算。
 */
export const isDeletedRow = (m) => Boolean(m) && !m.dismissed
  && ((m.recovered && m.possiblyDeleted !== false) || m.gone === true)

/** 不属于「已删除」、可以正常进思考/梦记/介绍推荐那三栏的 */
export const keepInOther = (m) => Boolean(m) && !m.recovered && !m.gone && !m.dismissed

/**
 * 重算「思考」与「梦记」两份（改阈值之后要立刻生效，不能等下次同步）。
 * 原来只重写 thoughts/dreams；2026-10-22 补上把标记写回 feed —— 否则 feed 里的 dream
 * 还是旧结论，读的一侧 `isDream(m)` 会因为「字段已存在」而不再现算，规则升级就僵住了。
 * 写回只动 thought / dream 两个布尔字段，正文一律不碰。
 */
export function recomputeThoughts(th = null) {
  const cfg = getConfig()
  const useTh = Number(th) || Number(cfg.thoughtThreshold) || 45
  const p = ensureHome()
  const all = loadAll()
  for (const m of all) {
    // ⭐ 重算就用最新规则重新打分 + 记版本，这样「规则升级」和「改阈值」是同一件事
    const cls = classify(m)
    m.score = cls.score
    m.kind = cls.kind
    m.clsVer = CLASSIFY_VERSION
    m.dream = isDream(m)                      // 梦记标记先定，思考那边要排掉梦
    m.thought = isThought(m, useTh)
  }
  const list = all.filter((m) => m.thought)
  const dreams = all.filter((m) => m.dream)
  const reviews = all.filter((m) => m.kind === 'review')
  // 第四栏「已经删掉的」，两个来源：
  //   ① 从历史消息列表补回来的（recovered，正文是截断摘要）
  //   ② 逐条验活查出来真没了的（gone，正文是**本地全文**，比摘要强得多）
  // ⚠️ 这一栏跟另外三栏**互斥**：混进思考/梦记里会被当成"还活着的原文"引用。
  // ⚠️ dismissed = 老大手动移出去的误判（「其实没删 / 是重复的」），既不算已删除，也不再露面。
  const deleted = all.filter(isDeletedRow)
  // ⚠️ thoughtOverride / dismissed 都是**运行时叠加上来的**（corrections.jsonl、dismissed.jsonl），
  // 绝不能写回任何文件 —— 写进去就变成「删了纠正也翻不回来」的死数据
  // （2026-10-22 踩过两次：探针改一条后 feed 被污染；dismiss 撤销后 dismissed:true 被固化在 feed 里）。
  for (const m of all) { delete m.thoughtOverride; delete m.dismissed }
  writeThoughts(list.filter(keepInOther))
  writeDreams(dreams.filter(keepInOther))
  writeReviews(reviews.filter(keepInOther))
  writeDeleted(deleted)
  try {
    const tmp = `${p.feed}.tmp`
    writeFileSync(tmp, all.map((m) => JSON.stringify(m)).join('\n') + (all.length ? '\n' : ''), 'utf8')
    renameSync(tmp, p.feed)
  } catch { /* feed 写不进去也不影响两份派生文件 */ }
  return {
    threshold: useTh,
    thoughts: list.filter(keepInOther).length,
    dreams: dreams.filter(keepInOther).length,
    reviews: reviews.filter(keepInOther).length,
    deleted: deleted.length,
    total: all.length,
  }
}

export const logLine = (msg) => {
  const p = ensureHome()
  try { appendFileSync(p.log, `[${new Date().toISOString()}] ${msg}\n`, 'utf8') } catch { /* 记不上就算了 */ }
}

// ---------------------------------------------------------------- 导出

const fmtTime = (ts) => {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const esc = (s) => mdEmoji(String(s || '').replace(/\r/g, ''))

/** 一份 Markdown：按年分组，每条带时间、正文、图、评论（含回复） */
export function toMarkdown(list, { title = '我的 QQ 空间说说', onlyThoughts = false, onlyDreams = false, onlyReviews = false, onlyDeleted = false, baseDir = '', showTid = false } = {}) {
  const byYear = new Map()
  for (const m of [...list].sort((a, b) => (b.ts || 0) - (a.ts || 0))) {
    const y = m.ts ? new Date(m.ts * 1000).getFullYear() : '未知时间'
    if (!byYear.has(y)) byYear.set(y, [])
    byYear.get(y).push(m)
  }
  const tint = onlyDeleted ? '（仅「已经删掉的」，正文是摘要）'
    : (onlyReviews ? '（仅「介绍/推荐」）'
      : (onlyDreams ? '（仅「梦记」）' : (onlyThoughts ? '（仅「个人思考/感想」）' : '')))
  const lines = [
    `# ${title}`,
    '',
    `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
    `- 条数：${list.length}${tint}`,
    '',
  ]
  for (const [y, items] of byYear) {
    lines.push(`## ${y}（${items.length} 条）`, '')
    for (const m of items) {
      lines.push(`### ${fmtTime(m.ts)}${showTid && m.tid ? ` · ${m.tid}` : ''}`)
      // 从历史消息补回来的：正文只是摘要，得说清楚，不然会被当成原文引用
      if (m.recovered) {
        lines.push('', `> ⚠️ 这条是**已经从空间删掉**的，正文只有历史消息里截断的摘要，原文找不回来了。`
          + (m.interactor ? `当年互动过的人：${m.interactor}` : ''))
      }
      if (m.content) lines.push('', esc(m.content))
      if (m.forwarded?.content) lines.push('', `> 转发自 ${m.forwarded.name || '他人'}：${esc(m.forwarded.content).replace(/\n/g, ' ')}`)
      // 分享卡片（音乐/视频/网页）：正文常常是空的，内容全靠这块
      if (m.share && (m.share.name || m.share.url || m.share.cardText?.length)) {
        const label = m.share.music ? '🎵 分享了一首歌' : '🔗 分享'
        const head = [m.share.name, m.share.url].filter(Boolean).join(' — ')
        if (head) lines.push('', `> ${label}：${head}`)
        for (const t of (m.share.cardText || []).slice(0, 2)) lines.push(`> ${esc(t)}`)
      }
      if (m.images?.length) {
        // 有落地文件就写成真正的图片引用（Markdown 能直接显示），否则退回链接
        const local = Array.isArray(m.localImages) ? m.localImages : []
        lines.push('', ...m.images.map((u, i) => {
          const f = local[i]
          if (!f) return `- 图 ${i + 1}：${u}`
          // 绝对路径在别的机器/别的编辑器里会挂 —— 有 baseDir 就写成相对导出口的路径
          // （图片在 家目录/images/，导出在 家目录/out/，是兄弟目录 → 会变成 ../images/2026/xxx.png）
          let rel = String(f)
          if (baseDir) {
            try { rel = relative(baseDir, String(f)) || String(f) } catch { rel = String(f) }
          }
          rel = rel.replace(/\\/g, '/')
          // 只对空格和括号编码；`*` 这类字符在 URL 里是合法的，编了反而可能打不开
          rel = rel.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')
          return `![图 ${i + 1}](${rel})`
        }))
      }
      if (m.comments?.length) {
        const total = m.comments.reduce((n, c) => n + (c.replies?.length || 0), 0)
        // 早先用过 <details><summary>，但它在「不渲染 HTML 的编辑器 / 聊天窗」里会原样漏标签，很难看
        const label = total ? `**评论 · ${m.comments.length} 条（附 ${total} 条回复）**` : `**评论 · ${m.comments.length} 条**`
        lines.push('', label, '')
        for (const c of m.comments) {
          // ⚠️ 评论者昵称里也会夹 QQ 表情码（`[em]e328018[/em]` 这种），以前只给正文过了 esc
          lines.push(`- ${esc(c.name) || c.uin}（${c.time}）：${esc(c.content)}`)
          for (const r of (c.replies || [])) {
            lines.push(`  - ↳ ${esc(r.name) || r.uin}（${r.time}）：${esc(r.content)}`)
          }
        }
        lines.push('')
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

export function exportMarkdown(list, { onlyThoughts = false, onlyDreams = false, onlyReviews = false, onlyDeleted = false, name = '', showTid = false } = {}) {
  const p = ensureHome()
  const cfg = getConfig()
  const dir = cfg.exportDir || p.out
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const kindTag = onlyDeleted ? 'deleted' : (onlyReviews ? 'reviews' : (onlyDreams ? 'dreams' : (onlyThoughts ? 'thoughts' : 'all')))
  const title = onlyDeleted ? '我删掉的 QQ 空间说说（摘要）' : (onlyReviews ? '我介绍/推荐过的东西' : (onlyDreams ? '我的梦记' : '我的 QQ 空间说说'))
  const file = join(dir, name || `qzone-${kindTag}-${stamp}.md`)
  writeFileSync(file, toMarkdown(list, { onlyThoughts, onlyDreams, onlyReviews, onlyDeleted, title, baseDir: dir, showTid }), 'utf8')
  return { file, count: list.length }
}

export function exportJson(list) {
  const p = ensureHome()
  const cfg = getConfig()
  const dir = cfg.exportDir || p.out
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const file = join(dir, `qzone-${stamp}.json`)
  writeFileSync(file, JSON.stringify(list, null, 2), 'utf8')
  return { file, count: list.length }
}

export const statOf = (file) => {
  try { const s = statSync(file); return { size: s.size, mtime: s.mtime.toISOString() } } catch { return null }
}

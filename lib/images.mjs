/**
 * lib/images.mjs —— 把说说里的配图拉到本地
 * ============================================================================
 * 为什么要单独一层：
 *   说说里的 `images` 只是腾讯 CDN 的链接，链接会过期、会改、会被删；
 *   想留档就得把字节拉下来。**拉图是本地磁盘 I/O，不烧 token** ——
 *   只有把图片喂给模型看才会烧。所以这里只下、不看、不往工具输出里塞路径列表。
 *
 * 落地规则：
 *   ~/.dsh/qzone-echo/images/<年>/<url 的 sha1 前 16 位>.<ext>
 *   · 相同 URL 只存一份（跨说说去重）
 *   · 已经存在就跳过（可 force 重下）
 *   · 下不下来的**不报错**，只是 localImages 那一位留空，下次还能再补
 *
 * ⚠️ 请求要带 Referer（qpic 有防盗链）+ Cookie（部分相册图要登录态）。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ensureHome, loadAll, writeFeed, getConfig, getCredential, logLine,
} from './store.mjs'
import { isThought, isDream } from './classify.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const REFERER = 'https://user.qzone.qq.com/'
/** 单张上限，超了就当坏链跳过（免得一张巨图塞爆磁盘） */
const MAX_BYTES = 20 * 1024 * 1024

const keyOf = (url) => createHash('sha1').update(String(url)).digest('hex').slice(0, 16)

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/bmp': '.bmp', 'image/avif': '.avif', 'image/heic': '.heic',
}

/** 先从 URL 里猜扩展名，猜不到再用 content-type */
function extOf(url, contentType) {
  try {
    const p = new URL(String(url)).pathname
    const m = /\.(jpe?g|png|gif|webp|bmp|avif|heic)$/i.exec(p)
    if (m) return `.${m[1].toLowerCase().replace('jpeg', 'jpg')}`
  } catch { /* 不是合法 URL 就走下面 */ }
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim()
  return EXT_BY_TYPE[ct] || '.jpg'
}

const cookieOf = () => {
  const cred = getCredential()
  return cred?.cookie ? cred.cookie : ''
}

/** 拉一张图；成功返回 { ok, file, bytes }，失败返回 { ok:false, error } */
async function fetchOne(url, { cookie = '', timeout = 20000 } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        referer: REFERER,
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        ...(cookie ? { cookie } : {}),
      },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const type = res.headers.get('content-type') || ''
    if (type && !/^image\//i.test(type)) return { ok: false, error: `不是图片（${type}）` }
    const len = Number(res.headers.get('content-length') || 0)
    if (len > MAX_BYTES) return { ok: false, error: `太大（${Math.round(len / 1048576)}MB）` }
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return { ok: false, error: '空文件' }
    if (buf.length > MAX_BYTES) return { ok: false, error: '太大' }
    return { ok: true, buf, ext: extOf(url, type), contentType: type }
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? '超时' : (e?.message || String(e)) }
  } finally {
    clearTimeout(timer)
  }
}

/** 按 scope / 年份挑出「有图但还没落地」的那些 */
function pickTargets({ scope = 'all', year = 0, force = false } = {}) {
  const th = Number(getConfig().thoughtThreshold) || 45
  let list = loadAll()
  if (scope === 'thoughts') list = list.filter((m) => isThought(m, th))
  else if (scope === 'dreams') list = list.filter((m) => isDream(m))
  if (year) list = list.filter((m) => m.ts && new Date(m.ts * 1000).getFullYear() === Number(year))
  return list.filter((m) => {
    if (!(m.images || []).length) return false
    if (force) return true
    const local = Array.isArray(m.localImages) ? m.localImages : []
    return local.length !== m.images.length || local.some((x) => !x)
  })
}

/**
 * 下载配图。
 * @param {object} opts
 * @param {'all'|'thoughts'|'dreams'} [opts.scope]
 * @param {number} [opts.year]        只下某一年的
 * @param {number} [opts.limit]       最多处理多少条说说（0=不限）
 * @param {number} [opts.concurrency] 并发数（默认 4，别把 CDN 打急）
 * @param {number} [opts.delay]       每个任务之间歇多少毫秒（默认 120）
 * @param {boolean}[opts.force]       已有文件也重下
 * @param {(p:{done:number,total:number})=>void} [opts.onProgress]
 */
export async function downloadImages(opts = {}) {
  const { scope = 'all', year = 0, limit = 0, concurrency = 4, delay = 120, force = false } = opts
  const p = ensureHome()
  const cfg = getConfig()
  const root = cfg.imageDir || p.images
  if (!existsSync(root)) mkdirSync(root, { recursive: true })

  const targets = pickTargets({ scope, year, force })
  const slice = limit > 0 ? targets.slice(0, limit) : targets

  // 这次要拉的所有「URL → 落地文件」先算好，同 URL 只下一次
  const jobs = []
  const done = new Map()      // url -> 相对家目录的路径 | null
  for (const m of slice) {
    const urls = m.images || []
    const y = m.ts ? new Date(m.ts * 1000).getFullYear() : 'unknown'
    const dir = join(root, String(y))
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      if (!url) continue
      const key = keyOf(url)
      if (!done.has(url)) {
        // 先探一遍已存在的（扩展名不定，扫一下目录）
        const hit = findExisting(dir, key)
        done.set(url, hit)
      }
      jobs.push({ m, idx: i, url, dir, key })
    }
  }

  const cookie = cookieOf()
  let ok = 0
  let skipped = 0
  let failed = 0
  let bytes = 0
  const errors = []

  // 简易 worker 池
  let cursor = 0
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]
      const known = done.get(job.url)
      if (known && !force) { skipped += 1; continue }
      if (delay) await new Promise((r) => setTimeout(r, delay))
      const r = await fetchOne(job.url, { cookie })
      if (!r.ok) {
        failed += 1
        if (errors.length < 12) errors.push({ url: job.url.slice(0, 120), error: r.error })
        continue
      }
      try {
        if (!existsSync(job.dir)) mkdirSync(job.dir, { recursive: true })
        const file = join(job.dir, `${job.key}${r.ext}`)
        writeFileSync(file, r.buf)
        done.set(job.url, file)
        ok += 1
        bytes += r.buf.length
      } catch (e) {
        failed += 1
        if (errors.length < 12) errors.push({ url: job.url.slice(0, 120), error: `写盘失败 ${e?.message || e}` })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, worker))

  // 把结果写回 feed（localImages 与 images 一一对齐）
  const all = loadAll()
  let touched = 0
  for (const m of all) {
    if (!(m.images || []).length) continue
    const y = m.ts ? new Date(m.ts * 1000).getFullYear() : 'unknown'
    const dir = join(root, String(y))
    const next = m.images.map((url) => {
      if (!url) return null
      const fromRun = done.get(url)
      if (fromRun) return fromRun
      return findExisting(dir, keyOf(url))
    })
    if (JSON.stringify(next) !== JSON.stringify(m.localImages || [])) {
      m.localImages = next
      touched += 1
    }
  }
  if (touched) writeFeed(all)

  const line = `配图：目标 ${jobs.length} 张（${slice.length} 条说说），新下 ${ok}，已存在 ${skipped}，失败 ${failed}`
  logLine(line)
  return {
    ok: true,
    posts: slice.length,
    urls: jobs.length,
    downloaded: ok,
    skipped,
    failed,
    bytes,
    touched,
    dir: root,
    errors,
    message: line,
  }
}

/** 目录里找 `key.*` 那个文件（扩展名不确定） */
function findExisting(dir, key) {
  for (const ext of ['.jpg', '.png', '.gif', '.webp', '.bmp', '.avif', '.heic']) {
    const f = join(dir, `${key}${ext}`)
    try { if (statSync(f).size > 0) return f } catch { /* 继续找 */ }
  }
  return null
}

/** 统计：有多少条说说带图、多少张已经落地、占多大地方 */
export function imageStats() {
  const p = ensureHome()
  const cfg = getConfig()
  const root = cfg.imageDir || p.images
  const all = loadAll()
  let postsWithImages = 0
  let urls = 0
  let local = 0
  for (const m of all) {
    const n = (m.images || []).length
    if (!n) continue
    postsWithImages += 1
    urls += n
    local += (m.localImages || []).filter(Boolean).length
  }
  return {
    dir: root,
    postsWithImages,
    urls,
    local,
    missing: Math.max(0, urls - local),
    size: dirSize(root),
  }
}

function dirSize(dir) {
  let total = 0
  const walk = (d) => {
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const f = join(d, e.name)
      if (e.isDirectory()) walk(f)
      else { try { total += statSync(f).size } catch { /* 跳过 */ } }
    }
  }
  walk(dir)
  return total
}

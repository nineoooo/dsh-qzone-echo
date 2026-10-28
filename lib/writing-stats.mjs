// Local character counts. No model calls and no QQ network requests.
import { looksTruncated } from './content.mjs'

export function writingText(value) {
  return String(value || '')
    .replace(/@?\{uin:\d+,nick:([^}]*?),(?:who|auto):[^}]*\}/g, '$1')
    .replace(/\[em\][\s\S]*?\[\/em\]/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]*\)/gi, '$1')
    .replace(/https?:\/\/[^\s<>\u3000-\u303f\uff00-\uffef]+/gi, '')
    .replace(/<\/?(?:a|p|br|div|span|details|summary|strong|em|b|i|img|blockquote|code|pre)\b[^>]*>/gi, '')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, m => {
      const named = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
      if (named[m.toLowerCase()] != null) return named[m.toLowerCase()]
      const n = m[2].toLowerCase() === 'x' ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10)
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
    })
}
export function countWriting(value, punctuation = false) {
  return (writingText(value).match(punctuation ? /[\p{L}\p{N}\p{P}]/gu : /[\p{L}\p{N}]/gu) || []).length
}
export function postPeriod(m) {
  const ts = Number(m.ts) || Date.parse(m.time || '') / 1000
  if (!Number.isFinite(ts) || !ts) return { year: '', month: '' }
  const d = new Date(ts * 1000 + 8 * 3600000)
  if (!Number.isFinite(d.getTime())) return { year: '', month: '' }
  const year = String(d.getUTCFullYear())
  return { year, month: year + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') }
}

/**
 * 东八区的年/月/日/时/分（说说时间戳都是北京时间，别用宿主的本地时区去拆 ——
 * 宿主跑在 UTC/海外时，「年」的划分会和 postPeriod 对不上）。
 */
export function cnTime(ts) {
  const d = new Date(Number(ts) * 1000 + 8 * 3600000)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    date: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  }
}
export function summarizeWriting(items, { owner = '', punctuation = false } = {}) {
  const years = {}, months = {}
  const total = { posts: 0, characters: 0, incomplete: 0, unverified: 0, undated: 0 }
  for (const m of items) {
    if (owner && m.owner && String(m.owner) !== String(owner)) continue
    const chars = countWriting(m.content, punctuation)
    const incomplete = m.contentIncomplete === true || m.truncated === true
    // ⚠️ 2026-10-28 修：原来 `unverified = !(contentSource==='detail' && contentIncomplete===false)`，
    //    把「没去过详情接口的短帖」全算成了待核对 —— 8240 条里 8060 条都中招，网页天天挂着
    //    「待核对 8060 篇」。其实要核对的是「疑似被截断的长文」，不是每一篇短帖。
    //    正确口径：启发式判「像被截断」且还没被明确标记为不全的，才算待核对。
    const unverified = looksTruncated(m) && !incomplete
    total.posts++; total.characters += chars
    total.incomplete += Number(incomplete); total.unverified += Number(unverified)
    const period = postPeriod(m)
    if (!period.year) total.undated++
    for (const [map, key] of [[years, period.year], [months, period.month]]) {
      if (!key) continue
      const row = map[key] ||= { posts: 0, characters: 0, incomplete: 0, unverified: 0 }
      row.posts++; row.characters += chars; row.incomplete += Number(incomplete); row.unverified += Number(unverified)
    }
  }
  return { total, years, months, punctuation, timezone: 'Asia/Shanghai' }
}

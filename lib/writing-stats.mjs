// Local character counts. No model calls and no QQ network requests.
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
export function summarizeWriting(items, { owner = '', punctuation = false } = {}) {
  const years = {}, months = {}
  const total = { posts: 0, characters: 0, incomplete: 0, unverified: 0, undated: 0 }
  for (const m of items) {
    if (m.recovered || m.dismissed || owner && m.owner && String(m.owner) !== String(owner)) continue
    const chars = countWriting(m.content, punctuation)
    const incomplete = m.contentIncomplete === true || m.truncated === true
    const unverified = !(m.contentSource === 'detail' && m.contentIncomplete === false)
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

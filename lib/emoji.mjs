/**
 * lib/emoji.mjs —— 把 QQ 的自带表情码还原成真表情图
 * ============================================================================
 * QQ 空间接口返回的正文里，自带表情是这种内嵌码：`[em]e188[/em]`
 * （e188 = 某种表情，数字跟 QQ 的表情表一一对应）。
 * 以前原样存下来 ⇒ 页面和导出的 Markdown 里就露着一串 `[em]e188[/em]`，很难看。
 *
 * 腾讯把这张图放在固定的 CDN 上，编号直接拼：
 *   https://qzonestyle.gtimg.cn/qzone/em/e188.gif
 * （实测 e188.gif / e100.gif 都是 200；部分编号只有 .png，所以带一个回退）
 *
 * 这里只做两件事：
 *   1. 认得出 `[em]eNNN[/em]`；
 *   2. 导出 Markdown 时换成真正能显示的图片。
 * 页面那边（client.js）自己按同样的正则渲染 <img>，不依赖这个模块。
 * ============================================================================
 */

/** `[em]e188[/em]` → 188 */
export const EMOJI_RE = /\[em\]e(\d+)\[\/em\]/gi

export const emojiUrl = (code) => `https://qzonestyle.gtimg.cn/qzone/em/e${Number(code)}.gif`
export const emojiPngUrl = (code) => `https://qzonestyle.gtimg.cn/qzone/em/e${Number(code)}.png`

/** 正文里有没有表情码 */
export const hasEmoji = (text) => EMOJI_RE.test(String(text || ''))

/** 清掉表情码（只想看文字时用，比如打分前的清洗） */
export const stripEmoji = (text) => String(text || '').replace(EMOJI_RE, '')

/**
 * 把表情码换成 Markdown 的内嵌图片。
 * 用 `![](url)` 而不是 HTML —— 很多编辑器（包括聊天窗里的预览）不认 HTML，但认 Markdown 图。
 * @param {string} text
 */
export const mdEmoji = (text) => String(text || '').replace(EMOJI_RE, (_m, code) => `![表情](${emojiUrl(code)})`)

/** 纯文本版：只留一个占位，给「摘要/日志」这种不需要图的地方用 */
export const plainEmoji = (text) => String(text || '').replace(EMOJI_RE, (_m, code) => `[表情${code}]`)

/** 这一条里出现过哪些表情编号（统计/调试用） */
export function emojiCodes(text) {
  const out = []
  const s = String(text || '')
  EMOJI_RE.lastIndex = 0
  let m
  while ((m = EMOJI_RE.exec(s))) out.push(Number(m[1]))
  return out
}

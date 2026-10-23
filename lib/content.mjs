// Parse the JSONP envelope without executing it or decoding JSON escapes twice.
export function parsePostJsonp(text) {
  let s = String(text || '').trim()
  if (!s.startsWith('{')) {
    const start = s.indexOf('('), end = s.lastIndexOf(')')
    if (start < 0 || end <= start) return null
    s = s.slice(start + 1, end)
  }
  try { return JSON.parse(s) } catch {
    // Some QQ responses use JavaScript hex escapes, which JSON does not accept.
    try { return JSON.parse(s.replace(/(?<!\\)((?:\\\\)*)\\x([\da-f]{2})/gi, '$1\\u00$2')) } catch { return null }
  }
}

export function postContent(post) {
  if (!post || typeof post !== 'object') return ''
  const content = typeof post.content === 'string' ? post.content : ''
  const parts = Array.isArray(post.conlist) ? post.conlist : []
  // Ignore cards/attachments; never search nested comments for a matching key.
  const joined = parts.filter(p => Number(p?.type) === 2 && typeof p.con === 'string').map(p => p.con).join('')
  if (!content) return joined
  if (joined.length > content.length && joined.startsWith(content.replace(/(?:…|\.{3})\s*$/, ''))) return joined
  return content
}

export const hasMoreContent = p => p?.has_more_con === true || Number(p?.has_more_con) === 1

/** 腾讯那边对正文的硬上限（2026-10-23 实测：列表/详情默认都按「渲染后 500 字」截断） */
export const TRUNC_LIMIT = 500

/**
 * 「渲染长度」：腾讯按**显示出来的字数**算 500 上限，而正文里 QQ 自带表情是 `[em]e188[/em]`
 * 这种一长串内嵌码 —— 显示时只占 1 个字。
 * 直接拿 content.length 量，会把「塞了几个表情的 420 字帖」误判成超长，
 * 也会让「498 字 + 3 个表情」这种真·被截的帖子算错位。
 */
export function renderedLength(text) {
  const s = String(text || '')
  let n = s.length
  const re = /\[em\][^[\]]*\[\/em\]/g
  let m
  while ((m = re.exec(s))) n += 1 - m[0].length
  return n
}

/**
 * 这条正文看着像被截断了吗？（给「老数据回填」挑候选，不查全库）
 * 判据按可靠性排：接口明说还有更多 > 正好卡在 500 上限 > 长文断在半句上。
 * ⚠️ 尾部省略号在短帖里是正常修辞（实测 226 条以省略号结尾，其中 222 条不到 200 字），
 *    所以必须加长度门槛，不然会把「今天好累……」这种全拉去查一遍。
 *
 * ⚠️ 2026-10-23 补第三条判据「断在半句」：
 *    腾讯这个 500 上限是按**字节**算的，不是字数 —— 中文 3 字节，所以纯中文约 500 字，
 *    但**混了换行/英文/数字就提前截**（实测 447 字那条被切在「那时候感觉开」，
 *    详情接口能拿到 2603 字）。只盯「>=490 字」会漏掉整整一批。
 *    代价是误报：长文本来就常常不写句号（实测已确认完整的帖子里 18% 结尾没标点），
 *    所以门槛压到 300 字以上，多查几次总比漏掉强，查完会被 contentIncomplete=false 记住不再排。
 */
export function looksTruncated(m, limit = TRUNC_LIMIT) {
  const content = String(m?.content || '')
  if (!content.trim()) return false
  if (m?.contentIncomplete === true) return true
  // 详情接口已经确认过「这就是全部」（not_trunc_con=1 拿到全文、它自己没报 has_more_con）：
  // 长本身不是罪 —— 转发长文能到两三千字，再按 500 字那把尺子量就会把它判成「还是被截的」，
  // 于是修一次、再修一次，永远排不完的队。
  // ⚠️ 只认「详情确认过」这一种；列表接口给 false 只是「列表没报 more」，证据不够，继续按启发式判。
  if (m?.contentIncomplete === false && m?.contentSource === 'detail') return false
  const len = renderedLength(content)
  if (len >= limit - 10) return true   // 恰好 500 的一定是被截的；490 以上宁可多查
  if (len < 300) return false          // 短帖不管怎么收尾都不查（省略号、没句号都正常）
  if (/(?:…|\.{3})\s*$/.test(content)) return true
  // 断在半句：末尾既不是标点也不是表情码/括号，说明很可能被硬切了
  return !SENTENCE_END.test(content.trimEnd())
}

/** 句末「像说完了」的收尾：标点、表情码、括号、常见语气词/拉丁字母收尾都放行 */
const SENTENCE_END = /(?:[。！？!?~～…、，,．.；;：:）)\]】」』”"'》>》]|\[\/em\]|[wW]|[a-zA-Z0-9])\s*$/

// Only preserve an older body when the incoming body is an identifiable preview.
export function preserveFullContent(old, incoming) {
  if (!old?.content || incoming.contentSource === 'detail' && incoming.contentIncomplete === false) return incoming
  const short = String(incoming.content || '').replace(/(?:…|\.{3})\s*$/, '').trimEnd()
  if (incoming.contentIncomplete && old.content.length > short.length && old.content.startsWith(short)) {
    return { ...incoming, content: old.content, rawContent: old.rawContent || old.content,
      contentSource: old.contentSource, contentIncomplete: old.contentIncomplete === true }
  }
  return incoming
}

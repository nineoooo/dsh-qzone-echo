/**
 * lib/classify.mjs —— 把说说分成「个人思考 / 感想」和别的东西
 * ============================================================================
 * 目标（老大原话）：「找主要关于个人的思考与感想的说说」。
 * ⇒ 纯转发、纯图、打卡、广告、@ 人、链接搬运都不算；**有自己的想法、情绪、反思**才算。
 *
 * 做法：不用装模型，纯规则打分（中文线索词 + 结构特征），给出 0~100 分 + 理由。
 *   · 高权重：第一人称 + 反思/情绪/认知动词（觉得、发现、明白、想起……）
 *   · 中权重：自我指涉（我、自己）、时间感慨、生活题材词
 *   · 负权重：转发原文占主体、纯图无文、纯链接、打卡广告、@ 人、表情刷屏、极短
 * 分数只用于排序和分层，最终要不要留由 Agent（读内容后）决定 —— 规则永远会有误判。
 *
 * 2026-10-22 第二次校准（老大指出「打分感觉不对，比如只是分享绘本没有太多思考表达」）：
 *   ⭐ 加了「句级自我声音」判定 —— 以前整段文本一锅算，书评/荐物里转述别人的句子
 *      （「这本书讲述了…」「画风让人…」）里的情绪词也被当成老大自己的想法。
 *      现在只有**带第一人称、且不是介绍句**的句子才计反思/情绪分。
 *   ⭐ 新增 kind = 'review'（介绍/推荐/书评型）：主体是「讲别人写的东西」，
 *      按转述占比扣分；转述占主导的直接不算思考 —— 但仍留在「全部」里，一条不丢。
 * ============================================================================
 */

/**
 * 规则版本号。每次改词表/加权/阈值语义都要 +1 ——
 * 库里存着入库当时的 score/kind，版本一变就必须重算，否则老数据永远停在旧结论上
 * （2026-10-22：绘本那几条就是这么留在「思考」栏里的）。
 */
export const CLASSIFY_VERSION = 4

/** 反思/认知/情绪类动词 —— 出现在第一人称句子里，最像「想事情」 */
const REFLECT = [
  '觉得', '感觉', '发现', '明白', '懂了', '想通', '意识到', '突然想', '才知道', '原来',
  '想起', '回忆', '记得', '怀念', '后悔', '遗憾', '庆幸', '感谢', '珍惜', '舍不得',
  '希望', '期待', '害怕', '担心', '纠结', '犹豫', '释然', '放下', '接受', '承认',
  '反思', '长大', '成长', '变了', '变成', '学会', '习惯', '选择', '决定', '坚持', '放弃',
  '其实', '好像', '也许', '大概', '或许', '可能', '不一定', '说到底', '总之', '毕竟',
]

/** 生活/人生题材词 —— 给「思考」加分，但不单独成立 */
const THEME = [
  '生活', '人生', '时间', '青春', '以后', '未来', '过去', '现在', '世界', '自己',
  '工作', '学习', '朋友', '家人', '爸妈', '家里', '喜欢的人', '喜欢', '讨厌',
  '孤独', '安静', '难过', '开心', '累', '迷茫', '自由', '意义', '答案', '问题',
  '梦', '夜', '雨', '风', '光', '路', '海', '山', '城市', '远方', '家',
  '值得', '不容易', '没办法', '总得', '得学着', '慢慢',
]

/** 明显不是「个人思考」的信号 */
const NEG = [
  '转发', '转自', '分享', '原文', 'via', '戳链接', '点击', '扫码', '关注', '抽奖',
  '优惠', '活动', '报名', '招聘', '代购', '团购', '广告', '推广', '福利', '红包',
  '打卡', '签到', '第几天', '连签', '步数', '运动', '排行',
  '@', '哈哈哈哈哈', '#', '【', '】',
]

const CN_PUNCT = /[，。！？…、；：""''（）《》—]/g

/**
 * 「梦」的线索词（2026-10-22 老大要求：梦单独一栏，不和思考混）。
 * ⚠️ 只认真正在写梦的词 —— 「梦想」不算梦记，「梦寐以求」也不算。
 *   所以 `梦想` / `梦寐` / `同床异梦` 这类固定搭配要被"消掉"之后再看有没有"梦"。
 */
const DREAM_WORDS = [
  '梦见', '梦到', '做梦', '梦里', '梦境', '梦见了', '梦到了',
  '噩梦', '美梦', '好梦', '怪梦', '梦里梦', '梦游',
  '睡梦', '午睡梦', '醒了才想起', '在梦里',
]

/** 这些词里的「梦」不是梦记，先抹掉再判 */
const DREAM_FALSE_POSITIVE = /梦想|梦寐|同床异梦|梦之队|中国梦|白日梦(?=想)|夜长梦多|魂牵梦萦|如梦令|红楼梦|梦华录/g

/**
 * 这条是不是「梦记」。
 * @returns {{isDream:boolean, hits:string[]}}
 */
export function detectDream(m) {
  const content = String(m?.content || '')
  if (!content) return { isDream: false, hits: [] }
  const base = content.replace(DREAM_FALSE_POSITIVE, '')
  const hits = DREAM_WORDS.filter((w) => base.includes(w))
  // 兜底：句子里单独出现「梦」并且搭配了"睡/醒/夜/梦里发生的事"这类语境，也算
  const loose = /梦/.test(base) && /(睡|醒|半夜|凌晨|夜里|昨晚|中午睡)/.test(base)
  return { isDream: hits.length > 0 || loose, hits: hits.length ? hits : (loose ? ['梦+睡/醒语境'] : []) }
}


const countHits = (text, words) => {
  let n = 0
  const hit = []
  for (const w of words) {
    if (!w) continue
    if (text.includes(w)) { n += 1; hit.push(w) }
  }
  return { n, hit }
}

/** 去掉表情 / 多余空白，估算「真正写了多少字」 */
function cleanLen(s) {
  const t = String(s || '')
    .replace(/\[em\][^[]*\[\/em\]/gi, '')       // [em]e188[/em] QQ 自带表情
    .replace(/\[[^\]]{1,8}\]/g, '')            // [微笑] 这类表情
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length
}

/**
 * 介绍 / 推荐 / 书评 / 荐物 的句子标记。
 * 这类句子写的是「别人做的东西怎么样」，不是「我自己在想什么」——
 * 以前这些句子里的「让人」「感受不到」被算进了老大的情绪词，绘本那条因此冲到 91 分。
 */
const REVIEW_SENT = [
  '今日绘本', '这本书', '该书', '书中', '讲述', '讲了', '故事讲', '绘本', '作者', '插图',
  '画风', '出版社', '译者', '译作', '推荐', '安利', '测评', '开箱', '介绍', '内容简介',
  '文字风格', '构图', '色彩', '这本书里', '主角', '情节', '结局是',
]

/** 书名号里的是作品名，不是他说的话 —— 先抹掉再判句式 */
const stripTitles = (s) => String(s || '').replace(/《[^》]{0,80}》/g, ' 《》 ')

/**
 * ★ 2026-10-22 第三次校准（老大：「我只是分享一些绘本，没有太多思考表达」）
 *   光看「转述占比」还不够：绘本那条里「夜的故事总是充满魅力的」「动物每一次叠加…」
 *   这些句子既没有第一人称、也没有"这本书/讲述"这类字眼，于是被算成了他自己的话。
 *   真正的判别特征是**这一条整体是「在介绍一本作品」**：
 *     · 有书名号《…》
 *     · 并且带作者/译者/图文 这类出版信息行
 *     · 或者开头就是「今日绘本NN」「书评」「荐书」这种系列标题
 *   ⇒ 这类整条判 review（介绍/推荐），不进「思考」栏，但一条不丢，另有一栏可查。
 */
const REVIEW_HEAD = /^(今日绘本|绘本|荐书|书评|年度书单|读书笔记|番剧|漫画|动画|电影|新番|安利|测评)/

export function detectReview(content) {
  const s = String(content || '')
  if (!s.trim()) return { review: false, why: '' }
  const hasBook = /《[^》]{1,80}》/.test(s)
  const hasCredit = /(^|[\s　])(图|文|译|著|绘|作者|译者|出版|出版社|原作|作画)\s*[:：]/.test(s)
    || /\[[日英美法德俄韩意]\s*[^\]]{0,20}\]/.test(s)   // 图：[日]松冈达英
  const head = REVIEW_HEAD.test(s.trim().split('\n')[0].trim())
  if (head) return { review: true, why: `系列标题「${s.trim().split('\n')[0].slice(0, 12)}」` }
  if (hasBook && hasCredit) return { review: true, why: '书名 + 作者/译者行' }
  return { review: false, why: '' }
}

/** 按句切开（中文句末标点 + 换行） */
const splitSentences = (s) => String(s || '')
  .split(/[。！？!?…\n]+/)
  .map((x) => x.trim())
  .filter(Boolean)

/**
 * @param {object} m  normalize() 过的说说
 * @returns {{score:number, kind:'thought'|'forward'|'media'|'short'|'misc'|'share'|'review', reasons:string[]}}
 */
export function classify(m) {
  const content = String(m?.content || '')
  const len = cleanLen(content)
  const fwd = m?.forwarded && (m.forwarded.content || m.forwarded.name)
  const imgs = Array.isArray(m?.images) ? m.images.length : 0
  const share = m?.share && (m.share.name || m.share.url) ? m.share : null
  const reasons = []
  let score = 0

  // ⓪ 分享卡片（歌 / 视频 / 网页）：正文常常是空的，内容在卡片里
  //    —— 这种是「我分享了它」，不是「我在想什么」，别让它冒充思考
  if (share) {
    score -= 26
    reasons.push(m.share.music ? '分享了一首歌' : '分享卡片')
  }

  // ① 第一人称 / 自我指涉 —— 「个人的」思考，主体得是自己
  const bare = stripTitles(content)
  const firstPerson = /(^|[^\w])我(?!们)|自己|自个儿/.test(bare)
  if (firstPerson) { score += 18; reasons.push('第一人称/自我指涉') }

  // ①.5 ⭐ 句级「自我声音」：只有带第一人称、且不是介绍句的句子，才算他自己的话
  const sents = splitSentences(bare)
  const selfSents = []
  let reviewChars = 0
  let totalChars = 0
  for (const s of sents) {
    const n = s.replace(/\s+/g, '').length
    totalChars += n
    const isReview = REVIEW_SENT.some((w) => s.includes(w)) && !/(^|[^\w])我(?!们)/.test(s)
    if (isReview) reviewChars += n
    else if (/(^|[^\w])我(?!们)|自己|自个儿/.test(s) || !REVIEW_SENT.some((w) => s.includes(w))) selfSents.push(s)
  }
  const reviewRatio = totalChars ? reviewChars / totalChars : 0
  const selfText = selfSents.join('。')

  // ② 反思、认知、情绪动词 —— 只在「自己的句子」里数
  const r = countHits(selfText, REFLECT)
  if (r.n) {
    score += Math.min(34, r.n * 11)
    reasons.push(`反思/情绪词：${r.hit.slice(0, 4).join('、')}`)
  }
  // 整段里也数一遍，但只给很少的分（避免到处是「想」「觉」的转述句白拿分）
  const rAll = countHits(bare, REFLECT)
  if (rAll.n > r.n) score += Math.min(8, (rAll.n - r.n) * 2)

  // ③ 题材词（不单独成立，只是加权）—— 同样只认自己的句子
  const t = countHits(selfText, THEME)
  if (t.n) {
    score += Math.min(16, t.n * 4)
    reasons.push(`题材词：${t.hit.slice(0, 4).join('、')}`)
  }

  // ④ 篇幅：太短基本不是「思考」，中等偏长最像
  if (len >= 15 && len <= 400) { score += 14; reasons.push(`篇幅 ${len} 字`) }
  else if (len > 400) { score += 8; reasons.push(`长文 ${len} 字`) }
  else if (len >= 8) { score += 4 }
  else { score -= 8; reasons.push(`太短（${len} 字）`) }

  // ⑤ 真正的句子感：有标点、多句
  const punct = (content.match(CN_PUNCT) || []).length
  if (punct >= 3) { score += 10; reasons.push('多句成段') }
  else if (punct >= 1) score += 4

  // ⑥ 转发：原文占主体 ⇒ 不是他自己的思考
  if (fwd) {
    const fwdLen = cleanLen(m.forwarded.content)
    if (fwdLen > len) { score -= 30; reasons.push('主体是转发原文') }
    else { score -= 10; reasons.push('带转发，但有自己写的部分') }
  }

  // ⑦ 纯图无文
  if (imgs && len < 6) { score -= 20; reasons.push('纯图无文字') }

  // ⑧ 打卡 / 广告 / @ 人 / 表情刷屏
  const neg = countHits(content, NEG)
  if (neg.n) {
    score -= Math.min(24, neg.n * 8)
    reasons.push(`降权信号：${neg.hit.slice(0, 4).join('、')}`)
  }
  if (/^https?:\/\//.test(content.trim()) && len < 40) { score -= 20; reasons.push('基本是一条链接') }
  const emo = (content.match(/\[[^\]]{1,8}\]/g) || []).length
  if (emo >= 6 && len < 20) { score -= 12; reasons.push('表情为主') }

  // ⑨ 单句陈述句（"今天好累"）—— 有点情绪，但不算思考
  if (!r.n && firstPerson && len < 12) score -= 6

  // ⑩ ⭐ 介绍/推荐型（书评、荐物、绘本介绍）—— 按转述占比扣分
  //    老大 2026-10-22：「我只是分享一些绘本，没有太多思考表达」
  //    以前绘本那条 91 分，全是被"讲述了一个故事""让人忍不住""感受不到"这些转述句骗的。
  const reviewLike = reviewRatio >= 0.35 || REVIEW_SENT.some((w) => w === '今日绘本' && content.includes(w))
  if (reviewLike) {
    const cut = Math.min(46, Math.round(reviewRatio * 62) + 8)
    score -= cut
    reasons.push(`介绍/推荐型（转述占 ${Math.round(reviewRatio * 100)}%，扣 ${cut}）`)
  }

  // ⑩.5 ⭐ 整条就是「在介绍一部作品」⇒ 直接压到思考线以下
  //      判别：系列标题（今日绘本NN…）/ 书名号 + 作者译者行。
  //      ⚠️ 只扣分、不改写正文 —— 它仍然在库里、在「全部」里能翻到。
  const rv = detectReview(content)
  if (rv.review) {
    score -= 42
    reasons.push(`作品介绍型（${rv.why}）`)
  }

  score = Math.max(0, Math.min(100, Math.round(score)))

  let kind = 'misc'
  if (share && !len) kind = 'share'
  else if (!len && !imgs) kind = 'short'
  else if (fwd && cleanLen(m.forwarded.content) > len) kind = 'forward'
  else if (imgs && len < 6) kind = 'media'
  else if (len < 6) kind = 'short'
  // ⭐ 预告/介绍整部作品 ⇒ 单列「介绍/推荐」，不进思考栏，但库里留着
  else if (rv.review) kind = 'review'
  // ⭐ 转述压倒自己的话（自己几乎没说什么）⇒ 单列「介绍/推荐」，不进思考栏，但库里留着
  else if (reviewLike && reviewRatio >= 0.6 && r.n <= 1) kind = 'review'
  else if (score >= 45) kind = 'thought'

  // ⑪ 梦记：单独一类，**不**跟着「思考」走（老大要求两栏分开）
  //    梦记哪怕很短、哪怕只有一句，也算梦 —— 醒来记一句往往就是这么短。
  const dream = detectDream(m)
  if (dream.isDream) reasons.push(`梦记：${dream.hits.join('、')}`)

  return { score, kind, dream: dream.isDream, dreamHits: dream.hits, reasons }
}

/** 给一批说说打分并按分数排（不打乱时间顺序信息） */
export function scoreAll(list) {
  return list.map((m) => ({ ...m, ...classify(m) }))
}

/**
 * 「特殊条目」：已经归到「已删除」那一栏、或者被老大手动移出去的。
 * 它们**不参与**思考/梦记/介绍推荐三条判定 —— 单独一栏，四者互斥。
 *   · recovered  从历史消息列表补回来的（正文是截断摘要）
 *   · gone       逐条验活查出来真没了的（正文是本地全文）
 *   · dismissed  老大手动说「这条不算已删除」的误判
 */
export const isSpecial = (m) => Boolean(m && (m.recovered || m.gone === true || m.dismissed))

/**
 * 这一条算不算「梦记」。
 * 优先用入库时存下的 dream 标记；没有就现算 —— 老库里的数据也能立刻被认出来。
 */
export function isDream(m) {
  if (isSpecial(m)) return false      // 「已删除」是单独一栏，跟梦记/思考互斥
  if (m && typeof m.dream === 'boolean') return m.dream
  return detectDream(m).isDream
}

/**
 * 这一条算不算「介绍/推荐」（书评、绘本介绍、荐物、番剧安利）。
 * 主体是「讲别人的作品」，所以不算个人思考；但也不丢，单列一栏能翻到。
 */
export function isReview(m) {
  if (isSpecial(m)) return false      // 已删除的单列一栏，不参与「介绍/推荐」判定
  const c = (!m || m.clsVer !== CLASSIFY_VERSION || (m.score == null && !m.kind)) ? classify(m) : null
  const kind = c ? c.kind : (m?.kind || 'misc')
  return kind === 'review'
}

/**
 * 这一条算不算「个人思考/感想」。
 * 优先用入库时存下的 score/kind；库里没有（老数据、手工塞进来的）就现算 ——
 * 这样阈值改了之后，读的一侧也能立刻跟上，不会因为库里存了旧结论就僵住。
 * ⚠️ 梦记**不算**思考：两栏是分开的（老大 2026-10-22 定的）。
 * ⚠️ 「介绍/推荐型」（review）也不算思考：主体是讲别人的东西。
 * ⚠️ 老大手动改过判定的，以手动那份为准（overrides）。
 */
export function isThought(m, th = 45, override = undefined) {
  // ⭐ 「已删除」那一栏是独立分组，不参与思考/梦记判定
  if (isSpecial(m)) return false
  const ov = override !== undefined ? override : m?.thoughtOverride
  if (ov === false) return false
  if (ov === true) return true
  if (isDream(m)) return false
  // ⭐ 规则版本对不上 ⇒ 一律现算。库里那份分数是旧规则打的，不能拿来当判决。
  const fresh = !m || m.clsVer !== CLASSIFY_VERSION
  const c = (m && !fresh && (m.score != null || m.kind)) ? null : classify(m)
  const score = c ? c.score : (m?.score ?? 0)
  const kind = c ? c.kind : (m?.kind || 'misc')
  if (kind === 'forward' || kind === 'media' || kind === 'short' || kind === 'review') return false
  return score >= (Number(th) || 45)
}

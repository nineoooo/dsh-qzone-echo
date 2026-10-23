import { imageJobStatus, configureImageJob, runImageJobTick } from './lib/image-job.mjs'
import { completeMissingPictures } from './lib/image-repair.mjs'
import { countWriting, postPeriod, summarizeWriting } from './lib/writing-stats.mjs'
import { repairStatus, configureRepair, repairBatch } from './lib/repair.mjs'
/**
 * dsh-qzone-echo —— host 半端
 * ============================================================================
 * 它是什么：把**老大自己 QQ 空间发过的说说**收进本地库（`$DSH_HOME/qzone-echo/`），
 * 并且把里面「个人的思考 / 感想」那一类单独标出来、能查能导。
 *
 * 为什么这么做（不是抄个爬虫就完事）：
 *   1. 空间接口认 Cookie（uin + p_skey/skey → g_tk），所以走「粘贴一次 Cookie」这条路，
 *      不做扫码 —— 扫码那套要过登录链跳转，脆且容易触发风控。
 *   2. 数据是**私人的**：只落在本机 `$DSH_HOME` 下，不上传任何地方；Cookie 也单独一个文件。
 *   3. 「思考/感想」不做成一刀切的过滤器，而是**打分 + 理由**，让 Agent 读原文再决定；
 *      规则永远会误判，工具只提供排序和线索。
 *
 * 对外提供：
 *   · 工具：qzone_echo_login / status / sync / list / thoughts / export
 *   · 设置页（client.js）走 /api/qzone-echo/*
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  ensureHome, paths, getConfig, saveConfig, getCredential, clearCredential, maskCookie, DEFAULT_CONFIG,
  loadAll, loadThoughts, loadDreams, exportMarkdown, exportJson, statOf, homeDir, recomputeThoughts,
  purgeOwner, owners, setOverride, clearOverrides, loadOverrides, loadReviews, loadDeleted, logLine,
  isDeletedRow, setDismissed, clearDismissed, loadDismissed,
} from './lib/store.mjs'
import { syncOnce, saveCookie, stats, openSession, applyThreshold, autoSyncOnce, shouldAutoRun, autoState, syncHistory, historyState, syncVerify } from './lib/sync.mjs'
import { classify, isThought, isDream, isReview } from './lib/classify.mjs'
import { downloadImages, imageStats } from './lib/images.mjs'
import { page } from './lib/web.mjs'
import {
  lockEnabled, passMeta, setPass, clearPass, verifyPass,
  issueToken, checkToken, dropToken, tokenOf, randomPass, sessionCount,
} from './lib/auth.mjs'

export const name = 'qzone-echo'
export const inject = ['webServer', 'tools', 'settings']

export const Config = !z ? undefined : z.object({
  /** 每页拉多少条（实测：≤40 有效，>40 服务端静默退化成 10） */
  pageSize: z.natural().default(40).extra('volatile', true),
  /** 一次同步最多收多少条 */
  maxPerSync: z.natural().default(500).extra('volatile', true),
  /** 判定为「思考/感想」的分数线（0~100） */
  thoughtThreshold: z.natural().default(45).extra('volatile', true),
  /** 同步后自动导出一份 Markdown */
  autoExport: z.boolean().default(false).extra('volatile', true),
  /** 导出目录（空 = 插件家目录下的 out/） */
  exportDir: z.string().default('').extra('volatile', true),
  /** 配图存哪（空 = 插件家目录下的 images/） */
  imageDir: z.string().default('').extra('volatile', true),
  /** 同步完顺手把配图也拉下来 */
  autoDownloadImages: z.boolean().default(false).extra('volatile', true),
  /** 自动增量同步（把新发的说说不断收进来） */
  autoSync: z.boolean().default(false).extra('volatile', true),
  /** 自动同步间隔（小时） */
  syncEveryHours: z.natural().default(6).extra('volatile', true),
})

/** 宿主日志：走 console，DSH 会收进 profile 日志 */
const log = (m) => { try { console.log(`[qzone-echo] ${m}`) } catch { /* noop */ } }

/**
 * ⚠️ 2026-10-22 实测：`apply(ctx, config)` 传进来的 config 字段值**可能是对象**（schemastery 的
 *    `{type:'number', default:20}` 那坨被原样透传），`{...插件自己的 config.json, ...那么一坨}`
 *    ⇒ thoughtThreshold 变成对象、`>=` 恒 false ⇒ **一条都进不了 thoughts**，而且设置页显示也难看。
 *    ⇒ 一律按 DEFAULT_CONFIG 的类型挑一遍（拿不准就用默认值），客户端的 config.json 兜底。
 *    （bili-scroll 那个插件 2026-10-14 也因为同一类"config 不是标量"炸过，是同一个坑。）
 */
function normalizeCfg(src) {
  const out = {}
  for (const [k, dv] of Object.entries(DEFAULT_CONFIG)) {
    const v = src?.[k]
    if (v === undefined || v === null) continue
    if (typeof dv === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
    else if (typeof dv === 'boolean') { if (typeof v === 'boolean') out[k] = v }
    else if (typeof dv === 'string') { if (typeof v === 'string') out[k] = v }
  }
  return out
}

export function apply(ctx, config, cfgIn) {
  const hostCfg = config || cfgIn || {}
  const cfgOf = () => ({ ...getConfig(), ...normalizeCfg(hostCfg) })
  ensureHome()
  log(`已挂载（家=${homeDir()}）`)

  // ------------------------------------------------------------ 工具
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const tool = (spec) => {
    if (!ctx.tools?.register) return
    ctx.tools.register(defineTool({
      ...spec,
      // DSH expects a complete JSON Schema, not a bare property map.
      // ⚠️ additionalProperties:false 不能省 —— 宿主 defineTool 会校验，缺了直接抛错，
      //    apply() 中途崩掉 ⇒ 整条插件被判 failed（2026-10-22 就是这个原因起不来）。
      parameters: { type: 'object', properties: spec.parameters ?? {}, additionalProperties: false },
      output: textOutput,
      async execute(args, exec) { return safe(await spec.execute(args, exec)) },
    }))
  }

  tool({
    name: 'qzone_echo_login',
    description: '保存老大自己的 QQ 空间 Cookie（一次就够）。\n'
      + '从浏览器 **已登录 QQ 空间** 的页面里复制整段 Cookie（必须有 uin、p_skey 或 skey），'
      + '整段原样粘进来；会顺手验证一次能不能拉到说说列表。\n'
      + '⚠️ 这段 Cookie 等于账号钥匙：只存在本机 `$DSH_HOME/qzone-echo/credential.json`，不要贴到聊天/云文档里。',
    parameters: {
      cookie: { type: 'string', description: '整段 Cookie 文本（a=1; b=2; …）' },
      verify: { type: 'boolean', description: '存完顺手验证一次（默认 true）' },
    },
    async execute(args) {
      const text = String(args.cookie || '').trim()
      if (!text) return { ok: false, error: 'cookie 是空的' }
      const r = await saveCookie(text, { verify: args.verify !== false })
      if (!r.ok && r.error) return { ok: false, error: r.error, uin: r.uin || null, saved: Boolean(r.saved) }
      return {
        ok: true,
        uin: r.uin,
        verified: r.verified,
        hint: r.verified ? '验证通过，可以 qzone_echo_sync 了' : '已保存但这次没验成（可能风控/网络），稍后 qzone_echo_sync 再看',
        probe: r.probe,
        cookieSummary: maskCookie(text),
      }
    },
  })

  tool({
    name: 'qzone_echo_status',
    description: '看 QQ说说收集 现在什么状态：有没有 Cookie、库里多少条、多少条被判为「思考」、多少条「梦记」、多少条「介绍/推荐」、多少条「已经删掉的」、覆盖哪些年份、导出目录在哪。',
    parameters: {},
    async execute() {
      const cred = getCredential()
      const s = stats()
      const cfg = cfgOf()
      const p = paths()
      const gate = shouldAutoRun()
      return {
        loggedIn: Boolean(cred?.cookie),
        uin: cred?.uin || null,
        cookieSavedAt: cred?.savedAt || null,
        library: s,
        config: cfg,
        auto: { ...autoState(), nextRun: gate.run ? null : gate.nextAt || null, why: gate.why },
        home: p.home,
        exportDir: cfg.exportDir || p.out,
        files: {
          feed: statOf(p.feed),
          thoughts: statOf(p.thoughts),
          dreams: statOf(p.dreams),
          reviews: statOf(p.reviews),
          deleted: statOf(p.deleted),
          credential: statOf(p.credential) ? '已存在' : '无',
        },
      }
    },
  })

  tool({
    name: 'qzone_echo_sync',
    description: '把空间里的说说同步进本地库（按 tid 去重、增量合并）。\n'
      + '支持三种口径：默认真全量扫一遍；`month: "2021-06"` 只收那一个月（历史多的时候按月分批最稳）；'
      + '`incremental: true` 只收新发的（翻到库里已有的就停，最省时间，定时器就靠它）。\n'
      + '同步时顺手给每条打「思考/感想」分，同时把「梦记」单独挑出来。 Cookie 还没存过就先 qzone_echo_login。',
    parameters: {
      max: { type: 'number', description: '这次最多收多少条（默认按设置，通常 500）' },
      export: { type: 'boolean', description: '同步完是否顺手导出一份「思考」Markdown' },
      month: { type: 'string', description: '只收某一个月，写成 "2021-06"（可省）' },
      incremental: { type: 'boolean', description: '只收新发的（可省）' },
      startPos: { type: 'number', description: '从第几条开始翻（默认 0）。库里已经到某一年的最早一条时，想再往前挖就从这条的位置接着翻，不用把已有的几千条重翻一遍（可省）' },
    },
    async execute(args) {
      const r = await syncOnce({
        max: args.max ? Number(args.max) : undefined,
        export: args.export,
        month: args.month ? String(args.month) : '',
        incremental: kwargsTrue(args.incremental),
        startPos: args.startPos ? Number(args.startPos) : 0,
      })
      if (!r.ok) return r
      return {
        ...r,
        hint: '想挑出真正值得读的，用 qzone_echo_thoughts 拿候选、qzone_echo_dreams 拿梦记，再逐条读原文判断（分数只是线索，不要只看分数下结论）。',
      }
    },
  })

  tool({
    name: 'qzone_echo_history',
    description: '从「历史消息列表」补回**已经删掉的**说说（只有摘要，没有全文）。\n'
      + '原理：QQ 空间另有一份「谁在我某条说说下面评论/点赞过」的记录，说说删了它还在 —— '
      + '所以只要有互动过，就能捞回一条带时间和摘要的残影。\n'
      + '⚠️ 这条通道重：顺序翻页、每页隔 900ms，翻几十页可能要好几分钟，默认不该乱跑；'
      + '翻完会把「时间相近 + 摘要一致」的当成还活着剔掉，剩下的标 recovered + possiblyDeleted 入库。\n'
      + '⚠️ 正文是 ellipsis-one 截断过的摘要，不是原文 —— 别拿它当原话引用。',
    parameters: {
      maxPages: { type: 'number', description: '最多翻多少页（默认 50，一页 20 条；数字越大越慢也越容易被拦）' },
      intervalMs: { type: 'number', description: '页间隔毫秒（默认 900，别低于 500）' },
      resume: { type: 'boolean', description: '从上次断点继续（默认 true）' },
    },
    async execute(args) {
      const r = await syncHistory({
        maxPages: args.maxPages ? Number(args.maxPages) : undefined,
        intervalMs: args.intervalMs != null ? Number(args.intervalMs) : undefined,
        resume: args.resume !== false,
      })
      return r
    },
  })

  tool({
    name: 'qzone_echo_repair_longtext',
    description: '批量补全已入库说说的长文。action=start 启动后台断点修复，status 看进度，pause 暂停。优先查疑似长文，再核对其余非空旧正文；自动备份，正文只补长不缩短，遇限流冷却半小时。',
    parameters: { action: { type: 'string', enum: ['start', 'status', 'pause'], description: '默认 status' } },
    async execute(args) {
      return args.action === 'start' ? configureRepair({ enabled: true }) : args.action === 'pause' ? configureRepair({ enabled: false }) : repairStatus()
    },
  })

  tool({
    name: 'qzone_echo_verify',
    description: '⭐ 逐条验活：拿库里每条的 tid 直接问腾讯「这条还在不在」。**这才是判「删没删」的硬办法**。\n'
      + '活着的返回全文（还能顺便把本地缺的正文补上），删了的返回「该条内容已被删除」。\n'
      + '优点：跟有没有人评论过无关（没互动的说说删了也查得出）、跟正文改没改过无关（tid 不变就不影响）。\n'
      + '⚠️ 慢：平均约 1.2 秒/条，一轮只查一段（默认 300 条 ≈ 6 分钟），查过的打上时间戳、下次自动接着来，'
      + '所以可以反复调用直到 remaining=0。中途断了也不会重复查。\n'
      + '查出来已删的，正文用**本地全文**（比历史消息的摘要强），进「已删除」那一栏。',
    parameters: {
      max: { type: 'number', description: '这一轮最多查多少条（默认 300，别一次太大）' },
      intervalMs: { type: 'number', description: '每条间隔毫秒（默认 400，别低于 300）' },
      redo: { type: 'boolean', description: 'true=连查过的也重查一遍（默认 false，跳过查过的）' },
      since: { type: 'string', description: '只查这个日期之后发布的，如 2020-01-01（可省）' },
    },
    async execute(args) {
      const r = await syncVerify({
        max: args.max ? Number(args.max) : undefined,
        intervalMs: args.intervalMs != null ? Number(args.intervalMs) : undefined,
        redo: args.redo === true,
        since: args.since ? String(args.since) : '',
      })
      return r
    },
  })

  tool({
    name: 'qzone_echo_dismiss',
    description: '把「已删除」栏里某一条**移出去** —— 用于「它其实没删」或「这条是重复的」这种误判。\n'
      + '判定删没删永远会有假阳性（本地没同步过那个年份、正文被编辑过、删了重发），所以留这个手动出口。\n'
      + '移出去之后这条就不再出现在「已删除」栏，也**不会**混进思考/梦记；记录写进 dismissed.jsonl，'
      + '重算、重同步都不会被翻回来。给 undo=true 可以撤销（回到自动判）。\n'
      + 'tid 就是 qzone_echo_list 传 deletedOnly=true 之后返回的 tid（也可以用 id）。',
    parameters: {
      tid: { type: 'string', description: '要移出哪一条（tid 或 id）' },
      note: { type: 'string', description: '为什么移出（可省，给自己留个记录）' },
      undo: { type: 'boolean', description: 'true=撤销，让这条回到「已删除」栏（按自动判）' },
      undoAll: { type: 'boolean', description: 'true=清空全部移出记录（误点一堆时用）' },
    },
    async execute(args) {
      if (args.undoAll === true) {
        const r = clearDismissed()
        return r.ok === false ? r : { ...r, message: `清空了 ${r.cleared} 条移出记录，那些条目回到自动判。` }
      }
      const tid = String(args.tid || '').trim()
      if (!tid) return { ok: false, error: '要给 tid（清空全部则给 undoAll=true）' }
      const all = loadAll()
      let hit = all.find((m) => m.id === tid)
      if (!hit) hit = all.find((m) => String(m.tid) === tid)
      if (!hit) return { ok: false, error: `库里没有这条：${tid}` }
      if (!isDeletedRow(hit) && args.undo !== true) {
        return {
          ok: false, tid: hit.tid,
          error: '这条现在不在「已删除」栏里，没什么可移出的。',
          hint: '先用 qzone_echo_list 传 deletedOnly=true 看一眼要处理哪条。',
        }
      }
      if (args.undo === true) {
        const r = setDismissed(hit.id || tid, null)
        return { ...r, tid: hit.tid, message: '撤销了，这条回到按自动判（如果它被判定为已删，会重新出现在那一栏）。' }
      }
      const r = setDismissed(hit.id || tid, true, args.note)
      return {
        ...r,
        tid: hit.tid,
        content: String(hit.content || '').slice(0, 80),
        message: '移出去了，这条不再算「已删除」。',
      }
    },
  })

  tool({
    name: 'qzone_echo_list',
    description: '从本地库里翻说说（不再打网络）。可按年份、关键词、类型筛，读全文。\n'
      + 'kind：thought=被判为思考 / dream=梦记 / review=介绍推荐（书评绘本）/ forward=转发 / media=纯图 / share=分享卡片 / short=极短 / misc=其他。',
    parameters: {
      year: { type: 'number', description: '只看某一年（例如 2019）' },
      keyword: { type: 'string', description: '正文包含这个词（支持多个词用空格分隔，任一命中）' },
      kind: { type: 'string', description: 'thought / dream / review / forward / media / share / short / misc / all（默认 all）' },
      thoughtOnly: { type: 'boolean', description: '只要「思考/感想」那一类' },
      dreamOnly: { type: 'boolean', description: '只要「梦记」那一类' },
      deletedOnly: { type: 'boolean', description: '只要「已经删掉的」那一栏（历史消息补回的摘要 + 验活查出真没了的全文）' },
      minScore: { type: 'number', description: '最低分数（0~100）' },
      limit: { type: 'number', description: '返回几条（默认 20，最多 100）' },
      offset: { type: 'number', description: '从第几条开始（默认 0）' },
      full: { type: 'boolean', description: '是否带完整正文与评论（默认 true）' },
      recoveredOnly: { type: 'boolean', description: '只看「从历史消息补回来的、疑似已删除」的说说（可省）' },
    },
    async execute(args) {
      const cfg = cfgOf()
      const th = Number(cfg.thoughtThreshold) || 45
      const all = loadAll()
      const year = args.year ? Number(args.year) : 0
      const kws = String(args.keyword || '').trim().split(/\s+/).filter(Boolean)
      const kind = String(args.kind || 'all')
      const minScore = Number(args.minScore) || 0
      let list = all
      if (year) list = list.filter((m) => m.ts && new Date(m.ts * 1000).getFullYear() === year)
      if (kwargsTrue(args.recoveredOnly)) list = list.filter((m) => m.recovered)
      // 「已经删掉的」这一栏：历史消息补回来的摘要 + 验活查出真没了的；被老大手动移出去的不算
      if (kwargsTrue(args.deletedOnly)) list = list.filter(isDeletedRow)
      if (kwargsTrue(args.thoughtOnly)) list = list.filter((m) => isThought(m, th))
      if (kwargsTrue(args.dreamOnly)) list = list.filter((m) => isDream(m))
      if (kind === 'dream') list = list.filter((m) => isDream(m))
      else if (kind === 'review') list = list.filter((m) => isReview(m))
      else if (kind && kind !== 'all') list = list.filter((m) => (m.kind || classify(m).kind) === kind)
      if (minScore) list = list.filter((m) => (m.score ?? classify(m).score) >= minScore)
      if (kws.length) {
        list = list.filter((m) => {
          const hay = `${m.content || ''} ${m.forwarded?.content || ''}`
          return kws.some((k) => hay.includes(k))
        })
      }
      list = [...list].sort((a, b) => (b.ts || 0) - (a.ts || 0))
      const total = list.length
      const offset = Math.max(0, Number(args.offset) || 0)
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20))
      const page = list.slice(offset, offset + limit).map((m) => shape(m, args.full !== false))
      return { ok: true, total, offset, limit, count: page.length, hasMore: offset + page.length < total, items: page }
    },
  })

  tool({
    name: 'qzone_echo_thoughts',
    description: '专门拿「个人思考 / 感想」候选：按分数从高到低。\n'
      + '⚠️ 这是**候选**不是结论 —— 分数来自规则词表，一定会误判；要下判断请读 content 原文。',
    parameters: {
      limit: { type: 'number', description: '返回几条（默认 15，最多 50）' },
      minScore: { type: 'number', description: '最低分（默认用设置里的分数线）' },
      year: { type: 'number', description: '只看某一年' },
    },
    async execute(args) {
      const cfg = cfgOf()
      const th = Number(args.minScore) || Number(cfg.thoughtThreshold) || 45
      const year = args.year ? Number(args.year) : 0
      let list = loadAll().filter((m) => isThought(m, th))
      if (year) list = list.filter((m) => m.ts && new Date(m.ts * 1000).getFullYear() === year)
      list.sort((a, b) => (b.score || 0) - (a.score || 0) || (b.ts || 0) - (a.ts || 0))
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 15))
      return {
        ok: true,
        threshold: th,
        total: list.length,
        count: Math.min(limit, list.length),
        items: list.slice(0, limit).map((m) => shape(m, true)),
        note: '按分数排序的结果只是线索；纯转发/纯图/打卡已被规则压低，但仍可能漏判。',
      }
    },
  })

  tool({
    name: 'qzone_echo_dreams',
    description: '专门拿「梦记」：说说里那些写梦的（梦见 / 梦到 / 做梦 / 梦里…），按时间倒序。\n'
      + '梦和「个人思考/感想」是**两栏**，不混在一起（老大定的）。\n'
      + '⚠️ 仍然是规则识别：`梦想`/`梦寐以求` 这类已被排除，但边界情况（引用歌词、转述别人的梦）仍可能误判，要读原文。',
    parameters: {
      limit: { type: 'number', description: '返回几条（默认 20，最多 100）' },
      year: { type: 'number', description: '只看某一年' },
      offset: { type: 'number', description: '从第几条开始（默认 0）' },
    },
    async execute(args) {
      const year = args.year ? Number(args.year) : 0
      let list = loadAll().filter((m) => isDream(m))
      if (year) list = list.filter((m) => m.ts && new Date(m.ts * 1000).getFullYear() === year)
      list.sort((a, b) => (b.ts || 0) - (a.ts || 0))
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20))
      const offset = Math.max(0, Number(args.offset) || 0)
      return {
        ok: true,
        total: list.length,
        offset,
        limit,
        count: Math.min(limit, list.length - offset),
        hasMore: offset + limit < list.length,
        items: list.slice(offset, offset + limit).map((m) => shape(m, true)),
      }
    },
  })

  tool({
    name: 'qzone_echo_fix',
    description: '人工纠正某一条的分类：说它「算思考」或「不算思考」；也能撤销。\n'
      + '规则永远会误判（比如只是分享绘本、只是发张图），这条纠正会写进 corrections.jsonl，'
      + '**永远压过自动打分**，之后重算/重同步都不会被翻回去。\n'
      + '撤销有两种：给 tid + undo=true 撤掉某一条；给 undoAll=true 把全部手改记录清空、回到自动判。\n'
      + 'tid 就是 qzone_echo_list 返回里的 tid（也可以用 id）。',
    parameters: {
      tid: { type: 'string', description: '要改哪一条（tid 或 id）' },
      thought: { type: 'boolean', description: 'true=算思考；false=不算思考（撤销时不用给）' },
      note: { type: 'string', description: '为什么改（可省，给自己留个记录）' },
      undo: { type: 'boolean', description: 'true=撤销这一条的人工纠正，回到按规则自动判' },
      undoAll: { type: 'boolean', description: 'true=清空全部人工纠正（误点一堆时用）' },
    },
    async execute(args) {
      // 全撤
      if (args.undoAll === true) {
        const r = clearOverrides()
        return r.ok === false ? r : { ...r, message: `清空了 ${r.cleared} 条手改记录，现在全按规则自动判。` }
      }
      const tid = String(args.tid || '').trim()
      if (!tid) return { ok: false, error: '要给 tid（撤销全部则给 undoAll=true）' }
      // 允许直接给 tid（不带 owner 前缀）—— 在库里找一下真正的那条
      const all = loadAll()
      let hit = all.find((m) => m.id === tid)
      if (!hit) hit = all.find((m) => String(m.tid) === tid)
      if (!hit) return { ok: false, error: `库里没有这条：${tid}` }
      // 补回来的「已删除」只有截断摘要，按设计不进思考/梦记（lib/classify.mjs 里对 recovered 一律 false），
      // 手改按钮会变成一个「点了没反应」的死按钮 —— 直接说清楚，别让老大白点。
      if (hit.recovered) {
        return {
          ok: false,
          tid: hit.tid,
          error: '这条是从历史消息补回来的「已删除」，正文只有截断摘要，按设计不进思考/梦记，不能手改成思考。',
          hint: '要改的话先找找有没有原文；没原文就只能当摘要看着。',
        }
      }
      if (args.undo === true) {
        const r = setOverride(hit.id || tid, null)
        return { ...r, tid: hit.tid, message: '撤销了，这条回到按规则自动判。' }
      }
      if (args.thought === undefined) return { ok: false, error: '要给 thought（true / false），或者给 undo=true' }
      const r = setOverride(hit.id || tid, args.thought === true, args.note)
      return { ...r, tid: hit.tid, content: String(hit.content || '').slice(0, 80) }
    },
  })

  tool({
    name: 'qzone_echo_export',
    description: '把库导成文件：Markdown（按年分组、可读）或 JSON（完整字段）。\n'
      + '**一栏一份**：thoughts=思考/感想（默认）、dreams=梦记、reviews=介绍/推荐（书评绘本这种）、'
      + 'deleted=已经删掉的（从历史消息补回来的摘要）、all=全部。',
    parameters: {
      format: { type: 'string', description: 'md（默认）/ json' },
      scope: { type: 'string', description: 'thoughts（默认）/ dreams / reviews / deleted / all' },
      name: { type: 'string', description: '文件名（可省，默认带日期）' },
    },
    async execute(args) {
      const scope = String(args.scope || 'thoughts')
      const list = scope === 'all' ? loadAll()
        : (scope === 'dreams' ? loadDreams()
          : (scope === 'reviews' ? loadReviews()
            : (scope === 'deleted' ? loadDeleted() : loadThoughts())))
      if (!list.length) return { ok: false, error: scope === 'dreams' ? '库里还没有梦记' : '库里还没有数据，先 qzone_echo_sync' }
      if (String(args.format || 'md').toLowerCase() === 'json') {
        const r = exportJson(list)
        return { ok: true, ...r, scope }
      }
      const r = exportMarkdown(list, {
        onlyThoughts: scope === 'thoughts',
        onlyDreams: scope === 'dreams',
        onlyReviews: scope === 'reviews',
        onlyDeleted: scope === 'deleted',
        name: args.name ? String(args.name) : '',
      })
      return { ok: true, ...r, scope }
    },
  })

  tool({
    name: 'qzone_echo_purge',
    description: '删掉某一个 QQ 号的**全部说说**（库里按 owner 分，只删这个号的，别的号不动）。\n'
      + '默认只预演（告诉你删几条），真要删必须传 apply: true —— 不可逆。\n'
      + '老数据没有 owner 标记的，用 uin="unknown" 一并清掉。',
    parameters: {
      uin: { type: 'string', description: '要删的 QQ 号（或 "unknown" 清老的无主数据）' },
      apply: { type: 'boolean', description: '真的删（不传只是预演）' },
    },
    async execute(args) {
      const r = purgeOwner(String(args.uin || ''), { apply: args.apply === true })
      return r
    },
  })

  tool({
    name: 'qzone_echo_image_job',
    description: '一键启动后台补齐全部已有缺图记录，按小批量缓慢运行，不需要模型反复调用。action=start启动/继续，pause保存进度暂停，status查看进度。遇限流冷却，异常记录留待复核，不会报成全部补齐。',
    parameters: { action: { type: 'string', enum: ['start', 'pause', 'status'], description: '默认status' } },
    async execute(args) {
      const r = args.action === 'start' || args.action === 'pause' ? configureImageJob(args.action) : imageJobStatus()
      if (r.ok && r.enabled && args.action === 'start') queueMicrotask(pictureTick)
      return r
    },
  })

  tool({
    name: 'qzone_echo_complete_images',
    description: '补齐原帖超过9张时遗漏的图片地址。tid 可指定一条，否则每批最多5条；不改正文，先备份，限流即停。补齐后网页可显示完整图片；下载到本地仍使用 qzone_echo_images。',
    parameters: { tid: { type: 'string', description: '只补某一条说说（可省）' }, max: { type: 'number', description: '最多补几条，默认5，上限5' } },
    async execute(args) {
      const { items, ...summary } = await completeMissingPictures({ tid: String(args.tid || ''), max: Number(args.max) || 5 })
      return summary
    },
  })

  tool({
    name: 'qzone_echo_images',
    description: '把说说里的配图**下到本地**（默认 `$DSH_HOME/qzone-echo/images/<年>/`）。\n'
      + '不烧 token：只写磁盘，不把图片喂给模型。同 URL 只存一份，已下过就跳过。\n'
      + 'scope 同 export：all（默认）/ thoughts / dreams / deleted；year 可只下某一年。',
    parameters: {
      scope: { type: 'string', description: 'all（默认）/ thoughts / dreams / deleted' },
      year: { type: 'number', description: '只下某一年的（可省）' },
      limit: { type: 'number', description: '最多处理多少条说说（0/省略 = 不限）' },
      force: { type: 'boolean', description: '已有文件也重下' },
      dryRun: { type: 'boolean', description: '只统计有多少张要下，真不下载' },
    },
    async execute(args) {
      if (args.dryRun) {
        const s = imageStats()
        return { ok: true, dryRun: true, ...s, message: `有 ${s.postsWithImages} 条带图，共 ${s.urls} 张，已落地 ${s.local}，待下 ${s.missing}` }
      }
      return downloadImages({
        scope: String(args.scope || 'all'),
        year: Number(args.year) || 0,
        limit: Number(args.limit) || 0,
        force: Boolean(args.force),
      })
    },
  })

  // ------------------------------------------------------------ HTTP（给设置页用）
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy() })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })

  const handle = async (req, res, url) => {
    const path = url.pathname.replace(/^\/api\/qzone-echo/, '') || '/'

    /* 🔒 口令闸（老大要「别被别人看见」）
     *   · 没设口令 → 完全放开（本机自用）；设了 → 除下面几个口子外全部 401。
     *   · `/ui` 必须放行（不然连登录框都下不下来），但 `/ui` 本身只有壳、没有数据。
     *   · 登录态是内存里的 token + HttpOnly Cookie，插件重载即全部失效。 */
    if (lockEnabled() && !isOpenPath(path, req.method)) {
      if (!checkToken(tokenOf(req))) {
        return sendJson(res, 401, { ok: false, error: '要先对口令', needLogin: true })
      }
    }

    /* 🕵️ 随机前缀闸：设了 webSecret 之后，`/ui` 这张 HTML 也要求先走过 `/qz/<前缀>`
     *  （那一步下发 qz_gate Cookie）。不然「藏网址」只是藏了个短链，直接打 /ui 照样进。
     *  ⚠️ 但有有效口令 token 的放行：已经证明知道口令的人不是「路过猜网址的人」，
     *     不然 token 还在、qz_gate 丢了（换浏览器/清过 cookie）就会卡在 404 —— 老大踩过。 */
    if ((path === '/ui' || path === '/page' || path === '/web') && req.method === 'GET') {
      const want = String(cfgOf().webSecret || '')
      const passed = gateOf(req) === want || (lockEnabled() && checkToken(tokenOf(req)))
      if (want && !passed) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex' })
        return res.end('404')
      }
    }

    // 宿主按 prefix 挂载后 req.url 可能已经是相对路径（`/status`），也可能还是原始全路径 ——
    // 两种都认：`/` 与 `/status` 等价（2026-10-22 实测：直接打 `/api/qzone-echo/status` 报 unknown）
    if (path === '/login' && req.method === 'POST') {
      const body = await readBody(req)
      if (!lockEnabled()) return sendJson(res, 200, { ok: true, enabled: false, note: '还没设口令' })
      if (loginBlocked()) {
        return sendJson(res, 429, { ok: false, error: '错太多次啦，等半分钟再试', needLogin: true })
      }
      // 慢一点，别让爆破太快
      await new Promise((r) => setTimeout(r, 260))
      if (!verifyPass(String(body.password || ''))) {
        loginFailed()
        return sendJson(res, 401, { ok: false, error: '口令不对', needLogin: true })
      }
      loginPassed()
      const t = issueToken()
      res.setHeader('set-cookie',
        `qz_token=${t}; Path=/; Max-Age=${7 * 24 * 3600}; HttpOnly; SameSite=Lax`)
      return sendJson(res, 200, { ok: true, enabled: true, ...(body.transport === 'header' ? { token: t } : {}) })
    }

    // 网页版退出登录（只丢网页口令的 token，不动 QQ Cookie）
    if (path === '/unlock' && req.method === 'POST') {
      dropToken(tokenOf(req))
      res.setHeader('set-cookie', 'qz_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax')
      return sendJson(res, 200, { ok: true })
    }

    // 口令本身的状态：只回「有没有、什么时候设的、提示」，**永不回明文或 hash**
    // webPath 照常给：这串是「藏起来」用的，不是秘密密钥；不给的话老大自己反而找不回网址。
    if (path === '/lock' && req.method === 'GET') {
      const port = req.socket?.localPort
      const webUrl = Number.isInteger(port) && port > 0 ? 'http://127.0.0.1:' + port + webEntryPath() : null
      return sendJson(res, 200, { ok: true, ...passMeta(), sessions: sessionCount(), webPath: webEntryPath(), webUrl, contentRepairVersion: 2, writingStatsVersion: 1, pictureCompletionVersion: 3, imagePartialSaveSupported: completeMissingPictures.toString().includes('partial = 0') })
    }

    if (path === '/lock' && req.method === 'POST') {
      const body = await readBody(req)
      // 已经设过：改口令/撤销都必须先验旧口令
      if (lockEnabled() && !verifyPass(String(body.oldPassword || ''))) {
        return sendJson(res, 403, { ok: false, error: '旧口令不对' })
      }
      const want = body.password === undefined ? '' : String(body.password)
      if (want === '') {
        if (!lockEnabled()) return sendJson(res, 200, { ok: true, ...passMeta() })
        clearPass()
        return sendJson(res, 200, { ok: true, enabled: false, note: '口令已取消' })
      }
      if (want.length < 4) return sendJson(res, 400, { ok: false, error: '口令至少 4 个字符' })
      setPass(want, body.hint || '')
      // 设完直接用新口令登一次，省得设完自己还被挡在外面
      const t = issueToken()
      res.setHeader('set-cookie',
        `qz_token=${t}; Path=/; Max-Age=${7 * 24 * 3600}; HttpOnly; SameSite=Lax`)
      return sendJson(res, 200, { ok: true, ...passMeta(), ...(body.transport === 'header' ? { token: t } : {}) })
    }

    if (path === '/randompass' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true, password: randomPass(10) })
    }

    /* 网页版网址的随机前缀：设/换/清。
     * 注意它**只是藏网址**，真正的门是口令 —— 别把「猜不到网址」当成安全边界。 */
    if (path === '/webpath' && req.method === 'POST') {
      const body = await readBody(req)
      if (body.clear) {
        saveConfig({ webSecret: '' })
        return sendJson(res, 200, { ok: true, webSecret: '', webPath: webEntryPath() })
      }
      const want = String(body.secret || '').trim()
      // 只留安全字符：这串会长在 URL 里，别让 / ? # 空格把路由搅乱
      const clean = want.replace(/[^A-Za-z0-9_-]/g, '')
      if (clean.length < 4) return sendJson(res, 400, { ok: false, error: '前缀至少 4 个字符（字母数字，- 和 _ 也行）' })
      if (clean.length > 40) return sendJson(res, 400, { ok: false, error: '前缀太长了，40 个字符以内' })
      saveConfig({ webSecret: clean })
      return sendJson(res, 200, { ok: true, webSecret: clean, webPath: webEntryPath() })
    }

    if (path === '/webpath/random' && req.method === 'POST') {
      const s = randomPass(10)
      saveConfig({ webSecret: s })
      return sendJson(res, 200, { ok: true, webSecret: s, webPath: webEntryPath() })
    }

    if ((path === '/' || path === '/status') && req.method === 'GET') {
      const cred = getCredential()
      const s = stats()
      const cfg = cfgOf()
      const gate = shouldAutoRun()
      return sendJson(res, 200, {
        ok: true,
        loggedIn: Boolean(cred?.cookie),
        uin: cred?.uin || null,
        cookieSavedAt: cred?.savedAt || null,
        library: s,
        years: Object.keys(s.years || {}).map(Number).filter(Boolean).sort((a, b) => b - a),
        config: cfg,
        home: homeDir(),
        exportDir: cfg.exportDir || paths().out,
        images: imageStats(),
        auto: { ...autoState(), nextRun: gate.run ? null : gate.nextAt || null, why: gate.why },
        // 补历史（已删说说）的断点：上次翻到哪、翻完没
        history: historyState(),
      })
    }

    if (path === '/config' && req.method === 'POST') {
      const body = await readBody(req)
      const next = saveConfig(body || {})
      // 分数线一改，立刻按新阈值重算，别让页面上的数字和库里打架
      let recomputed = null
      if (body && body.thoughtThreshold !== undefined) recomputed = recomputeThoughts(next.thoughtThreshold)
      return sendJson(res, 200, { ok: true, config: next, recomputed })
    }

    if (path === '/cookie' && req.method === 'POST') {
      const body = await readBody(req)
      const r = await saveCookie(String(body.cookie || ''), { verify: body.verify !== false })
      return sendJson(res, r.ok ? 200 : 400, r)
    }

    if (path === '/logout' && req.method === 'POST') {
      clearCredential()
      return sendJson(res, 200, { ok: true })
    }

    if (path === '/probe' && req.method === 'POST') {
      const sess = await openSession({})
      if (!sess.ok) return sendJson(res, 400, sess)
      const r = await syncOnce({ max: 20 })
      return sendJson(res, r.ok ? 200 : 400, r)
    }

    if (path === '/sync' && req.method === 'POST') {
      const body = await readBody(req)
      const r = await syncOnce({
        max: body.max ? Number(body.max) : undefined,
        export: body.export,
        month: body.month ? String(body.month) : '',
        incremental: body.incremental === true,
      })
      return sendJson(res, r.ok ? 200 : 400, r)
    }

    // 历史消息列表：补回**已删除**的说说（只有摘要）。默认不跑，得页面/工具明确要。
    if (path === '/history' && req.method === 'POST') {
      const body = await readBody(req)
      const r = await syncHistory({
        maxPages: body.maxPages ? Number(body.maxPages) : undefined,
        intervalMs: body.intervalMs != null ? Number(body.intervalMs) : undefined,
        resume: body.resume !== false,
      })
      return sendJson(res, r.ok ? 200 : 400, r)
    }

    // ⭐ 逐条验活：拿 tid 直接问腾讯「这条还在不在」（唯一能判「删没删」的硬办法）
    if (path === '/repair-longtext' && req.method === 'GET') return sendJson(res, 200, repairStatus())
    if (path === '/repair-longtext' && req.method === 'POST') {
      const body = await readBody(req)
      return sendJson(res, 200, configureRepair({ enabled: body.enabled !== false }))
    }

    if (path === '/verify' && req.method === 'POST') {
      const body = await readBody(req)
      const r = await syncVerify({
        max: body.max ? Number(body.max) : undefined,
        intervalMs: body.intervalMs != null ? Number(body.intervalMs) : undefined,
        redo: body.redo === true,
        since: body.since ? String(body.since) : '',
      })
      return sendJson(res, r.ok ? 200 : 400, r)
    }

    // 把「已删除」栏里某条移出去（误判出口）：移出 / 撤销 / 清空
    if (path === '/dismiss' && req.method === 'POST') {
      const body = await readBody(req)
      if (body.undoAll === true) {
        const r = clearDismissed()
        return sendJson(res, r.ok === false ? 400 : 200, { ...r, stats: stats() })
      }
      const key = String(body.tid || body.id || '').trim()
      if (!key) return sendJson(res, 400, { ok: false, error: '缺 tid' })
      const all = loadAll()
      const hit = all.find((m) => m.id === key) || all.find((m) => String(m.tid) === key)
      if (!hit) return sendJson(res, 404, { ok: false, error: `库里没有这条：${key}` })
      const undo = body.undo === true
      if (!undo && !isDeletedRow(hit)) {
        return sendJson(res, 400, { ok: false, error: '这条现在不在「已删除」栏里', tid: hit.tid })
      }
      const r = setDismissed(hit.id || key, undo ? null : true, String(body.note || ''))
      return sendJson(res, r.ok === false ? 400 : 200, { ...r, tid: hit.tid, stats: stats() })
    }

    // 手动移出过哪些（页面上能一条条看、一条条撤）
    if (path === '/dismissed' && req.method === 'GET') {
      const dis = loadDismissed()
      const all = loadAll()
      const byId = new Map(all.map((m) => [m.id || String(m.tid), m]))
      const items = [...dis.entries()].filter(([, v]) => v === true).map(([id]) => {
        const m = byId.get(id)
        return {
          id, tid: m?.tid || '', time: m?.time || '',
          content: String(m?.content || '').slice(0, 90),
          why: m?.recovered ? '历史消息补回' : (m?.gone ? '验活查出已删' : ''),
        }
      }).sort((a, b) => String(b.time).localeCompare(String(a.time)))
      return sendJson(res, 200, { ok: true, total: items.length, items })
    }

    // 自动同步的开关与间隔（页面上一个勾 + 一个数字）
    if (path === '/auto' && req.method === 'POST') {
      const body = await readBody(req)
      const patch = {}
      if (body.autoSync !== undefined) patch.autoSync = body.autoSync === true
      if (body.syncEveryHours !== undefined) patch.syncEveryHours = Math.max(1, Number(body.syncEveryHours) || 6)
      saveConfig(patch)
      const gate = shouldAutoRun()
      return sendJson(res, 200, { ok: true, auto: { ...autoState(), nextRun: gate.run ? null : gate.nextAt || null, why: gate.why } })
    }

    if (path === '/writing-stats' && req.method === 'GET') {
      const owner = String(getCredential()?.uin || '')
      return sendJson(res, 200, { ok: true, ...summarizeWriting(loadAll(), { owner, punctuation: url.searchParams.get('punctuation') === '1' }) })
    }

    if (path === '/items' && req.method === 'GET') {
      const q = url.searchParams
      const scope = q.get('scope') || 'thoughts'
      const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 30))
      const offset = Math.max(0, Number(q.get('offset')) || 0)
      let list = scope === 'all' ? loadAll()
        : (scope === 'dreams' ? loadDreams()
          : (scope === 'reviews' ? loadReviews()
            : (scope === 'deleted' ? loadDeleted() : loadThoughts())))
      const year = Number(q.get('year')) || 0
      if (year) list = list.filter(m => postPeriod(m).year === String(year))
      const month = Number(q.get('month')) || 0
      if (month >= 1 && month <= 12) list = list.filter(m => Number(postPeriod(m).month.slice(-2)) === month)
      // 关键词搜索：正文 + 评论 + 转发原文 + 转发作者名都算命中（老大要「搜索文字功能」）
      const kw = String(q.get('q') || '').trim()
      if (kw) {
        const terms = kw.toLowerCase().split(/\s+/).filter(Boolean)
        const hay = (m) => [
          m.content || '',
          m.forwarded?.content || '',
          m.forwarded?.name || '',   // ⚠️ 老大 2026-10-22 报「搜转发也搜不到」：以前没搜作者名
          m.share?.name || '',
          ...(m.comments || []).map((c) => `${c.name || ''} ${c.content || ''} ${(c.replies || []).map((r) => `${r.name || ''} ${r.content || ''}`).join(' ')}`),
        ].join(' ').toLowerCase()
        list = list.filter((m) => { const h = hay(m); return terms.every((t) => h.includes(t)) })
      }
      list = [...list].sort((a, b) => (b.ts || 0) - (a.ts || 0))
      return sendJson(res, 200, {
        ok: true, total: list.length, offset, limit,
        items: list.slice(offset, offset + limit).map((m) => shape(m, true)),
      })
    }

    if (path === '/export' && req.method === 'POST') {
      const body = await readBody(req)
      const scope = String(body.scope || 'thoughts')
      const list = scope === 'all' ? loadAll()
        : (scope === 'dreams' ? loadDreams()
          : (scope === 'reviews' ? loadReviews()
            : (scope === 'deleted' ? loadDeleted() : loadThoughts())))
      if (!list.length) return sendJson(res, 400, { ok: false, error: scope === 'dreams' ? '库里还没有梦记' : '库里还没有数据' })
      const r = String(body.format || 'md').toLowerCase() === 'json'
        ? exportJson(list)
        : exportMarkdown(list, {
          onlyThoughts: scope === 'thoughts',
          onlyDreams: scope === 'dreams',
          onlyReviews: scope === 'reviews',
          onlyDeleted: scope === 'deleted',
        })
      return sendJson(res, 200, { ok: true, ...r, scope })
    }

    if (path === '/fix' && req.method === 'POST') {
      const body = await readBody(req)
      const all = loadAll()
      // ① 全撤：把 corrections.jsonl 清空，全部回到「按规则自动判」
      if (body.undoAll === true || body.clear === true) {
        const n = clearOverrides()
        return sendJson(res, 200, { ok: true, cleared: n, stats: stats() })
      }
      const tid = String(body.tid || body.id || '').trim()
      if (!tid) return sendJson(res, 400, { ok: false, error: '缺 tid' })
      const hit = all.find((m) => m.id === tid) || all.find((m) => String(m.tid) === tid)
      if (!hit) return sendJson(res, 404, { ok: false, error: `库里没有这条：${tid}` })
      // 补回来的「已删除」只有截断摘要，按设计不进思考/梦记 —— 别让人点了个不生效的按钮
      if (hit.recovered) {
        return sendJson(res, 400, {
          ok: false,
          tid: hit.tid,
          error: '这条是补回来的「已删除」，正文只有摘要，按设计不进思考/梦记，改不了。',
        })
      }
      // ② 撤销单条：thought 传 null / 或 undo: true
      const undo = body.undo === true || body.thought === null
      const r = setOverride(hit.id || tid, undo ? null : body.thought === true, String(body.note || ''))
      return sendJson(res, r.ok ? 200 : 400, { ...r, tid: hit.tid })
    }

    // 手改过哪些条（页面上要能一条条看、一条条撤）
    if (path === '/corrections' && req.method === 'GET') {
      const ov = loadOverrides()
      const all = loadAll()
      const byId = new Map(all.map((m) => [m.id || String(m.tid), m]))
      const items = [...ov.entries()].map(([id, thought]) => {
        const m = byId.get(id)
        return {
          id, thought,
          tid: m?.tid || '', time: m?.time || '',
          content: String(m?.content || '').slice(0, 90),
          score: m?.score ?? null, kind: m?.kind || '',
        }
      }).sort((a, b) => String(b.time).localeCompare(String(a.time)))
      return sendJson(res, 200, { ok: true, total: items.length, items })
    }

    // 规则升级后手动重算一遍（不用重新同步）
    if (path === '/reclass' && req.method === 'POST') {
      const body = await readBody(req)
      const r = recomputeThoughts(body.threshold !== undefined ? Number(body.threshold) : null)
      logLine(`重算分类：思考 ${r.thoughts}，梦 ${r.dreams}，介绍 ${r.reviews}/${r.total}（阈值 ${r.threshold}）`)
      return sendJson(res, 200, { ok: true, ...r, stats: stats() })
    }

    /* 「打开网页版」：宿主窗口里 window.open 一律被拦（Electron 主窗口
     *   setWindowOpenHandler 返回 deny），所以设置页点了也只会静默失败。
     *   这里让宿主自己去 ShellExecute 一次，用系统默认浏览器打开。
     *   —— 只认本机 127.0.0.1 的自家入口，别的一律不受理。 */
    if (path === '/openweb' && req.method === 'POST') {
      const port = req.socket?.localPort
      const url = Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}${webEntryPath()}` : ''
      if (!url) return sendJson(res, 200, { ok: false, error: '拿不到端口' })
      const { spawn } = await import('node:child_process')
      const attempts = process.platform === 'win32'
        ? [['cmd.exe', ['/c', 'start', '', url]], ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]]
        : process.platform === 'darwin'
          ? [['open', [url]]]
          : [['xdg-open', [url]]]
      let lastErr = ''
      for (const [cmd, args] of attempts) {
        const err = await new Promise((resolve) => {
          let done = false
          let child
          try { child = spawn(cmd, args, { detached: true, stdio: 'ignore' }) } catch (e) { resolve(String(e?.message ?? e)); return }
          child.on('error', (e) => { if (!done) { done = true; resolve(String(e?.message ?? e)) } })
          setTimeout(() => { if (!done) { done = true; try { child.unref() } catch { /* 无所谓 */ } resolve('') } }, 500)
        })
        if (!err) return sendJson(res, 200, { ok: true, url, via: cmd })
        lastErr = err
      }
      return sendJson(res, 200, { ok: false, error: lastErr, url })
    }

    if (path === '/purge' && req.method === 'POST') {
      const body = await readBody(req)
      // 页面上同样要两道：先预览再确认（apply 为 true 才真删）
      const r = purgeOwner(String(body.uin || ''), { apply: body.apply === true })
      return sendJson(res, r.ok ? 200 : 400, r)
    }

    if (path === '/pictures/job' && req.method === 'GET') return sendJson(res, 200, imageJobStatus())
    if (path === '/pictures/job' && req.method === 'POST') {
      const body = await readBody(req)
      const r = configureImageJob(body.action === 'pause' ? 'pause' : 'start')
      if (r.ok && r.enabled) queueMicrotask(pictureTick)
      return sendJson(res, r.ok ? 200 : 400, r)
    }

    if (path === '/pictures/complete' && req.method === 'POST') {
      const body = await readBody(req)
      const r = await completeMissingPictures({ tid: String(body.tid || ''), max: Number(body.max) || 5 })
      return sendJson(res, r.ok ? 200 : 400, { ...r, items: (r.items || []).map(m => shape(m, true)) })
    }

    if (path === '/images' && req.method === 'POST') {
      const body = await readBody(req)
      const r = await downloadImages({
        scope: String(body.scope || 'all'),
        year: Number(body.year) || 0,
        limit: Number(body.limit) || 0,
        force: Boolean(body.force),
      })
      return sendJson(res, r.ok ? 200 : 400, r)
    }

    if (path === '/images/stats' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...imageStats() })
    }

    // 网页版：一个自包含 HTML（不走 JSON）。老大要「弄成个网页方便看」
    if ((path === '/ui' || path === '/page' || path === '/web') && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // 别让搜索引擎/爬虫索引这一页（本机地址本来就抓不到，但万一以后换了反代）
        'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet',
      })
      return res.end(page())
    }

    // 爬虫礼貌文件：明确整站不给抓
    if (path === '/robots.txt' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      return res.end('User-agent: *\nDisallow: /\n')
    }

    // 设置页里的「真图」：把本地落地文件读出来给 <img src>。
    // ⚠️ 只允许读家目录 images/ 底下的文件 —— 别开成任意文件读取。
    if (path === '/img' && req.method === 'GET') {
      const want = String(url.searchParams.get('p') || '')
      if (!want) return sendJson(res, 400, { ok: false, error: '缺 p' })
      let real, root
      try {
        real = realpathSync(want)
        root = realpathSync(paths().images)
      } catch { return sendJson(res, 404, { ok: false, error: '文件不在' }) }
      if (!real.toLowerCase().startsWith(root.toLowerCase())) {
        return sendJson(res, 403, { ok: false, error: '只给家目录里的图' })
      }
      let buf
      try { buf = readFileSync(real) } catch { return sendJson(res, 404, { ok: false, error: '读不到' }) }
      const ext = (real.match(/\.[a-z0-9]+$/i) || ['.bin'])[0].toLowerCase()
      const type = ({
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.heic': 'image/heic',
      })[ext] || 'application/octet-stream'
      res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=86400' })
      return res.end(buf)
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/qzone-echo',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) }
        catch (e) { sendJson(res, 500, { ok: false, error: e?.message ?? String(e) }) }
      },
    }), 'qzone-echo: /api/qzone-echo 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  /* 网页版短链：`/qzone`（或老大自定义的随机前缀）—— 不用记 `/api/qzone-echo/ui`。
   * 只做一次 302，不带任何数据；真正的内容还是上面那条前缀路由出的。 */
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/qzone',
      handler: async (req, res) => {
        try {
          const u = new URL(req.url, 'http://127.0.0.1')
          const rest = u.pathname.replace(/^\/qzone/, '')
          // 设了随机前缀之后，这个人人都会猜的入口就关掉（不然藏网址等于白藏）
          if (String(getConfig().webSecret || '')) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex' })
            return res.end('404')
          }
          if (rest === '/ui' || rest === '' || rest === '/') {
            res.writeHead(302, { location: '/api/qzone-echo/ui' })
            return res.end()
          }
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          return res.end('没有这个入口')
        } catch (e) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(String(e?.message ?? e))
        }
      },
    }), 'qzone-echo: /qzone 短链')
  } catch (e) { log(`短链没挂上（不影响 /api/qzone-echo/ui）：${e?.message ?? e}`) }

  /* 随机前缀短链：`/<webSecret>` —— 老大要「网址别人猜不到」。
   * 前缀改了旧的立刻 404，只有新的能用；`/qzone` 那条在不设前缀时才是主入口。 */
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/qz',
      handler: async (req, res) => {
        try {
          const u = new URL(req.url, 'http://127.0.0.1')
          const seg = u.pathname.split('/').filter(Boolean)[1] || ''
          const want = String(cfgOf().webSecret || '')
          if (want && seg === want) {
            // 记住这串前缀：/ui 本身也要求它，不然「藏网址」等于白藏
            res.setHeader('set-cookie',
              `qz_gate=${encodeURIComponent(want)}; Path=/; Max-Age=${30 * 24 * 3600}; HttpOnly; SameSite=Lax`)
            res.writeHead(302, { location: '/api/qzone-echo/ui' })
            return res.end()
          }
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex' })
          return res.end('404')
        } catch (e) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(String(e?.message ?? e))
        }
      },
    }), 'qzone-echo: 随机前缀短链')
  } catch (e) { log(`随机前缀没挂上（不影响 /api/qzone-echo/ui）：${e?.message ?? e}`) }

  // ------------------------------------------------------------ 自动增量（定时器）
  /* 🔴 定时器回调必须自己兜住所有异常：插件出错只该「这一轮没跑成」，绝不能杀宿主
   *    （2026-10-14 bili-scroll 那版 setInterval 回调抛 TypeError，直接把 DSH 带走过一次）。
   *    另外每一跳都重新读配置 —— 定时器活得比设置页久，别抓启动时那份旧值。 */
  let pictureBusy = false
  const pictureTick = () => {
    if (pictureBusy || autoBusy || repairBusy) return
    pictureBusy = true
    Promise.resolve().then(() => runImageJobTick())
      .catch(e => log('后台补图异常：' + (e?.message || e)))
      .finally(() => { pictureBusy = false })
  }
  let repairBusy = false
  const repairTick = () => {
    if (repairBusy) return
    repairBusy = true
    Promise.resolve().then(() => repairBatch())
      .then(r => { if (r.expandedThisBatch) log('长文补全：本轮 ' + r.expandedThisBatch + ' 条，剩余核对 ' + r.remaining + ' 条') })
      .catch(e => log('长文修复暂停：' + (e?.message || e)))
      .finally(() => { repairBusy = false })
  }
  let autoBusy = false
  const tick = () => {
    if (autoBusy || repairBusy || pictureBusy) return
    try {
      const gate = shouldAutoRun()
      if (!gate.run) { repairTick(); return }
      autoBusy = true
      Promise.resolve(autoSyncOnce())
        .then((r) => { if (r?.ok && !r.skipped) log(`自动同步：新增 ${r.added} 条，库 ${r.total}`) })
        .catch((e) => log(`自动同步异常（已兜住）：${e?.message ?? e}`))
        .finally(() => { autoBusy = false })
    } catch (e) {
      autoBusy = false
      log(`定时器这一跳出错（已兜住）：${e?.message ?? e}`)
    }
  }
  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'qzone-echo: 自动增量定时器')
    const pictureTimer = setInterval(pictureTick, 15_000)
    pictureTimer.unref?.()
    ctx.effect(() => () => clearInterval(pictureTimer), 'qzone-echo: 后台补图定时器')
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }
}

// ---------------------------------------------------------------- 小工具

function stripUndefined(o) {
  const out = {}
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined) out[k] = v
  return out
}

const kwargsTrue = (v) => v === true || v === 'true' || v === 1

/* 口令闸的「免检」白名单：
 *   `/ui` `/page` `/web` —— 登录框所在的那张 HTML，本身不含任何数据（数据全靠 XHR，要验）
 *   `/login` `/unlock`   —— 登录/登出，得在门口就能打到
 *   `GET /lock`          —— 只回「有没有设口令」，好让页面/设置页知道要不要弹登录框
 *   `/openweb`           —— 只让本机浏览器打开本机网页版那一个地址；**不返回任何数据**，
 *                           而且登录框那一步也要能点「去网页版输」，所以必须放行。
 *   `/img` **不放行**     —— 图是私人的，没登录不给看
 *   其余一律要 token —— 包括 /items /status /export，不然锁等于没锁（直接打接口就绕过了）
 */
function isOpenPath(p, method) {
  if (p === '/ui' || p === '/page' || p === '/web') return true
  if (p === '/login' || p === '/unlock') return true
  if (p === '/openweb' && method === 'POST') return true
  if (p === '/robots.txt') return true
  if (p === '/lock' && method === 'GET') return true
  return false
}

/** 从 Cookie 里抠随机前缀的通行证 */
function gateOf(req) {
  const raw = String(req?.headers?.cookie || '')
  const m = raw.match(/(?:^|;\s*)qz_gate=([^;]*)/)
  return m ? decodeURIComponent(m[1]) : ''
}

/** 网页版入口路径：设了随机前缀就用它，否则用默认短链 `/qzone` */
export function webEntryPath() {
  const s = String(getConfig().webSecret || '')
  return s ? `/qz/${s}` : '/qzone'
}

/** 输错次数太多的简易刹车：全局 8 次错就歇 30 秒（本机自用，不需要分布式限流） */
const loginGuard = { fails: 0, until: 0 }
function loginBlocked() { return Date.now() < loginGuard.until }
function loginFailed() {
  loginGuard.fails += 1
  if (loginGuard.fails >= 8) { loginGuard.until = Date.now() + 30_000; loginGuard.fails = 0 }
}
function loginPassed() { loginGuard.fails = 0; loginGuard.until = 0 }

/** 输出给模型看的形状：去掉原始字段，留有用的 */
function shape(m, full = true) {
  const base = {
    id: m.id || '',
    tid: m.tid,
    wordCount: countWriting(m.content),
    wordCountWithPunctuation: countWriting(m.content, true),
    time: m.time || (m.ts ? new Date(m.ts * 1000).toISOString() : ''),
    score: m.score,
    kind: m.kind,
    reasons: m.reasons,
    thought: Boolean(m.thought),
    dream: Boolean(m.dream),
    images: (m.images || []).length,
    comments: (m.comments || []).length,
    replies: (m.comments || []).reduce((n, c) => n + (c.replies?.length || 0), 0),
  }
  // 补回的历史消息：让调用方一眼看出「这条是摘要、而且可能已经删了」
  if (m.recovered) {
    base.recovered = true
    base.truncated = Boolean(m.truncated)
    if (m.possiblyDeleted) base.possiblyDeleted = true
    if (m.interactor) base.interactor = m.interactor
  }
  // 逐条验活查出来的「真没了」：正文是本地全文，比历史消息的摘要强得多
  if (m.gone) {
    base.gone = true
    if (m.goneAt) base.goneAt = m.goneAt
  }
  // 查过没查过（没查成的不会打时间戳，下次会重查）
  if (m.verifiedAt) { base.verifiedAt = m.verifiedAt; base.alive = m.alive === true }
  if (m.dismissed) base.dismissed = true
  // ⚠️ 腾讯对正文有 500 字硬上限，超长说说默认只给开头一截。
  //    这里如实告诉调用方「这条可能不全」，别让人以为原文就这么短。
  if (m.contentIncomplete === true) base.contentIncomplete = true
  if (!full) {
    base.content = String(m.content || '').slice(0, 120)
    return base
  }
  base.content = m.content || ''
  if (m.forwarded?.content || m.forwarded?.name) {
    base.forwardedFrom = { name: m.forwarded.name || '', content: m.forwarded.content || '' }
  }
  // 分享卡片（歌/视频/网页）：正文常为空，别让它看起来像「空说说」
  if (m.share) base.share = { music: Boolean(m.share.music), name: m.share.name || '', url: m.share.url || '' }
  // ⚠️ 以前这里砍到 9 张 —— 老大 2026-10-22 报「我转发这条图片明明很多为什么只能看见这几张」。
  //    后来改成 18（9 自己的 + 9 原帖的），还是错的：接口真给了多少就得给全，
  //    拿不到的由 picTotal 如实提示，界面这边不许再偷偷截一刀。
  if ((m.images || []).length) base.imageUrls = m.images
  // 原帖图片总数（接口只给前 9 张）：让界面能老实说明「共 N 张，这里 9 张」
  if (m.picTotal) base.picTotal = m.picTotal
  if ((m.localImages || []).some(Boolean)) base.localImages = m.localImages.slice()
  if ((m.comments || []).length) base.commentList = m.comments.slice(0, 10)
  return base
}

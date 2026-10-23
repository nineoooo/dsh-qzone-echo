/**
 * dsh-qzone-echo —— 浏览器半端（设置页里的一页「QQ说说收集」）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是**自注册脚本**（从官方包里挖到的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                       // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * ⭐ 进「设置」的方式：slots.inject('settings.section', …register({ name, id, label }))
 *   —— label 就是左侧导航里那一项。
 *
 * 这一页的顺序按「第一次用的人会怎么走」排：
 *   ① 现在什么状态（有没有 Cookie、库里多少条）
 *   ② 粘 Cookie（一次）→ 验证
 *   ③ 同步（拉回来）
 *   ④ 看「思考」候选 / 导出
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-qzone-echo',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/qzone-echo'

    /* HTTP 错误必须显式抛：不然 500 的 {ok:false} 会被当成「成功」，绿色提示把故障盖掉 */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      let why = ''
      try { const j = await res.json(); why = j?.error ? `：${j.error}` : '' } catch { /* 没 JSON 就算了 */ }
      // 401 = 设了口令且这台浏览器还没过门（宿主重启后 token 全失效，会走到这里）
      if (res.status === 401) { const e = new Error(`HTTP 401${why}`); e.needLogin = true; throw e }
      throw new Error(`HTTP ${res.status}${why}`)
    }
    // A password-verified session token survives the desktop Cookie bridge.
    const TOKEN_KEY = 'dsh-qzone-echo:session-token'
    let sessionToken = ''
    try { sessionToken = window.sessionStorage?.getItem(TOKEN_KEY) || '' } catch {}
    const rememberToken = (token) => {
      sessionToken = token || ''
      try {
        if (sessionToken) window.sessionStorage?.setItem(TOKEN_KEY, sessionToken)
        else window.sessionStorage?.removeItem(TOKEN_KEY)
      } catch {}
    }
    const requestHeaders = () => sessionToken ? { 'x-qzone-token': sessionToken } : {}
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin', headers: requestHeaders() }))
    const jpost = async (p, body) => {
      const loginRequest = p === '/login' || p === '/lock'
      const result = await asJson(await fetch(API + p, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...requestHeaders() },
        body: JSON.stringify({ ...(body || {}), ...(loginRequest ? { transport: 'header' } : {}) }),
      }))
      if (result?.token) { rememberToken(result.token); delete result.token }
      if (p === '/unlock' || (loginRequest && result?.enabled === false)) rememberToken('')
      return result
    }

    const CSS = `
[data-qz-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:680px;}
[data-qz-sec]{display:flex;flex-direction:column;gap:8px;}
[data-qz-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qz-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-qz-grow]{flex:1;min-width:0;}
[data-qz-label]{font-size:13px;}
[data-qz-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qz-code]{font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding:1px 5px;border-radius:4px;background:rgba(127,127,127,.16);color:var(--dsw-alias-label-primary,#e6e9ef);word-break:break-all;}
[data-qz-kv]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b6bcc4);}
[data-qz-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-qz-input]:focus{outline:none;border-color:#3b82f6;}
[data-qz-ta]{width:100%;box-sizing:border-box;min-height:76px;resize:vertical;padding:8px 9px;border-radius:8px;
  font-size:11px;line-height:16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;}
[data-qz-ta]:focus{outline:none;border-color:#3b82f6;}
[data-qz-num]{width:90px;text-align:center;}
[data-qz-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-qz-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-qz-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-qz-btn][disabled]{opacity:.5;cursor:default;}
[data-qz-btn][data-danger]{color:#f87171;border-color:rgba(248,113,113,.4);}
[data-qz-btn][data-on]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-qz-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qz-msg][data-warn]{color:#f59e0b;}
[data-qz-msg][data-bad]{color:#f87171;}
[data-qz-msg][data-good]{color:#34d399;}
[data-qz-list]{display:flex;flex-direction:column;gap:8px;max-height:460px;overflow:auto;}
[data-qz-card]{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:10px;
  padding:9px 11px;display:flex;flex-direction:column;gap:5px;}
[data-qz-meta]{font-size:10px;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary,#9aa0a6);display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
/* 卡片角上的小按钮：手动改「算 / 不算思考」—— 必须两步，点错一次不能就算数 */
[data-qz-mini]{margin-left:auto;font-size:10px;line-height:14px;padding:3px 9px;border-radius:7px;cursor:pointer;
  font-family:inherit;color:inherit;border:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.28));
  background:transparent;opacity:.7;}
[data-qz-mini]:hover{opacity:1;border-style:solid;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-qz-mini][data-arm]{opacity:1;color:#f59e0b;border-color:#f59e0b;border-style:solid;margin-left:0;
  background:rgba(245,158,11,.12);}
[data-qz-mini][disabled]{opacity:.4;cursor:default;}
/* 手改过的清单：一条条能看见、能撤 */
[data-qz-fixed]{display:flex;flex-direction:column;gap:4px;font-size:11px;line-height:16px;}
[data-qz-fixedrow]{display:flex;gap:8px;align-items:baseline;}
[data-qz-fixedrow] [data-qz-grow]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-qz-body]{font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;}
/* QQ 自带表情：[em]e188[/em] 还原成真图（2026-10-22 老大要求） */
[data-qz-em]{display:inline-block;width:18px;height:18px;vertical-align:-4px;margin:0 1px;
  object-fit:contain;image-rendering:auto;}
[data-qz-badge]{padding:1px 6px;border-radius:999px;background:rgba(59,130,246,.16);color:#60a5fa;font-size:10px;}
[data-qz-empty]{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6);padding:10px 0;}
[data-qz-imgs]{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;}
[data-qz-img]{width:88px;height:88px;object-fit:cover;border-radius:8px;cursor:zoom-in;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));background:rgba(128,128,128,.1);}
[data-qz-cmts]{display:flex;flex-direction:column;gap:4px;margin-top:4px;padding:7px 9px;border-radius:8px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.10));}
[data-qz-cmt]{font-size:11px;line-height:17px;white-space:pre-wrap;word-break:break-word;}
[data-qz-cmt-who]{color:#60a5fa;}
[data-qz-cmt-sub]{margin-top:2px;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));
  display:flex;flex-direction:column;gap:2px;opacity:.92;}
[data-qz-big]{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.82);display:flex;
  align-items:center;justify-content:center;cursor:zoom-out;padding:24px;}
[data-qz-big] img{max-width:94vw;max-height:88vh;object-fit:contain;border-radius:6px;}
`

    const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('zh-CN') : String(n ?? ''))

    /* QQ 的自带表情：[em]e188[/em] —— 接口原样返回这种码，直接显示就是一串乱字。
     * 腾讯 CDN 按编号拼就有图：https://qzonestyle.gtimg.cn/qzone/em/e188.gif
     * 这里把正文按表情码切段，普通文字照旧、表情码渲染成 <img>（2026-10-22）。 */
    const EM_RE = /\[em\]e(\d+)\[\/em\]/gi
    const emUrl = (code) => `https://qzonestyle.gtimg.cn/qzone/em/e${Number(code)}.gif`
    const renderRich = (text) => {
      const s = String(text || '')
      if (!EM_RE.test(s)) { EM_RE.lastIndex = 0; return s }
      EM_RE.lastIndex = 0
      const out = []
      let last = 0
      let m
      let i = 0
      while ((m = EM_RE.exec(s))) {
        if (m.index > last) out.push(s.slice(last, m.index))
        out.push(h('img', {
          key: `em${i++}`, 'data-qz-em': '', src: emUrl(m[1]), alt: '', loading: 'lazy', referrerPolicy: 'no-referrer',
        }))
        last = m.index + m[0].length
      }
      if (last < s.length) out.push(s.slice(last))
      return out
    }
    const fmtTime = (ts) => {
      if (!ts) return '时间未知'
      const d = new Date(ts * 1000)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [cookie, setCookie] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState(null)   // { tone, text }
      const [maxN, setMaxN] = React.useState(12000)
      const [threshold, setThreshold] = React.useState(45)
      const [autoImages, setAutoImages] = React.useState(false)
      const [imgStat, setImgStat] = React.useState(null)
      const [month, setMonth] = React.useState('')
      const [autoSync, setAutoSync] = React.useState(false)
      const [everyHours, setEveryHours] = React.useState(6)
      const [fixList, setFixList] = React.useState([])  // 手改过哪些条（能看见、能撤）
      // ⚠️ 这两个必须声明在**最上面的 state 区**：下面 190 行附近的 useEffect 依赖数组里就用了 needLogin，
      //    声明晚了会在渲染时踩 TDZ（Cannot access 'needLogin' before initialization），整页白屏。
      //    2026-10-22 老大报「点开 QQ说说收集 右边全空」，根因就是这个。
      const [needLogin, setNeedLogin] = React.useState(false)
      const [webOrigin, setWebOrigin] = React.useState(location.origin)
      const [webPath, setWebPath] = React.useState('/qzone')  // 网页版入口（可能是随机前缀）
      const [gate, setGate] = React.useState('')              // 在设置页里直接输的网页版口令

      const reload = React.useCallback(async () => {
        try {
          const s = await jget('/')
          setNeedLogin(false)
          setSt(s)
          setThreshold(Number(s?.config?.thoughtThreshold) || 45)
          setMaxN(Number(s?.config?.maxPerSync) || 12000)
          setAutoImages(Boolean(s?.config?.autoDownloadImages))
          setAutoSync(Boolean(s?.config?.autoSync))
          setEveryHours(Number(s?.config?.syncEveryHours) || 6)
          setImgStat(s?.images || null)
          // 手改清单：让老大随时看得见「我到底点歪了哪几条」，并且能一条条撤
          try {
            const f = await jget('/corrections')
            setFixList(Array.isArray(f?.items) ? f.items : [])
          } catch { setFixList([]) }
        } catch (e) {
          if (e?.needLogin) { setNeedLogin(true); setSt(null); return }
          setMsg({ tone: 'bad', text: `读状态失败：${e.message}` })
        }
      }, [])

      React.useEffect(() => { reload() }, [reload])

      /* 在网页版那边输完口令之后，设置页**不会自己知道**（它是另一个页面，只会拿着旧状态一直喊「没登录」）。
       * 老大实际踩过：明明输过了，这里还挂着「去输口令」。所以这里补两条自愈：
       *   1) 挂着这块提示时每 3 秒静默重试一次（成功就自己消失）
       *   2) 切回这个标签页就立刻重试一次（人刚在网页版输完，切回来正好赶上）
       * 都走 reload，失败也只在 needLogin 时保持提示，不会刷屏报错。 */
      React.useEffect(() => {
        if (!needLogin) return undefined
        const t = setInterval(() => { reload() }, 3000)
        const onFocus = () => { reload() }
        window.addEventListener('focus', onFocus)
        return () => { clearInterval(t); window.removeEventListener('focus', onFocus) }
      }, [needLogin, reload])

      const run = async (key, fn) => {
        setBusy(key)
        setMsg(null)
        try { await fn() } catch (e) { setMsg({ tone: 'bad', text: String(e?.message || e) }) } finally { setBusy('') }
      }

      const onSaveCookie = () => run('cookie', async () => {
        const text = cookie.trim()
        if (!text) { setMsg({ tone: 'warn', text: '先粘贴 Cookie 哦。' }); return }
        const r = await jpost('/cookie', { cookie: text, verify: true })
        if (r?.ok === false) { setMsg({ tone: 'bad', text: r.error || '保存失败' }); return }
        setCookie('')
        setMsg({ tone: r?.verified ? 'good' : 'warn', text: r?.verified ? `保存好了，验证通过（uin ${r.uin}）` : `已保存，但这次没验成：${r?.probe?.error || '可能风控/网络，稍后同步再看'}` })
        await reload()
      })

      const onLogout = () => run('logout', async () => {
        await jpost('/logout', {})
        setMsg({ tone: 'warn', text: '已清掉本机保存的 Cookie。' })
        await reload()
      })

      const onSync = (mode) => run('sync', async () => {
        const body = { max: Number(maxN) || 12000 }
        if (mode === 'month') {
          const m = String(month || '').trim()
          if (!/^\d{4}[-_/]?\d{1,2}$/.test(m)) { setMsg({ tone: 'warn', text: '月份写成 2021-06 这样哦。' }); return }
          body.month = m
        } else if (mode === 'inc') {
          body.incremental = true
        }
        const r = await jpost('/sync', body)
        if (r?.ok === false) { setMsg({ tone: 'bad', text: r.error || '同步失败' }); return }
        const tag = r.month ? `（只收 ${r.month}）` : (r.incremental ? '（增量）' : '')
        setMsg({
          tone: 'good',
          text: `同步好了${tag}：这次抓到 ${fmt(r.fetched)} 条（${r.pages} 页，跳过 ${fmt(r.skipped || 0)}），新增 ${fmt(r.added)}，更新 ${fmt(r.updated)}，`
            + `库里共 ${fmt(r.total)} 条，其中「思考」${fmt(r.thoughts)} 条、「梦记」${fmt(r.dreams)} 条`,
        })
        await reload()
      })

      const onSaveCfg = () => run('cfg', async () => {        const r = await jpost('/config', { thoughtThreshold: Number(threshold) || 45, maxPerSync: Number(maxN) || 500 })
        setMsg({ tone: 'good', text: `设置存好了（分数线 ${r?.config?.thoughtThreshold}，单次最多 ${fmt(r?.config?.maxPerSync)} 条）` })
        await reload()
      })

      // 人工纠正：这条到底算不算「思考」。写进 corrections.jsonl，永远压过自动打分。
      // ⚠️ 两步确认（2026-10-22 老大误点三条）：第一次点只是「上膛」，再点一下才落地；
      //    点别的、或过 5 秒会自动泄掉，误碰不会留下任何痕迹。
      // ⭐ 2026-10-22 夜：逐条纠正和浏览一起搬去网页版了（设置页只管设置），
      //    这里只留「手改过哪些条 → 撤销」的后悔药。

      // 撤销：某一条 或 全部（误点一堆时一键回到「全按规则自动判」）
      const onUndo = (id) => run('fix', async () => {
        const r = await jpost('/fix', { tid: id, undo: true })
        if (r?.ok === false) { setMsg({ tone: 'bad', text: r.error || '撤不了' }); return }
        setMsg({ tone: 'good', text: '撤销了，这条回到按规则自动判。' })
        await reload()
      })

      const onUndoAll = () => run('fix', async () => {
        const r = await jpost('/fix', { undoAll: true })
        if (r?.ok === false) { setMsg({ tone: 'bad', text: r.error || '撤不了' }); return }
        setMsg({ tone: 'good', text: `全部撤销了（${fmt(r.cleared)} 条手改记录清空），现在全按规则自动判。` })
        await reload()
      })

      // 长文补全（腾讯接口只给前 500 字，靠详情接口补回全文）
      const onRepairLongtext = () => run('longtext', async () => {
        const r = await jpost('/repair-longtext', { enabled: true })
        if (r?.ok === false) { setMsg({ tone: 'bad', text: r.error || '启动失败' }); return }
        setMsg({ tone: 'info', text: '已经开起来了，后台会自己慢慢补（每条隔 3.5 秒）。撞限流会自己歇一会儿，进度看「刷新进度」。' })
        await reload()
      })

      const configureLongtext = (enabled) => run('longtext', async () => {
        const r = await jpost('/repair-longtext', { enabled })
        if (r?.ok === false) { setMsg({ tone: 'bad', text: r.error || '没改成' }); return }
        setMsg({ tone: 'good', text: enabled ? '接着补。' : '先歇着，断点都留着，随时能接着跑。' })
        await reload()
      })

      const onImages = () => run('images', async () => {
        const r = await jpost('/images', { scope: 'all' })
        if (r?.ok === false) { setMsg({ tone: 'bad', text: r.error || '下图失败' }); return }
        setMsg({
          tone: r?.failed ? 'warn' : 'good',
          text: `配图：${fmt(r.posts)} 条说说、${fmt(r.urls)} 张链接，新下 ${fmt(r.downloaded)}，`
            + `已存在 ${fmt(r.skipped)}，失败 ${fmt(r.failed)}（存到 ${r.dir}）`,
        })
        await reload()
      })

      const onToggleAuto = () => run('cfg', async () => {
        const next = !autoImages
        const r = await jpost('/config', { autoDownloadImages: next })
        setAutoImages(Boolean(r?.config?.autoDownloadImages))
        setMsg({ tone: 'good', text: next ? '以后每次同步完顺手把新图也下下来。' : '同步时不再自动下图。' })
      })

      // 自动增量同步：开/关 + 间隔
      const onToggleAutoSync = () => run('cfg', async () => {
        const next = !autoSync
        const r = await jpost('/auto', { autoSync: next, syncEveryHours: Number(everyHours) || 6 })
        setAutoSync(Boolean(r?.auto?.enabled ?? next))
        setMsg({ tone: 'good', text: next ? `好，每 ${Number(everyHours) || 6} 小时悄悄补一次新发的（只看增量，不发不评不点赞）。` : '自动同步关掉了。' })
        await reload()
      })

      // 删某个号的数据：点一次 = 预演，点第二次才真删
      const [purgeUin, setPurgeUin] = React.useState('')
      const [purgeArmed, setPurgeArmed] = React.useState('')
      const onPurge = (uin, apply) => run('purge', async () => {
        const r = await jpost('/purge', { uin, apply })
        if (r?.ok === false) { setMsg({ tone: 'bad', text: r.error || '删除失败' }); return }
        if (!apply) {
          setPurgeArmed(uin)
          setMsg({ tone: 'warn', text: `${uin}：会删 ${fmt(r.matched)} 条，剩下 ${fmt(r.remaining)} 条。确认无误再点一次「确定删掉」。` })
          return
        }
        setPurgeArmed('')
        setMsg({ tone: 'good', text: `删掉了 ${fmt(r.matched)} 条（号 ${uin}），库里还剩 ${fmt(r.remaining)} 条。` })
        await reload()
      })

      // 网页版口令：设/改/撤。加锁后网页版除了登录框什么都看不到。
      const [lockOn, setLockOn] = React.useState(false)
      const [lockHint, setLockHint] = React.useState('')
      const [lockSetAt, setLockSetAt] = React.useState('')
      const [pwd1, setPwd1] = React.useState('')
      const [pwd0, setPwd0] = React.useState('')   // 旧口令（改/撤时要）
      // needLogin / webPath 在上面 state 区声明过了（那儿更早被 useEffect 引用，挪下来会 TDZ）
      const [seed, setSeed] = React.useState('')              // 自定义前缀输入
      const loadLock = React.useCallback(async () => {
        try {
          const r = await jget('/lock')
          setLockOn(Boolean(r?.enabled))
          setLockHint(r?.hint || '')
          setLockSetAt(r?.setAt || '')
          if (r?.webPath) setWebPath(r.webPath)
          if (r?.webUrl) setWebOrigin(new URL(r.webUrl).origin)
        } catch { /* 老版本没这个接口，忽略 */ }
      }, [])
      React.useEffect(() => { loadLock() }, [loadLock])

      const onRandomPass = () => run('lock', async () => {
        const r = await jpost('/randompass', {})
        if (r?.password) { setPwd1(r.password); setMsg({ tone: 'info', text: `给你生成了一个：${r.password}　（记下来再点「设口令」）` }) }
      })
      const onSetPass = () => run('lock', async () => {
        if (String(pwd1).length < 4) { setMsg({ tone: 'bad', text: '口令至少 4 个字符' }); return }
        const r = await jpost('/lock', { password: pwd1, oldPassword: pwd0 })
        if (r?.ok === false) { setMsg({ tone: 'bad', text: r.error || '没设成' }); return }
        setPwd1(''); setPwd0('')
        setMsg({ tone: 'good', text: '口令设好了。之后打开网页版要输它；已登录的浏览器会记住 7 天。' })
        await loadLock()
      })
      const onClearPass = () => run('lock', async () => {
        if (!pwd0) { setMsg({ tone: 'bad', text: '要撤口令得先填当前口令' }); return }
        const r = await jpost('/lock', { password: '', oldPassword: pwd0 })
        if (r?.ok === false) { setMsg({ tone: 'bad', text: r.error || '没撤成' }); return }
        setPwd0(''); setPwd1('')
        setMsg({ tone: 'warn', text: '口令撤了，网页版又变成谁打开都能看。' })
        await loadLock()
      })

      // 随机前缀：藏网址（真门还是口令）。设了之后 /qzone 会 404，只有新前缀能进。
      const onSetSeed = () => run('seed', async () => {
        const clean = String(seed).trim().replace(/[^A-Za-z0-9_-]/g, '')
        if (clean.length < 4) { setMsg({ tone: 'bad', text: '前缀至少 4 个字符（字母数字，- 和 _ 也行）' }); return }
        const r = await jpost('/webpath', { secret: clean })
        if (r?.ok === false) { setMsg({ tone: 'bad', text: r.error || '没设成' }); return }
        setSeed('')
        if (r?.webPath) setWebPath(r.webPath)
        setMsg({ tone: 'good', text: `网址换成 ${webOrigin}${r.webPath} 了。旧地址 /qzone 已经 404，记得存新网址。` })
        await loadLock()
      })
      const onRandomSeed = () => run('seed', async () => {
        const r = await jpost('/webpath/random', {})
        if (r?.webPath) setWebPath(r.webPath)
        setMsg({ tone: 'good', text: `给你随机了一个：${webOrigin}${r?.webPath || ''}　（这个网址得存好）` })
        await loadLock()
      })
      const onClearSeed = () => run('seed', async () => {
        const r = await jpost('/webpath', { clear: true })
        if (r?.webPath) setWebPath(r.webPath)
        setMsg({ tone: 'warn', text: '前缀撤了，网址回到 /qzone（谁猜都能打开，口令仍然挡着）。' })
        await loadLock()
      })
      const copyPath = () => {
        const full = `${webOrigin}${webPath}`
        try { navigator.clipboard.writeText(full) } catch { /* 老浏览器不给权限就算了 */ }
        setMsg({ tone: 'info', text: `已复制：${full}` })
      }

      /* 打开网页版（2026-10-23 二次修：宿主主窗口的 setWindowOpenHandler 一律 deny，
       *  window.open 永远拿不到窗口 —— 所以改成让宿主后端 spawn 系统浏览器去开。
       *  接口失败（或旧版本没这路由）再退化成「复制网址 + 提示」。 */
      const openWeb = () => {
        const u = `${webOrigin}${webPath}`
        jpost('/openweb', {}).then((r) => {
          if (r?.ok) { setMsg({ tone: 'good', text: `已经在浏览器里打开了：${r.url || u}` }); return }
          throw new Error(r?.error || '宿主不肯开')
        }).catch((e) => {
          try { navigator.clipboard.writeText(u) } catch { /* 没权限就直接显示 */ }
          setMsg({ tone: 'warn', text: `没能自动打开（${e?.message || '被拦了'}），网址已复制：${u}` })
        })
      }

      /* 直接在设置页里对口令（2026-10-22 老大反馈：点「打开网页版去输口令」跳不过去，
       * 输完回来还是进不去）。原因：设置页和网页版是**同一个接口**，口令 token 走 Cookie，
       * 但设置页在宿主窗口里，跳出去的网页版在别的 target —— 老大要么跳不过去、要么
       * Cookie 落不到同一个 origin。「跳过去输」这条路太脆了，干脆在这儿开个输入框。
       * POST /login 成功会 set-cookie qz_token（Path=/，同 origin 共享），设完直接 reload。 */
      const onUnlock = () => run('unlock', async () => {
        const pw = String(gate || '')
        if (!pw) { setMsg({ tone: 'warn', text: '先输口令' }); return }
        let r = null
        try {
          r = await jpost('/login', { password: pw })
        } catch (e) {
          // 口令错是 401，asJson 会包成「HTTP 401：口令不对」——对人只说人话
          if (e?.needLogin) { setMsg({ tone: 'bad', text: '口令不对，再试一次' }); return }
          throw e
        }
        if (r?.ok === false) { setMsg({ tone: 'bad', text: r.error || '口令不对' }); return }
        if (r?.enabled === false) {
          setMsg({ tone: 'warn', text: '这边看是「还没设口令」，直接刷新一下就好。' })
          setGate(''); setNeedLogin(false); await reload(); return
        }
        setGate('')
        setMsg({ tone: 'good', text: '进来了，当前窗口会保持登录。' })
        setNeedLogin(false)
        await reload()
      })

      const lib = st?.library || {}
      const years = lib.years || {}
      const dreamYears = lib.dreamYears || {}
      const yearText = Object.keys(years).filter((y) => y !== '0').sort((a, b) => b - a)
        .map((y) => `${y}(${years[y]})`).join(' · ') || '还没有数据'
      const dreamYearText = Object.keys(dreamYears).filter((y) => y !== '0').sort((a, b) => b - a)
        .map((y) => `${y}(${dreamYears[y]})`).join(' · ') || '还没有'

      // 设了口令、这台浏览器没过门：设置页自己也没数据可看，直接摆个「在网页版里输口令」的说明，
      // 别让老大对着一堆 HTTP 401 猜（宿主重启后 token 会全部失效，这是常态）。
      if (needLogin) {
        return h('div', { 'data-qz-page': '' },
          h('div', { 'data-qz-sec': '' },
            h('div', { 'data-qz-h': '' }, '🔒 要输一次口令'),
            h('div', { 'data-qz-note': '' },
              '网页版设了口令，设置页读的是同一个接口，所以这边也要过门。',
              h('br'),
              '口令输在这儿就行，不用跳网页版；过了之后浏览器记 7 天。'),
            h('div', { 'data-qz-row': '' },
              h('input', {
                'data-qz-input': '', 'data-qz-grow': '', type: 'password',
                placeholder: '网页版口令', autoFocus: true,
                value: gate, onChange: (e) => setGate(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') onUnlock() },
              }),
              h('button', { 'data-qz-btn': '', 'data-primary': '', disabled: busy === 'unlock', onClick: onUnlock },
                busy === 'unlock' ? '验证中…' : '进去')),
            h('div', { 'data-qz-row': '' },
              h('button', { 'data-qz-btn': '', onClick: openWeb }, '也可以去网页版输 ↗'),
              h('button', { 'data-qz-btn': '', onClick: () => { setNeedLogin(false); reload() } }, '我输过了，刷新'))),
          h('div', { 'data-qz-sec': '' },
            h('div', { 'data-qz-h': '' }, '忘了口令'),
            h('div', { 'data-qz-note': '' },
              `口令只存派生值，找不回来。去掉它的办法：删掉 ${st?.home || '$DSH_HOME/qzone-echo'}\\webpass.json 再重载插件。`)),
        )
      }

      return h('div', { 'data-qz-page': '' },

        // ① 状态
        h('div', { 'data-qz-sec': '' },
          h('div', { 'data-qz-h': '' }, '现在什么情况'),
          h('div', { 'data-qz-kv': '' },
            st?.loggedIn
              ? `已登录：uin ${st.uin}（Cookie 存于 ${st.cookieSavedAt ? new Date(st.cookieSavedAt).toLocaleString('zh-CN') : '之前'}）`
              : '还没粘 Cookie —— 下面第一步'),
          h('div', { 'data-qz-kv': '' },
            `库里 ${fmt(lib.total)} 条说说：「思考/感想」${fmt(lib.thoughts)} 条，「梦记」${fmt(lib.dreams)} 条，「介绍/推荐」${fmt(lib.reviews)} 条`,
            lib.first ? ` · 覆盖 ${lib.first} ~ ${lib.last}` : ''),
          h('div', { 'data-qz-note': '' }, `按年份：${yearText}`),
          h('div', { 'data-qz-note': '' }, `梦记按年份：${dreamYearText}`),
        ),

        // ② Cookie
        h('div', { 'data-qz-sec': '' },
          h('div', { 'data-qz-h': '' }, '① 粘一次 Cookie'),
          h('div', { 'data-qz-note': '' },
            '浏览器里登录 QQ 空间 → F12 打开 Network → 随便点一个请求 → 复制整段 Cookie（要含 uin 和 p_skey）。'
            + ' 这段等于账号钥匙，只存在本机，想去掉就点「清掉 Cookie」。'),
          h('textarea', {
            'data-qz-ta': '',
            placeholder: 'uin=o0123456789; p_skey=...; skey=...;',
            value: cookie,
            onChange: (e) => setCookie(e.target.value),
          }),
          h('div', { 'data-qz-row': '' },
            h('button', { 'data-qz-btn': '', 'data-primary': '', disabled: busy === 'cookie', onClick: onSaveCookie },
              busy === 'cookie' ? '验证中…' : '保存并验证'),
            st?.loggedIn
              ? h('button', { 'data-qz-btn': '', 'data-danger': '', disabled: busy === 'logout', onClick: onLogout }, '清掉 Cookie')
              : null),
        ),

        // ③ 同步
        h('div', { 'data-qz-sec': '' },
          h('div', { 'data-qz-h': '' }, '② 把说说收进来'),
          h('div', { 'data-qz-row': '' },
            h('span', { 'data-qz-label': '' }, '这次最多收'),
            h('input', {
              'data-qz-input': '', 'data-qz-num': '', type: 'number', min: 20, max: 5000,
              value: maxN, onChange: (e) => setMaxN(Number(e.target.value) || 0),
            }),
            h('span', { 'data-qz-label': '' }, '条'),
            h('button', { 'data-qz-btn': '', 'data-primary': '', disabled: busy === 'sync' || !st?.loggedIn, onClick: () => onSync('all') },
              busy === 'sync' ? '正在翻页…' : '全量同步'),
            h('button', { 'data-qz-btn': '', disabled: busy === 'sync' || !st?.loggedIn, onClick: () => onSync('inc') }, '只补新的')),
          // 按月分批：老号几千条的时候，一个月一个月收既不惊动风控，也好看进度
          h('div', { 'data-qz-row': '' },
            h('span', { 'data-qz-label': '' }, '或按月收'),
            h('input', {
              'data-qz-input': '', 'data-qz-num': '', type: 'text', placeholder: '2021-06',
              value: month, onChange: (e) => setMonth(e.target.value.trim()),
            }),
            h('button', { 'data-qz-btn': '', disabled: busy === 'sync' || !st?.loggedIn || !month, onClick: () => onSync('month') }, '只收这个月')),
          h('div', { 'data-qz-note': '' },
            '「只补新的」最快（翻到库里已有的就停）；「按月收」适合历史很多时一点点搬；'
            + '全量会把能翻到的都扫一遍（每页 20 条、页间留间隔，别让腾讯觉得是在被扒）。'),
        ),

        // ③ 长说说补全（腾讯只给前 500 字，插件自己补全文）
        h('div', { 'data-qz-sec': '' },
          h('div', { 'data-qz-h': '' }, '③ 长说说补全（腾讯只给前 500 字，靠它补回全文）'),
          h('div', { 'data-qz-kv': '' },
            '腾讯的接口对超长说说只返回开头一截。这里逐条去打详情接口核对，'
            + '只补长、不缩短；撞限流会自动歇着，断点存着，随时停随时接着跑。'),
          st?.longtext
            ? h('div', { 'data-qz-note': '' },
              `候选 ${fmt(st.longtext.candidates || 0)} 条 · 已核对 ${fmt(st.longtext.checked || 0)} 条 · 补全过 ${fmt(st.longtext.expanded || 0)} 篇`
              + (st.longtext.lastError ? ` · 上次被挡：${st.longtext.lastError}` : '')
              + (st.longtext.nextRetryAt ? `（${new Date(st.longtext.nextRetryAt).toLocaleString('zh-CN')} 后再试）` : ''))
            : null,
          h('div', { 'data-qz-row': '' },
            h('button', { 'data-qz-btn': '', 'data-primary': '', disabled: busy === 'longtext' || !st?.loggedIn, onClick: onRepairLongtext },
              busy === 'longtext' ? '正在处理…' : '开始 / 接着补全'),
            h('button', { 'data-qz-btn': '', disabled: busy === 'longtext' || !st?.loggedIn, onClick: () => configureLongtext(false) }, '暂停'),
            h('button', { 'data-qz-btn': '', onClick: reload }, '刷新进度')),
          h('div', { 'data-qz-note': '' },
            '⚠️ 慢：每条间隔 3.5 秒、每批 5 条，撞限流会自己冷却半小时再试。'
            + '修复前会自动备份 feed，正文只补长不缩短，随时可以停。'),
        ),

        // ④ 自动增量
        h('div', { 'data-qz-sec': '' },
          h('div', { 'data-qz-h': '' }, '④ 不断收新发的'),
          h('div', { 'data-qz-kv': '' },
            autoSync
              ? `开着：每 ${fmt(everyHours)} 小时补一次新发的`
                + (st?.auto?.lastRunAt ? ` · 上次 ${new Date(st.auto.lastRunAt).toLocaleString('zh-CN')}（新增 ${fmt(st.auto.lastAdded)} 条）` : ' · 还没跑过')
              : '关着 —— 打开后后台定时只看增量，不发说说、不评论、不点赞'),
          h('div', { 'data-qz-row': '' },
            h('span', { 'data-qz-label': '' }, '每'),
            h('input', {
              'data-qz-input': '', 'data-qz-num': '', type: 'number', min: 1, max: 168,
              value: everyHours, onChange: (e) => setEveryHours(Number(e.target.value) || 6),
            }),
            h('span', { 'data-qz-label': '' }, '小时'),
            h('button', { 'data-qz-btn': '', 'data-on': autoSync ? '' : null, disabled: busy === 'cfg' || !st?.loggedIn, onClick: onToggleAutoSync },
              autoSync ? '自动增量：开' : '自动增量：关')),
          st?.auto?.nextRun
            ? h('div', { 'data-qz-note': '' }, `下次大约 ${new Date(st.auto.nextRun).toLocaleString('zh-CN')}`)
            : null),

        // ⑤ 配图
        h('div', { 'data-qz-sec': '' },
          h('div', { 'data-qz-h': '' }, '⑤ 配图存到本地'),
          h('div', { 'data-qz-kv': '' },
            imgStat
              ? `带图的说说 ${fmt(imgStat.postsWithImages)} 条，共 ${fmt(imgStat.urls)} 张；已下 ${fmt(imgStat.local)} 张，还差 ${fmt(imgStat.missing)} 张，占 ${(Number(imgStat.size || 0) / 1048576).toFixed(1)} MB`
              : '（还没统计）'),
          h('div', { 'data-qz-note': '' },
            '只写磁盘、不喂模型 —— 所以不烧 token。同链接只存一份，下过的自动跳过；'
            + `存在 ${imgStat?.dir || '家目录/images'} 里，按年份分文件夹。`),
          h('div', { 'data-qz-row': '' },
            h('button', { 'data-qz-btn': '', disabled: busy === 'images' || !st?.loggedIn, onClick: onImages },
              busy === 'images' ? '正在下图…' : '把配图下载到本地'),
            h('button', { 'data-qz-btn': '', 'data-on': autoImages ? '' : null, disabled: busy === 'cfg', onClick: onToggleAuto },
              autoImages ? '同步后自动下图：开' : '同步后自动下图：关')),
        ),

        // ⑥ 分数线
        h('div', { 'data-qz-sec': '' },
          h('div', { 'data-qz-h': '' }, '⑥ 「思考/感想」的分数线'),
          h('div', { 'data-qz-row': '' },
            h('input', {
              'data-qz-input': '', 'data-qz-num': '', type: 'number', min: 0, max: 100,
              value: threshold, onChange: (e) => setThreshold(Number(e.target.value) || 0),
            }),
            h('button', { 'data-qz-btn': '', disabled: busy === 'cfg', onClick: onSaveCfg }, '存设置'),
            h('span', { 'data-qz-note': '' }, '越低筛出的越多（误判也越多）。规则只看词和结构，别把它当判决。')),
        ),

        // ⑦ 看与导出 —— 统一在网页版做
        // 老大 2026-10-22：「在dsh插件里也显示我的说说有点麻烦了…要不所有导出说说只在网页吧，
        // dsh设置就是起到一个设置的作用。」所以这里不再渲染列表，只留一个入口 + 一句导出去哪看。
        h('div', { 'data-qz-sec': '' },
          h('div', { 'data-qz-h': '' }, '⑦ 看 / 搜 / 导出（都在网页版）'),
          h('div', { 'data-qz-kv': '' },
            `现有：全部 ${fmt(lib.total)} 条 · 思考 ${fmt(lib.thoughts)} · 梦记 ${fmt(lib.dreams)}`
            + ` · 介绍/推荐 ${fmt(lib.reviews)}`),
          h('div', { 'data-qz-row': '' },
            h('button', { 'data-qz-btn': '', 'data-primary': '', onClick: openWeb }, '打开网页版 ↗')),
          h('div', { 'data-qz-note': '' },
            '浏览、搜索正文/评论/转发、逐条改判「算/不算思考」、导出 Markdown / JSON、看配图 —— 全在网页版里。'
            + '设置页只管设置，不再把说说正文铺在这里（也就不会再占设置页的内存）。'),
          h('div', { 'data-qz-note': '' },
            `导出文件会落在：${st?.exportDir || '家目录/out'}（网页版点「导出」也会告诉你路径，可以直接打开看）。`),
        ),

        // ⑧ 手改过的（能看见、能撤 —— 误点的时候这里就是后悔药）
        fixList.length
          ? h('div', { 'data-qz-sec': '' },
            h('div', { 'data-qz-h': '' }, `⑧ 你手动改过的（${fmt(fixList.length)} 条）`),
            h('div', { 'data-qz-note': '' },
              '这些不受分数线管、也不受规则升级影响。点错了就在这里撤掉，撤掉后回到「按规则自动判」。'),
            h('div', { 'data-qz-fixed': '' }, ...fixList.slice(0, 20).map((f) => h('div', { key: f.id, 'data-qz-fixedrow': '' },
              h('span', { 'data-qz-badge': '' }, f.thought ? '算思考' : '不算'),
              h('span', { 'data-qz-grow': '' }, `${String(f.time || '').slice(0, 16)} ${f.content || '(无正文)'}`),
              h('button', { 'data-qz-mini': '', disabled: busy === 'fix', onClick: () => onUndo(f.id) }, '撤销')))),
            h('div', { 'data-qz-row': '' },
              h('button', { 'data-qz-btn': '', 'data-danger': '', disabled: busy === 'fix', onClick: onUndoAll }, '全部撤销（回到自动判）')))
          : null,

        // ⑨ 清理某个号
        h('div', { 'data-qz-sec': '' },
          h('div', { 'data-qz-h': '' }, '⑨ 清掉某个号的数据'),
          h('div', { 'data-qz-note': '' },
            '想拿别的号试一把的时候用。「预览」只数条数，点「确定删掉」才真删 —— 不可逆，删之前先确认真的是那个号。'),
          (st?.library?.owners || []).length
            ? h('div', { 'data-qz-row': '' }, ...(st.library.owners || []).map((o) => h('span', { key: o.uin, 'data-qz-kv': '' },
              `${o.uin}：${fmt(o.count)} 条 `,
              h('button', { 'data-qz-btn': '', disabled: busy === 'purge', onClick: () => onPurge(o.uin, false) }, '预览'),
              purgeArmed === o.uin
                ? h('button', { 'data-qz-btn': '', 'data-danger': '', disabled: busy === 'purge', onClick: () => onPurge(o.uin, true) }, '确定删掉')
                : null,
              ' ')))
            : h('div', { 'data-qz-kv': '' }, '（库里还没有按号分的数据）'),
          h('div', { 'data-qz-row': '' },
            h('input', {
              'data-qz-input': '', placeholder: '或者手填 QQ 号 / unknown',
              value: purgeUin, onChange: (e) => setPurgeUin(e.target.value.trim()),
            }),
            h('button', { 'data-qz-btn': '', disabled: busy === 'purge' || !purgeUin, onClick: () => onPurge(purgeUin, false) }, '预览'),
            purgeArmed === purgeUin && purgeUin
              ? h('button', { 'data-qz-btn': '', 'data-danger': '', disabled: busy === 'purge', onClick: () => onPurge(purgeUin, true) }, '确定删掉')
              : null),
        ),

        // ⑩ 网页版口令
        h('div', { 'data-qz-sec': '' },
          h('div', { 'data-qz-h': '' }, '⑩ 网页版要不要口令'),
          h('div', { 'data-qz-note': '' },
            lockOn
              ? `现在【有口令】${lockSetAt ? `（${String(lockSetAt).slice(0, 10)} 设的）` : ''}。网页版除了登录框什么都看不到；改或撤都要先填当前口令。`
              : '现在【没口令】：谁打开这个地址都能看。填一个就能挡住。'),
          h('div', { 'data-qz-row': '' },
            h('input', {
              'data-qz-input': '', type: 'password', value: pwd0,
              placeholder: lockOn ? '当前口令（改/撤必填）' : '（第一次设不用填这个）',
              onChange: (e) => setPwd0(e.target.value),
            })),
          h('div', { 'data-qz-row': '' },
            h('input', {
              'data-qz-input': '', type: 'text', value: pwd1,
              placeholder: '新口令（至少 4 位）',
              onChange: (e) => setPwd1(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') onSetPass() },
            }),
            h('button', { 'data-qz-btn': '', disabled: busy === 'lock', onClick: onRandomPass }, '随机一个'),
            h('button', { 'data-qz-btn': '', 'data-primary': '', disabled: busy === 'lock', onClick: onSetPass },
              lockOn ? '改口令' : '设口令'),
            lockOn
              ? h('button', { 'data-qz-btn': '', 'data-danger': '', disabled: busy === 'lock', onClick: onClearPass }, '撤掉口令')
              : null),
          h('div', { 'data-qz-note': '' },
            '口令只存 scrypt 派生值（不存明文），登录态在内存里 —— 插件重载或宿主重启就要重新输。',
            lockOn && lockHint ? ` 提示：${lockHint}` : '')),

        // ⑪ 网址藏起来（随机前缀）
        h('div', { 'data-qz-sec': '' },
          h('div', { 'data-qz-h': '' }, '⑪ 网页版网址（要不要藏）'),
          h('div', { 'data-qz-note': '' },
            '现在入口：', h('code', { 'data-qz-code': '' }, `${webOrigin}${webPath}`),
            h('br'),
            webPath === '/qzone'
              ? '现在是默认短链 /qzone —— 好记，但谁都猜得到（有口令才进得去）。想要「别人连网址都猜不到」就设个随机前缀。'
              : '已经设了随机前缀：/qzone 现在会 404，只有这个网址能进。口令照样还要输。'),
          h('div', { 'data-qz-row': '' },
            h('input', {
              'data-qz-input': '', type: 'text', value: seed,
              placeholder: '自定义前缀（字母数字，≥4 位）',
              onChange: (e) => setSeed(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') onSetSeed() },
            }),
            h('button', { 'data-qz-btn': '', disabled: busy === 'seed', onClick: onRandomSeed }, '随机一个'),
            h('button', { 'data-qz-btn': '', 'data-primary': '', disabled: busy === 'seed', onClick: onSetSeed }, '用这个'),
            webPath !== '/qzone'
              ? h('button', { 'data-qz-btn': '', 'data-danger': '', disabled: busy === 'seed', onClick: onClearSeed }, '撤掉前缀')
              : null,
            h('button', { 'data-qz-btn': '', disabled: busy === 'seed', onClick: copyPath }, '复制网址')),
          h('div', { 'data-qz-note': '' },
            '⚠️ 藏网址不是加密：它只挡住「瞎猜」的人。真正把数据挡住的是上面的口令，两个建议都设。')),

        // 消息
        msg ? h('div', { 'data-qz-msg': '', ...(msg.tone && msg.tone !== 'info' ? { [`data-${msg.tone}`]: '' } : {}) }, msg.text) : null,

        // 它的地盘
        h('div', { 'data-qz-sec': '' },
          h('div', { 'data-qz-h': '' }, '它的地盘'),
          h('div', { 'data-qz-kv': '' },
            `家目录：${st?.home || '(未挂载)'}`,
            h('br'),
            `导出目录：${st?.exportDir || ''}`),
          h('div', { 'data-qz-note': '' }, '数据只在这台机器上。feed.jsonl 是全部，thoughts.jsonl 是思考那份，dreams.jsonl 是梦记那份。')),

      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-qzone-echo')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-qzone-echo: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'qzone-echo', order: 34, label: 'QQ说说收集' },
          () => h(Panel),
        ))
      },
    }
  },
})

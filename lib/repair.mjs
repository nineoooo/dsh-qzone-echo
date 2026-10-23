// Resumable repair of existing posts. Original bodies are backed up and never shortened.
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ensureHome, getCredential, loadAll, writeFeed, recomputeThoughts, getConfig, exportMarkdown, loadThoughts, loadDreams, logLine } from './store.mjs'
import { fetchFullPost, parseCookieText, extractUin, deAt } from './qzone.mjs'
import { postContent, hasMoreContent, looksTruncated, renderedLength } from './content.mjs'

const statePath = () => join(ensureHome().home, 'longtext-repair-state.json')
const keyOf = m => `${m.owner || ''}:${m.tid}`
function readState() { try { return JSON.parse(readFileSync(statePath(), 'utf8')) } catch { return { enabled: false, done: {} } } }
function saveState(s) {
  const tmp = statePath() + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2))
  renameSync(tmp, statePath())
}
function candidates(owner) {
  // ⚠️ 以前这里是「全库都算候选」（5640 条）。按 1.2 秒/条要几小时，而且必定撞限流 ——
  //    真正的活儿只有那几十条长文。所以先按 looksTruncated 挑出可疑的，再排优先级。
  return loadAll().filter(m => (!m.owner || String(m.owner) === owner) && m.tid && !String(m.tid).startsWith('h')
    && String(m.content || '').trim()
    && looksTruncated(m))
    .sort((a, b) => {
      const score = m => (m.contentIncomplete ? 100000 : 0) + (renderedLength(m.content) >= 490 ? 10000 : 0) + renderedLength(m.content)
      return score(b) - score(a)
    })
}
export function repairStatus() {
  const s = readState(), cred = getCredential()
  const owner = extractUin(parseCookieText(cred?.cookie || ''))
  const list = owner ? candidates(owner) : []
  const sameOwner = s.owner === owner
  const done = sameOwner ? s.done || {} : {}
  return { ok: true, enabled: !!s.enabled && sameOwner, total: list.length,
    checked: list.filter(m => done[keyOf(m)]).length,
    remaining: list.filter(m => !done[keyOf(m)]).length, expanded: sameOwner ? s.expanded || 0 : 0,
    nextRetryAt: sameOwner ? s.nextRetryAt || null : null, lastError: sameOwner ? s.lastError || null : null,
    backup: sameOwner ? s.backup || null : null }
}
export function configureRepair({ enabled = true, reset = false } = {}) {
  const cred = getCredential(), owner = extractUin(parseCookieText(cred?.cookie || ''))
  if (!owner) return { ok: false, needCookie: true, error: '尚未保存有效 QQ 登录信息' }
  let s = readState()
  if (reset || s.owner !== owner) s = { owner, done: {}, expanded: 0, startedAt: new Date().toISOString() }
  s.enabled = !!enabled
  if (enabled && !s.backup && existsSync(ensureHome().feed)) {
    s.backup = join(ensureHome().home, 'feed.before-longtext-repair-' + Date.now() + '.jsonl')
    copyFileSync(ensureHome().feed, s.backup)
  }
  // Resume respects any upstream cooldown already in force.
  saveState(s)
  return repairStatus()
}

export async function repairBatch({ max = 5, intervalMs = 2500, request = fetchFullPost, now = () => Date.now() } = {}) {
  let s = readState()
  if (!s.enabled) return { ...repairStatus(), skipped: true }
  if (Date.parse(s.nextRetryAt || '') > now()) return { ...repairStatus(), skipped: true, coolingDown: true }
  const cred = getCredential(), jar = parseCookieText(cred?.cookie || ''), owner = extractUin(jar)
  if (!owner || owner !== s.owner) return { ok: false, skipped: true, needCookie: true, error: 'QQ 登录信息已变更；请重新启动长文修复' }
  const p = ensureHome(), lock = join(p.home, 'longtext-repair.lock')
  let fd
  try {
    if (existsSync(lock) && now() - statSync(lock).mtimeMs > 30 * 60 * 1000) unlinkSync(lock)
    fd = openSync(lock, 'wx')
  } catch { return { ...repairStatus(), skipped: true, busy: true } }
  let attempted = 0, expanded = 0
  try {
    const queue = candidates(owner).filter(m => !s.done?.[keyOf(m)]).slice(0, Math.min(10, Math.max(1, Number(max) || 5)))
    for (const old of queue) {
      // Check the persistent switch between requests so pause takes effect promptly.
      if (!readState().enabled) { s.enabled = false; break }
      const r = await request(jar, owner, old.tid)
      attempted++
      const control = readState()
      if (control.owner !== owner) break
      if (!control.enabled) s.enabled = false
      if (!r.ok) {
        if (r.code === -10029) {
          s.done ||= {}; s.done[keyOf(old)] = { status: 'unavailable', at: new Date(now()).toISOString() }
          saveState(s)
          continue // Never infer deletion or clear content in a text-repair operation.
        }
        s.lastError = r.message || '详情请求失败，保留原文并稍后重试'
        s.nextRetryAt = new Date(now() + (r.throttled ? 30 : 10) * 60 * 1000).toISOString()
        saveState(s)
        break // One rejection is enough; do not hammer the rest of the queue.
      }
      const content = deAt(postContent(r.post))
      // ⚠️ 详情接口就算带 not_trunc_con=1，个别帖子仍会回 has_more_con=1（腾讯那边没放开）。
      //    以前这里 break —— 结果队列卡在同一条上，永远轮不到后面的。
      //    改成：这条记成「补不动」，跳过继续下一条，别让一条卡死全队。
      if (hasMoreContent(r.post) || (!content && old.content)) {
        s.done ||= {}
        s.done[keyOf(old)] = { status: 'still_incomplete', at: new Date(now()).toISOString() }
        s.lastError = '详情接口对这条仍只给截断正文（腾讯侧限制）'
        saveState(s)
        continue
      }
      // Reload the raw feed immediately before writing, preserving concurrent syncs
      // and runtime-only classification overlays.
      const lines = readFileSync(p.feed, 'utf8').split(/\r?\n/).filter(x => x.trim())
      const latest = lines.map(x => JSON.parse(x)) // Abort on damaged input instead of silently dropping rows.
      const current = latest.find(m => String(m.tid) === String(old.tid) && (!m.owner || String(m.owner) === owner))
      if (current) {
        if (!s.backup) {
          s.backup = join(p.home, 'feed.before-longtext-repair-' + now() + '.jsonl')
          copyFileSync(p.feed, s.backup)
          saveState(s)
        }
        // 长度按「渲染字数」比（表情码算 1 个），跟腾讯的 500 上限同一把尺子
        const longer = renderedLength(content) > renderedLength(current.content)
        const same = content === String(current.content || '')
        if (longer) {
          current.content = content
          current.rawContent = postContent(r.post)
          current.contentSource = 'detail'
          current.contentIncomplete = false
          expanded++; s.expanded = (s.expanded || 0) + 1
        } else if (same) {
          current.contentSource = 'detail'
          // 走到这里说明详情接口没报 has_more_con —— 它自己说「这就是全部」，
          // 那就以它为准。⚠️ 不能再用 looksTruncated 判：超过 500 字本身不是罪
          //   （转发长文能到两三千字），拿长度当判据会把刚补好的帖又标成「不全」。
          current.contentIncomplete = false
        }
        current.contentCheckedAt = new Date(now()).toISOString()
        writeFeed(latest)
      }
      s.done ||= {}
      s.done[keyOf(old)] = { status: current && current.contentIncomplete ? 'still_incomplete' : 'checked', at: new Date(now()).toISOString() }
      s.lastError = null; s.nextRetryAt = null
      saveState(s)
      if (intervalMs > 0) await new Promise(resolve => setTimeout(resolve, Math.max(1000, intervalMs)))
    }
    if (expanded) {
      recomputeThoughts()
      if (getConfig().autoExport) {
        try { exportMarkdown(loadThoughts(), { onlyThoughts: true }) } catch {}
        try { const dreams = loadDreams(); if (dreams.length) exportMarkdown(dreams, { onlyDreams: true }) } catch {}
      }
      logLine(`旧说说长文修复：本轮补全 ${expanded} 条，累计 ${s.expanded} 条`)
    }
    const status = repairStatus()
    if (!status.remaining) { s.enabled = false; saveState(s) }
    return { ...repairStatus(), attempted, expandedThisBatch: expanded }
  } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(lock) } catch {} }
}

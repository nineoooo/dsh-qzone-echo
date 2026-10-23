import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getCredential, loadAll, ensureHome, logLine } from './store.mjs'
import { parseCookieText, extractUin } from './qzone.mjs'
import { fetchPostPictures, uniquePictures } from './pictures.mjs'

const stateFile = () => join(ensureHome().home, 'image-repair-state.json')
function state() { try { return JSON.parse(readFileSync(stateFile(), 'utf8')) } catch { return {} } }
function saveState(s) {
  const tmp = stateFile() + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2)); renameSync(tmp, stateFile())
}
function candidates(owner, tid = '') {
  return loadAll().filter(m => (!m.owner || String(m.owner) === owner) && m.tid
    && (!tid || String(m.tid) === String(tid)) && Number(m.picTotal) > uniquePictures(m.images).length)
}
export function missingPictureStats() {
  const owner = extractUin(parseCookieText(getCredential()?.cookie || ''))
  if (!owner) return { posts: 0, missing: 0 }
  const list = candidates(owner)
  return { posts: list.length, missing: list.reduce((n, m) => n + Number(m.picTotal) - uniquePictures(m.images).length, 0) }
}

// Update picture fields only, rereading each file after the network request.
// No saved body, classification, override, or in-progress sync cursor is touched.
function commitPictures(owner, tid, urls, jobState) {
  const p = ensureHome(), changed = []
  for (const file of [p.feed, p.thoughts, p.dreams, p.reviews]) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const rows = text.split(/\r?\n/).filter(x => x.trim()).map(x => JSON.parse(x))
    let dirty = false
    for (const m of rows) {
      if (String(m.tid) !== String(tid) || m.owner && String(m.owner) !== owner) continue
      const before = uniquePictures(m.images)
      // An edited post or a forwarding mismatch must never lose existing images.
      if (!before.every(u => urls.includes(u)) || urls.length < before.length) continue
      const expected = Math.max(Number(m.picTotal) || 0, before.length)
      if (urls.length === before.length && urls.length < expected) continue
      const localByUrl = new Map((m.images || []).map((u, i) => [u, m.localImages?.[i] || null]))
      m.images = urls
      m.localImages = urls.map(u => localByUrl.get(u) || null)
      m.picTotal = Math.max(expected, urls.length)
      m.imageListComplete = urls.length >= m.picTotal
      m.imageListPartial = !m.imageListComplete
      m.imageListCheckedAt = new Date().toISOString()
      dirty = true
      if (file === p.feed) changed.push(m)
    }
    if (!dirty) continue
    if (!jobState.backup && file === p.feed) {
      jobState.backup = join(p.home, 'feed.before-image-repair-' + Date.now() + '.jsonl')
      copyFileSync(p.feed, jobState.backup); saveState(jobState)
    }
    if (readFileSync(file, 'utf8') !== text) throw Error('说说库正在更新，请稍后重试补图')
    const tmp = file + '.picture-repair-' + process.pid + '.tmp'
    writeFileSync(tmp, rows.map(m => JSON.stringify(m)).join('\n') + '\n')
    renameSync(tmp, file)
  }
  return changed
}

export async function completeMissingPictures({ tid = '', max = 5, intervalMs = 2000, request = fetchPostPictures } = {}) {
  const p = ensureHome(), cred = getCredential(), jar = parseCookieText(cred?.cookie || ''), owner = extractUin(jar)
  if (!owner || !(jar.p_skey || jar.skey || jar.sk)) return { ok: false, needCookie: true, error: '请先保存 QQ 空间登录信息' }
  const saved = state(), s = saved.owner === owner ? saved : { owner }
  if (Date.parse(s.nextRetryAt || '') > Date.now()) return { ok: false, error: s.lastError || '补图正在冷却，请稍后再试', nextRetryAt: s.nextRetryAt, ...missingPictureStats() }
  const lock = join(p.home, 'image-repair.lock')
  let fd
  try {
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8'))
      if (pid > 0 && pid !== process.pid) {
        try { process.kill(pid, 0) } catch (e) { if (e.code === 'ESRCH') unlinkSync(lock) }
      }
    }
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 30 * 60000) unlinkSync(lock)
    fd = openSync(lock, 'wx')
    writeFileSync(fd, String(process.pid))
  } catch { return { ok: false, busy: true, error: '已有补图请求正在处理，请稍等' } }
  let attempted = 0, repaired = 0, addedImages = 0, partial = 0, error = null, needCookie = false, failureType = null
  const items = []
  try {
    const list = candidates(owner, tid).slice(0, tid ? 1 : Math.min(5, Math.max(1, Number(max) || 5)))
    for (const m of list) {
      const r = await request(jar, owner, m.tid); attempted++
      if (!r.ok) {
        error = r.error || '补图请求失败'; s.lastError = error
        needCookie = !!r.needCookie
        failureType = r.code === -10029 ? 'unavailable' : needCookie ? 'login' : 'temporary'
        s.nextRetryAt = failureType === 'unavailable' || needCookie ? null : new Date(Date.now() + (r.throttled ? 30 : 5) * 60000).toISOString()
        saveState(s); break
      }
      const urls = uniquePictures(r.urls), old = uniquePictures(m.images)
      if (!old.every(u => urls.includes(u))) {
        error = '图片详情仍不完整或与本地图片不匹配，已保留现有图片'; failureType = 'incomplete'; break
      }
      const changed = commitPictures(owner, m.tid, urls, s)
      if (changed.length) {
        if (urls.length >= Number(m.picTotal)) repaired++; else partial++
        addedImages += urls.length - old.length; items.push(...changed)
      }
      if (urls.length < Number(m.picTotal)) {
        error = '原帖共 ' + m.picTotal + ' 张，本次取到 ' + urls.length + ' 张，已保存可用图片，剩余仍待补全'
        failureType = 'incomplete'; break
      }
      s.lastError = null; s.nextRetryAt = null; saveState(s)
      if (list.indexOf(m) < list.length - 1 && intervalMs > 0) await new Promise(r => setTimeout(r, Math.max(1000, intervalMs)))
    }
    if (addedImages) logLine(`图片列表补全：完整 ${repaired} 条、部分增加 ${partial} 条，新增 ${addedImages} 张图片地址`)
    return { ok: !error, attempted, repaired, partial, addedImages, error, needCookie, failureType, items, nextRetryAt: s.nextRetryAt || null, ...missingPictureStats() }
  } finally { closeSync(fd); try { unlinkSync(lock) } catch {} }
}

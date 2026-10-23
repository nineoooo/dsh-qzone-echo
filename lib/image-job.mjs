// One-click, resumable picture completion. One post per tick, never an unbounded loop.
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensureHome, getCredential, loadAll } from './store.mjs'
import { extractUin, parseCookieText } from './qzone.mjs'
import { uniquePictures, fetchPostPictures } from './pictures.mjs'
import { completeMissingPictures } from './image-repair.mjs'

const file = () => join(ensureHome().home, 'image-completion-job.json')
const ownerOf = () => extractUin(parseCookieText(getCredential()?.cookie || ''))
function read() { try { return JSON.parse(readFileSync(file(), 'utf8')) } catch { return {} } }
function save(s) {
  const tmp = file() + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2)); renameSync(tmp, file())
}
export function imageJobStatus() {
  const s = read(), owner = ownerOf()
  if (!s.id || s.owner !== owner) return { ok: true, enabled: false, status: 'idle', total: 0, processed: 0, repaired: 0, addedImages: 0, skipped: 0 }
  return { ok: true, enabled: !!s.enabled, status: s.status, total: s.queue.length,
    processed: s.index || 0, repaired: s.repaired || 0, addedImages: s.addedImages || 0, skipped: s.skipped?.length || 0,
    remaining: Math.max(0, s.queue.length - (s.index || 0)), remainingMissing: s.remainingMissing ?? null,
    lastError: s.lastError || null, nextRetryAt: s.nextRetryAt || null, updatedAt: s.updatedAt || s.startedAt }
}
export function configureImageJob(action = 'start') {
  const owner = ownerOf()
  if (!owner) return { ok: false, error: '请先保存QQ空间登录信息', needCookie: true }
  let s = read()
  if (action === 'pause') {
    if (s.owner === owner && s.id) { s.enabled = false; s.status = 'paused'; s.updatedAt = new Date().toISOString(); save(s) }
    return imageJobStatus()
  }
  if (action !== 'start') return imageJobStatus()
  if (s.owner === owner && s.id && s.index < s.queue.length) {
    s.enabled = true; s.status = Date.parse(s.nextRetryAt || '') > Date.now() ? 'cooldown' : 'running'
    s.updatedAt = new Date().toISOString(); save(s)
    return imageJobStatus()
  }
  const list = loadAll().filter(m => (!m.owner || String(m.owner) === owner) && m.tid
    && Number(m.picTotal) > uniquePictures(m.images).length)
  const queue = [...new Set(list.map(m => String(m.tid)))]
  s = { id: randomUUID(), owner, queue, index: 0, enabled: queue.length > 0,
    status: queue.length ? 'running' : 'completed', repaired: 0, addedImages: 0, skipped: [], startedAt: new Date().toISOString() }
  save(s)
  return imageJobStatus()
}

export async function runImageJobTick({ request = fetchPostPictures } = {}) {
  let s = read()
  if (!s.enabled || s.owner !== ownerOf() || Date.parse(s.nextRetryAt || '') > Date.now()) return { ...imageJobStatus(), skippedTick: true }
  const lock = join(ensureHome().home, 'image-completion-job.lock')
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
  } catch { return { ...imageJobStatus(), busy: true } }
  try {
    s = read()
    if (!s.enabled || s.owner !== ownerOf() || s.index >= s.queue.length) return imageJobStatus()
    let r
    try { r = await completeMissingPictures({ tid: s.queue[s.index], max: 1, intervalMs: 0, request }) }
    catch (e) { r = { ok: false, error: e?.message || '补图处理失败', failureType: 'temporary' } }
    const control = read()
    if (control.id !== s.id || control.owner !== ownerOf()) return imageJobStatus()
    s.enabled = control.enabled // A pause during an in-flight request must persist.
    s.status = s.enabled ? 'running' : 'paused'
    s.updatedAt = new Date().toISOString()
    if (r.busy) return { ...imageJobStatus(), busy: true }
    s.repaired += r.repaired || 0; s.addedImages += r.addedImages || 0
    if (r.ok) {
      s.index++; s.failures = 0; s.lastError = null; s.nextRetryAt = null
    } else if (r.needCookie) {
      s.enabled = false; s.status = 'needs_login'; s.lastError = r.error; s.nextRetryAt = null
    } else if (r.failureType === 'incomplete' || r.failureType === 'unavailable') {
      s.skipped.push({ tid: s.queue[s.index], reason: r.error }); s.index++; s.lastError = r.error
      s.nextRetryAt = null; s.failures = 0 // A bad post must not block the rest of the queue.
    } else {
      s.failures = (s.failures || 0) + 1; s.lastError = r.error
      s.nextRetryAt = r.nextRetryAt || new Date(Date.now() + 5 * 60000).toISOString()
      if (s.failures >= 5) { s.enabled = false; s.status = 'needs_attention' }
      else if (s.enabled) s.status = 'cooldown'
    }
    if (s.index >= s.queue.length) {
      s.enabled = false
      // Report any remaining gaps honestly, including posts collected after start.
      s.remainingMissing = loadAll().filter(m => (!m.owner || String(m.owner) === s.owner) && m.tid
        && Number(m.picTotal) > uniquePictures(m.images).length).length
      s.status = s.remainingMissing ? 'completed_with_gaps' : 'completed'
    }
    save(s)
    return imageJobStatus()
  } finally { closeSync(fd); try { unlinkSync(lock) } catch {} }
}

/**
 * 网页版访问口令
 * ----------------------------------------------------------------------------
 * 老大要的是「别被别人看见」，所以这里做的是**门锁**，不是加密：
 *   · 口令只存 scrypt 派生值（盐 + hash），`webpass.json` 单独一个文件、权限 600，
 *     而且**绝不**出现在 `/status` 的返回里（config.json 会回给前端，所以不能放那儿）。
 *   · 登录成功发一个随机 token，存在**内存**里 + HttpOnly Cookie。
 *     内存态的好处：插件重载 / 宿主重启 = 所有会话自动失效，不用维护黑名单。
 *   · 没设口令时完全放开（本机自用不折腾）；一旦设了，除 `/login` 与 `/ui` 外全部 401。
 *
 * 为什么不做得更狠（比如整库加密）：库里就是自己的说说，真要防的是「同一台机器上
 * 别人顺手点开这个网址」，不是防硬盘被拿走。加密整库会让同步、导出、判分全部要带密钥，
 * 复杂度远大于收益。真需要防硬盘，请用系统级磁盘加密。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, writeFileSync, readFileSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homeDir, ensureHome } from './store.mjs'

const passFile = () => join(homeDir(), 'webpass.json')
const sessFile = () => join(homeDir(), 'websessions.json')

/** token 有效期：7 天。 */
const TTL = 7 * 24 * 3600 * 1000
/** sha256(token) -> 过期时间戳。存哈希不存原 token：文件泄露也换不回能用的 Cookie。 */
const sessions = new Map()

/** 落盘：插件热重载不该把老大踢下线（内存态每次重载都清空，这就是「明明输过还让我再输」的一半原因）。 */
function saveSessions() {
  try {
    const now = Date.now()
    const map = {}
    for (const [k, v] of sessions) if (v > now) map[k] = v
    ensureHome()
    writeFileSync(sessFile(), JSON.stringify({ v: 1, map }, null, 2), 'utf8')
    try { chmodSync(sessFile(), 0o600) } catch { /* Windows 上不管 */ }
  } catch { /* 写不进去就是退化成内存态，不影响功能 */ }
}

function loadSessions() {
  try {
    const j = JSON.parse(readFileSync(sessFile(), 'utf8'))
    if (j && j.v === 1 && j.map) {
      const now = Date.now()
      for (const [k, v] of Object.entries(j.map)) if (Number(v) > now) sessions.set(k, Number(v))
    }
  } catch { /* 没有文件 / 坏了：当没登录 */ }
}
loadSessions()

const keyOf = (t) => createHash('sha256').update(String(t || '')).digest('hex')

const hash = (pwd, salt) => scryptSync(String(pwd), salt, 64).toString('hex')

/** 有没有设口令 */
export function lockEnabled() {
  try { return existsSync(passFile()) } catch { return false }
}

export function passMeta() {
  try {
    const j = JSON.parse(readFileSync(passFile(), 'utf8'))
    return { enabled: true, setAt: j.setAt || null, hint: j.hint || '' }
  } catch { return { enabled: false, setAt: null, hint: '' } }
}

/**
 * 设口令。`pwd` 为空 = 取消口令（回到完全放开）。
 * 已经设过口令时，调用方必须先验过旧口令（在 index.js 里做）。
 */
export function setPass(pwd, hint = '') {
  const text = String(pwd || '')
  ensureHome()
  if (!text) return clearPass()
  if (text.length < 4) throw new Error('口令至少 4 个字符')
  const salt = randomBytes(16).toString('hex')
  const body = {
    v: 1,
    salt,
    hash: hash(text, salt),
    setAt: new Date().toISOString(),
    hint: String(hint || '').slice(0, 60),
  }
  const f = passFile()
  writeFileSync(f, JSON.stringify(body, null, 2), 'utf8')
  try { chmodSync(f, 0o600) } catch { /* Windows 上不管，反正只在本机 */ }
  // 注意：**不踢旧会话**。改口令前已经验过旧口令，那个人就是老大自己；
  // 一改口令就把自己踢下线，正是「明明输过还得再输」的来源。
  return { ok: true, enabled: true, setAt: body.setAt }
}

export function clearPass() {
  try { if (existsSync(passFile())) unlinkSync(passFile()) } catch { /* 忽略 */ }
  dropAll()
  return { ok: true, enabled: false }
}

/** 验口令；没设口令时永远 false（调用方先看 lockEnabled） */
export function verifyPass(pwd) {
  let j
  try { j = JSON.parse(readFileSync(passFile(), 'utf8')) } catch { return false }
  const got = Buffer.from(hash(String(pwd || ''), j.salt), 'hex')
  const want = Buffer.from(j.hash, 'hex')
  if (got.length !== want.length) return false
  return timingSafeEqual(got, want)
}

/** 发一个 token 并记住 */
export function issueToken() {
  const t = randomBytes(24).toString('hex')
  sessions.set(keyOf(t), Date.now() + TTL)
  saveSessions()
  return t
}

export function checkToken(t) {
  if (!t) return false
  const k = keyOf(t)
  const exp = sessions.get(k)
  if (!exp) return false
  if (exp < Date.now()) { sessions.delete(k); saveSessions(); return false }
  return true
}

export function dropToken(t) {
  if (t) { sessions.delete(keyOf(t)); saveSessions() }
}

export function dropAll() { sessions.clear(); saveSessions() }

/** 当前还有几个登录着的会话（不含已过期的） */
export function sessionCount() {
  const now = Date.now()
  let dirty = false
  for (const [t, exp] of sessions) if (exp < now) { sessions.delete(t); dirty = true }
  if (dirty) saveSessions()
  return sessions.size
}

/** 从 Cookie 头里抠 token */
export function tokenOf(req) {
  // The desktop bridge preserves custom headers but strips plugin Cookies.
  const explicit = req?.headers?.['x-qzone-token']
  if (typeof explicit === 'string' && explicit) return explicit
  const raw = String(req?.headers?.cookie || '')
  const m = raw.match(/(?:^|;\s*)qz_token=([^;]+)/)
  return m ? decodeURIComponent(m[1]) : ''
}

/** 生成一个好念的随机口令（去掉容易看错的 0/o/1/l/i） */
export function randomPass(len = 10) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i += 1) out += abc[bytes[i] % abc.length]
  return out
}

/** 给日志/页面用的指纹，永不回明文 */
export const passFingerprint = () => {
  try { return createHash('sha256').update(readFileSync(passFile())).digest('hex').slice(0, 8) } catch { return '' }
}

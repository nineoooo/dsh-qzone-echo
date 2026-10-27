/**
 * 同步互斥 + 断点自测（不联网）。
 * ---------------------------------------------------------------------------
 * 为什么要有这个：
 *   同步入库是「全量读 → 去重 → 整体重写」的写法（tmp + rename）。四条入口
 *   （工具 / POST /probe / POST /sync / 定时器）谁都能同时冲进来，两个同步并跑
 *   就是后写覆盖前写 —— 一整批数据静悄悄没了。长文补全、补图早就加了锁，
 *   偏偏最该锁的同步没有（2026-10-27 查出）。
 *
 * 验什么：
 *   ① 已经有 sync.lock 时，syncOnce 必须立刻回 busy，而且**绝不发网络请求**
 *   ② 陈旧的锁（30 分钟没动）要能被自动清掉，不能永久卡死
 *   ③ 断点：syncState() 能读到、别人号的断点不认、sync-state.json 坏了不炸
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'qzecho-lock-'))
process.env.QZONE_ECHO_HOME = HOME

const { ensureHome, saveCredential, clearCredential } = await import('./lib/store.mjs')
const { syncOnce, syncState } = await import('./lib/sync.mjs')

ensureHome()
// 造一份「看着像真的」的凭证：真打网络的话下面会走 warmUp 然后失败，
// 但我们的断言是「压根没打」，所以只要锁生效就不会有网络行为。
saveCredential('uin=o0123456789; p_skey=abc123; skey=def456;', '123456789')

const lock = join(HOME, 'sync.lock')

/* ---------- ① 有锁时立刻 busy，且不打网络 ---------- */
writeFileSync(lock, '99999')
const t0 = Date.now()
const r = await syncOnce({ max: 5 })
const ms = Date.now() - t0
assert.equal(r.ok, false, '已经有同步在跑时不能返回成功')
assert.equal(r.busy, true, '应该明确回 busy，而不是含糊的 error')
assert.match(String(r.error), /已有一次同步在跑/, '错误文案要说清是「同时跑会覆盖数据」')
assert.ok(ms < 2000, `有锁时应该立刻返回，实际花了 ${ms}ms（说明它真去翻页了）`)
assert.equal(existsSync(lock), true, '不是自己的锁，不能替别人删')

/* ---------- ② 陈旧锁（30 分钟没动）应被清掉后正常进入流程 ---------- */
// 这里故意把凭证抹掉：陈旧锁被清掉之后应该走到「没有 Cookie」就停，
// 全程不发任何网络请求（自测不许打腾讯接口）。
clearCredential()
const old = new Date(Date.now() - 31 * 60 * 1000)
utimesSync(lock, old, old)
const r2 = await syncOnce({ max: 5 })
assert.notEqual(r2.busy, true, '陈旧锁应该被自动清掉，不能永久卡死同步')
assert.equal(r2.needCookie, true, '锁过了之后应该正常往下走（这里走到「没 Cookie」就停）')
assert.equal(existsSync(lock), false, '跑完（哪怕失败）也要把自己的锁收掉')

/* ---------- ③ 断点：能读、串号不认、坏文件不炸 ---------- */
// 上一段把凭证清了，这里放回来 —— syncState() 靠凭证里的 uin 认「这是不是我的断点」
saveCredential('uin=o0123456789; p_skey=abc123; skey=def456;', '123456789')
writeFileSync(join(HOME, 'sync-state.json'), JSON.stringify({ owner: '123456789', nextPos: 1240, stoppedAt: 'x', reason: '限流' }))
const st = syncState()
assert.equal(st.hasBreakpoint, true, '同号的断点应该认')
assert.equal(st.nextPos, 1240, '断点位置要能读出来')
assert.equal(st.reason, '限流', '中断原因也要能读出来')

writeFileSync(join(HOME, 'sync-state.json'), JSON.stringify({ owner: '9999999999', nextPos: 80 }))
assert.equal(syncState().hasBreakpoint, false, '别的号的断点绝不能拿来当自己的（会跳到别人的位置）')

writeFileSync(join(HOME, 'sync-state.json'), '{ 这不是 json')
assert.doesNotThrow(() => syncState(), '状态文件坏了不能让整个设置页炸')
assert.equal(syncState().hasBreakpoint, false, '坏文件按「没有断点」处理')

writeFileSync(join(HOME, 'sync-state.json'), JSON.stringify({ owner: '123456789', nextPos: 0 }))
assert.equal(syncState().hasBreakpoint, false, 'nextPos=0 等于没断点，别显示「从第 0 条续跑」')

console.log('✅ 同步互斥与断点 14 条断言全部通过')
